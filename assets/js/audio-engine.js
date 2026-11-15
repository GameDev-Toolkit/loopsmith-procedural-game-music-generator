(() => {
  'use strict';

  const app = window.LoopSmith;
  const audio = app.audioState;
  const { harmonySteps, steps, stepsPerBar, melodyBaseMidi, bassBaseMidi } = app.constants;
  const { scales, voiceStyles } = app.catalog;
  const SCHEDULER = app.tuning.scheduler;
  const TUNING = app.tuning.audio;
  const MIN_GAIN = TUNING.minGain;

  // Impulse responses are pure functions of the sample rate, so each one is
  // generated once and copied into every new context (live or offline).
  const impulseCache = new Map();
  // One short white-noise buffer per context serves every hi-hat hit.
  const noiseBuffers = new WeakMap();

  // Steps are queued with their scheduled time and consumed by an animation
  // frame. Driving the playhead from the audio clock keeps the visuals in step
  // without one timer per note.
  const visualQueue = [];
  let visualFrame = 0;
  let stopTimer = 0;
  let playbackToken = 0;
  let muted = false;
  let lifecycleBound = false;

  const filterFrequency = (brightness) => 900 + brightness * 55;
  const reverbSend = (space) => space / 100 * TUNING.reverbSendScale;
  const monitorLevel = (settings, isMuted) => (isMuted ? 0 : settings.volume / 100);

  function impulseChannels(sampleRate) {
    let channels = impulseCache.get(sampleRate);
    if (channels) return channels;

    const length = Math.floor(sampleRate * TUNING.impulseSeconds);
    const random = app.math.rngFrom(TUNING.impulseSeed);
    channels = [new Float32Array(length), new Float32Array(length)];

    for (const data of channels) {
      for (let index = 0; index < length; index += 1) {
        data[index] = (random() * 2 - 1) * Math.pow(1 - index / length, TUNING.impulseDecay);
      }
    }

    impulseCache.set(sampleRate, channels);
    return channels;
  }

  function makeImpulse(context) {
    const channels = impulseChannels(context.sampleRate);
    const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
    channels.forEach((data, channel) => buffer.copyToChannel(data, channel));
    return buffer;
  }

  function noiseBuffer(context) {
    let buffer = noiseBuffers.get(context);
    if (buffer) return buffer;

    const length = Math.floor(context.sampleRate * TUNING.hatSeconds);
    const random = app.math.rngFrom('loopsmith-hat-v1');
    buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = random() * 2 - 1;

    noiseBuffers.set(context, buffer);
    return buffer;
  }

  /**
   * Builds the shared signal chain:
   *
   *   mix -> low-pass -> (dry + convolution) -> master -> limiter -> [monitor] -> [analyser] -> out
   *
   * Live playback uses the monitor stage so the volume control can never alter an
   * exported file; the offline renderer omits it and always renders at unity.
   *
   * @param {BaseAudioContext} context
   * @param {object} settings
   * @param {{withAnalyser?: boolean, withMonitor?: boolean}} [options]
   */
  function createGraph(context, settings, options = {}) {
    const { withAnalyser = false, withMonitor = false } = options;
    const mix = context.createGain();
    const filter = context.createBiquadFilter();
    const dry = context.createGain();
    const convolver = context.createConvolver();
    const wet = context.createGain();
    const master = context.createGain();
    const limiter = context.createDynamicsCompressor();

    filter.type = 'lowpass';
    filter.frequency.value = filterFrequency(settings.brightness);
    filter.Q.value = TUNING.filterQ;
    dry.gain.value = TUNING.dryGain;
    wet.gain.value = reverbSend(settings.space);
    master.gain.value = TUNING.masterGain;
    convolver.buffer = makeImpulse(context);

    // The compressor acts as a transparent safety ceiling when dense melodies,
    // bass, pads, and sound effects overlap at high energy settings.
    limiter.threshold.value = -14;
    limiter.knee.value = 18;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;

    mix.connect(filter);
    filter.connect(dry);
    filter.connect(convolver);
    dry.connect(master);
    convolver.connect(wet);
    wet.connect(master);
    master.connect(limiter);

    let tail = limiter;
    let monitor = null;
    if (withMonitor) {
      monitor = context.createGain();
      monitor.gain.value = monitorLevel(settings, muted);
      limiter.connect(monitor);
      tail = monitor;
    }

    let analyser = null;
    if (withAnalyser) {
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      tail.connect(analyser);
      analyser.connect(context.destination);
    } else {
      tail.connect(context.destination);
    }

    return { mix, filter, wet, master, limiter, monitor, analyser };
  }

  /** Tracks live sources so Stop can silence everything already queued. Offline contexts are ignored. */
  function trackSource(source, context) {
    if (context !== audio.context) return;

    audio.sources.add(source);
    source.addEventListener('ended', () => audio.sources.delete(source), { once: true });
  }

  function melodyVoice(context, destination, time, frequency, duration, amplitude, settings) {
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    const harmonic = context.createOscillator();
    const harmonicGain = context.createGain();
    const style = voiceStyles[settings.voiceStyle] || voiceStyles.bell;
    const attack = 0.012;
    const release = Math.max(0.05, duration * 0.18);
    const stopTime = time + duration + release + 0.02;

    oscillator.type = style.primary;
    oscillator.frequency.value = frequency;
    harmonic.type = 'sine';
    harmonic.frequency.value = frequency * style.harmonicRatio;
    harmonicGain.gain.value = (0.1 + settings.brightness / 500) * style.harmonicGain;

    gain.gain.setValueAtTime(MIN_GAIN, time);
    gain.gain.exponentialRampToValueAtTime(amplitude, time + attack);
    gain.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, amplitude * 0.35), time + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + duration + release);

    oscillator.connect(gain);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(gain);
    gain.connect(destination);
    oscillator.start(time);
    harmonic.start(time);
    oscillator.stop(stopTime);
    harmonic.stop(stopTime);
    trackSource(oscillator, context);
    trackSource(harmonic, context);
  }

  function bassVoice(context, destination, time, frequency, duration, amplitude) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();

    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency;
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    gain.gain.setValueAtTime(MIN_GAIN, time);
    gain.gain.exponentialRampToValueAtTime(amplitude, time + 0.018);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + duration);

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
    trackSource(oscillator, context);
  }

  function padVoice(context, destination, time, frequency, duration, amplitude) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(MIN_GAIN, time);
    gain.gain.linearRampToValueAtTime(amplitude, time + 0.3);
    gain.gain.setValueAtTime(amplitude, time + Math.max(0.31, duration - 0.45));
    gain.gain.linearRampToValueAtTime(MIN_GAIN, time + duration);

    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
    trackSource(oscillator, context);
  }

  function kick(context, destination, time, amplitude) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.frequency.setValueAtTime(130, time);
    oscillator.frequency.exponentialRampToValueAtTime(48, time + 0.16);
    gain.gain.setValueAtTime(amplitude, time);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + 0.19);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(time);
    oscillator.stop(time + 0.2);
    trackSource(oscillator, context);
  }

  function hat(context, destination, time, amplitude) {
    const source = context.createBufferSource();
    const highPass = context.createBiquadFilter();
    const gain = context.createGain();

    source.buffer = noiseBuffer(context);
    highPass.type = 'highpass';
    highPass.frequency.value = 5200;
    gain.gain.setValueAtTime(amplitude, time);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + TUNING.hatSeconds);
    source.connect(highPass);
    highPass.connect(gain);
    gain.connect(destination);
    source.start(time);
    trackSource(source, context);
  }

  /**
   * Schedules every voice that sounds on `step` at absolute context time `time`.
   * Shared by live playback and the offline renderer so an export is sample for
   * sample identical to what was heard.
   */
  function scheduleStep(context, graph, step, time, settings) {
    const scale = scales[settings.scale];
    if (!scale) throw new Error(`Unknown scale "${settings.scale}".`);

    const semitones = scale.semitones;
    const section = Math.floor(step / harmonySteps);
    const chord = settings.progression[section % settings.progression.length];
    const energy = settings.energy / 100;
    const stepDuration = app.math.stepSeconds(settings);
    const degree = settings.melody[step];
    const chordRootMidi = melodyBaseMidi + settings.root + chord;

    if (degree !== null && degree !== undefined) {
      const midi = chordRootMidi + semitones[Math.min(degree, semitones.length - 1)];
      melodyVoice(
        context,
        graph.mix,
        time,
        app.math.midiHz(midi),
        stepDuration * (2.75 + energy * 0.95),
        0.082 + energy * 0.072,
        settings
      );
    }

    if (step % harmonySteps === 0) {
      bassVoice(context, graph.mix, time, app.math.midiHz(bassBaseMidi + settings.root + chord), stepDuration * 6.4, 0.075 + energy * 0.052);
      if (settings.pad) {
        for (const degreeIndex of [0, 2, 4]) {
          if (semitones[degreeIndex] === undefined) continue;
          padVoice(context, graph.mix, time, app.math.midiHz(chordRootMidi + semitones[degreeIndex]), stepDuration * 7.7, 0.014 + energy * 0.01);
        }
      }
    }

    if (settings.drums) {
      if (step % stepsPerBar === 0) kick(context, graph.mix, time, 0.09 + energy * 0.09);
      if (step % 2 === 1) hat(context, graph.mix, time, 0.018 + energy * 0.018);
    }
  }

  /**
   * Resumes playback when a backgrounded tab becomes visible again. Browsers are
   * free to suspend a context without telling the page, and a suspended context
   * would otherwise stay silent until the next transport click.
   */
  function bindLifecycle() {
    if (lifecycleBound || typeof document === 'undefined') return;
    lifecycleBound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !audio.playing) return;
      if (audio.context && audio.context.state === 'suspended') {
        audio.context.resume().catch(() => {});
      }
    });
  }

  /**
   * Lazily creates the live context on first use and recovers from a context that
   * was closed (for example after a bfcache restore following pagehide).
   */
  async function ensureAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support the Web Audio API.');

    bindLifecycle();

    if (!audio.context || audio.context.state === 'closed') {
      audio.context = new AudioContextClass();
      audio.graph = createGraph(audio.context, app.settings.read(), { withAnalyser: true, withMonitor: true });
    }

    if (audio.context.state === 'suspended') await audio.context.resume();
  }

  /** Applies the controls that shape the shared graph without restarting playback. */
  function updateGraph(settings = app.settings.read()) {
    const graph = audio.graph;
    const context = audio.context;
    if (!graph || !context) return;

    const now = context.currentTime;
    graph.filter.frequency.setTargetAtTime(filterFrequency(settings.brightness), now, 0.04);
    graph.wet.gain.setTargetAtTime(reverbSend(settings.space), now, 0.04);
    if (graph.monitor) graph.monitor.gain.setTargetAtTime(monitorLevel(settings, muted), now, 0.03);
  }

  /** Mutes monitoring without touching the stored volume or any exported audio. */
  function setMuted(value) {
    muted = Boolean(value);
    const graph = audio.graph;
    if (graph && graph.monitor && audio.context) {
      graph.monitor.gain.setTargetAtTime(monitorLevel(app.settings.read(), muted), audio.context.currentTime, 0.02);
    }
    return muted;
  }

  function enqueueVisual(step, time) {
    // Hidden tabs do not paint; skipping the queue keeps memory flat while the
    // scheduler continues to feed the audio thread.
    if (typeof document !== 'undefined' && document.hidden) return;

    visualQueue.push({ step, time });
    if (visualQueue.length > steps) visualQueue.shift();
  }

  function visualLoop() {
    visualFrame = 0;
    if (!audio.playing || !audio.context) return;

    const now = audio.context.currentTime;
    let latest = -1;
    while (visualQueue.length > 0 && visualQueue[0].time <= now) latest = visualQueue.shift().step;
    if (latest >= 0) app.ui.showPlayhead(latest, app.settings.read());

    visualFrame = window.requestAnimationFrame(visualLoop);
  }

  function startVisualLoop() {
    if (visualFrame) return;
    visualFrame = window.requestAnimationFrame(visualLoop);
  }

  function scheduler() {
    if (!audio.playing || !audio.context || !audio.graph) return;

    // Settings cannot change within a synchronous tick; read them once per pass.
    const settings = app.settings.read();
    const stepDuration = app.math.stepSeconds(settings);
    if (!(stepDuration > 0) || !Number.isFinite(stepDuration)) {
      reportFailure(new Error('The requested tempo cannot be scheduled.'));
      stopPlayback();
      return;
    }

    const lookAhead = document.hidden ? SCHEDULER.hiddenLookAheadSeconds : SCHEDULER.lookAheadSeconds;
    const now = audio.context.currentTime;
    const horizon = now + lookAhead;

    // A suspended or stalled tab can leave the clock far ahead of the schedule.
    // Resynchronising avoids emitting a burst of overdue notes at once.
    if (audio.nextStepTime < now - SCHEDULER.maxCatchUpSeconds) {
      audio.nextStepTime = now + SCHEDULER.startLatencySeconds;
      audio.step = 0;
      visualQueue.length = 0;
    }

    while (audio.nextStepTime < horizon) {
      const scheduledTime = audio.nextStepTime + app.math.swingSeconds(audio.step, settings);

      scheduleStep(audio.context, audio.graph, audio.step, scheduledTime, settings);
      enqueueVisual(audio.step, scheduledTime);
      audio.nextStepTime += stepDuration;
      audio.step = (audio.step + 1) % steps;
    }
  }

  function silenceSources() {
    audio.sources.forEach((source) => {
      try {
        source.stop();
      } catch (error) {
        // The node may already have ended naturally.
      }
    });
    audio.sources.clear();
  }

  /**
   * Fades the monitor down before stopping the oscillators. Cutting a note
   * mid-release produces an audible click, which is exactly the artefact the
   * exported files are free of.
   */
  function fadeOutAndStopSources(token) {
    const graph = audio.graph;
    const context = audio.context;

    if (!graph || !graph.monitor || !context || context.state !== 'running') {
      silenceSources();
      return;
    }

    const now = context.currentTime;
    const fade = TUNING.stopFadeSeconds;
    graph.monitor.gain.cancelScheduledValues(now);
    graph.monitor.gain.setValueAtTime(graph.monitor.gain.value, now);
    graph.monitor.gain.linearRampToValueAtTime(0, now + fade);

    window.clearTimeout(stopTimer);
    stopTimer = window.setTimeout(() => {
      stopTimer = 0;
      if (playbackToken !== token || !audio.graph || !audio.context) return;
      silenceSources();
      audio.graph.monitor.gain.cancelScheduledValues(audio.context.currentTime);
      audio.graph.monitor.gain.setValueAtTime(monitorLevel(app.settings.read(), muted), audio.context.currentTime);
    }, fade * 1000 + 20);
  }

  function stopScheduler() {
    window.clearInterval(audio.schedulerTimer);
    audio.schedulerTimer = null;
    if (visualFrame) {
      window.cancelAnimationFrame(visualFrame);
      visualFrame = 0;
    }
    visualQueue.length = 0;
  }

  function stopPlayback() {
    const wasPlaying = audio.playing;
    const token = ++playbackToken;

    audio.playing = false;
    stopScheduler();
    if (audio.sources.size > 0) fadeOutAndStopSources(token);

    if (!wasPlaying) return;
    app.ui.clearPlayhead();
    app.ui.setPlaybackState(false);
  }

  function cancelPendingStop() {
    const stopWasPending = stopTimer !== 0;
    playbackToken += 1;
    window.clearTimeout(stopTimer);
    stopTimer = 0;

    // A restart inside the stop fade would otherwise let the previous loop's
    // release tails bleed into the new pass.
    if (stopWasPending) silenceSources();

    const graph = audio.graph;
    if (graph && graph.monitor && audio.context) {
      const now = audio.context.currentTime;
      graph.monitor.gain.cancelScheduledValues(now);
      graph.monitor.gain.setValueAtTime(monitorLevel(app.settings.read(), muted), now);
    }
  }

  async function startPlayback() {
    // Coalesce overlapping start requests (double-click, Space plus click) into
    // one; otherwise a second scheduler interval would leak.
    if (audio.playing) return;
    if (audio.starting) return audio.starting;

    audio.starting = (async () => {
      await ensureAudio();
      cancelPendingStop();

      const settings = app.settings.read();
      const stepDuration = app.math.stepSeconds(settings);
      if (!(stepDuration > 0) || !Number.isFinite(stepDuration)) {
        throw new Error('The requested tempo cannot be scheduled.');
      }

      audio.playing = true;
      audio.step = 0;
      audio.nextStepTime = audio.context.currentTime + SCHEDULER.startLatencySeconds;
      scheduler();
      audio.schedulerTimer = window.setInterval(scheduler, SCHEDULER.intervalMs);
      startVisualLoop();
      app.ui.setPlaybackState(true);
    })();

    try {
      await audio.starting;
    } catch (error) {
      stopPlayback();
      throw error;
    } finally {
      audio.starting = null;
    }
  }

  function reportFailure(error) {
    console.error(error);
    app.ui.reportAudioError(error && error.message);
  }

  async function togglePlayback() {
    if (audio.playing) {
      stopPlayback();
      return;
    }

    try {
      await startPlayback();
    } catch (error) {
      reportFailure(error);
    }
  }

  /** Restarts from step 0 so a newly generated loop is heard from its beginning. */
  async function restartPlayback() {
    stopPlayback();
    try {
      await startPlayback();
    } catch (error) {
      reportFailure(error);
    }
  }

  async function playSfx(kind) {
    try {
      await ensureAudio();
      const context = audio.context;
      const destination = audio.graph.mix;
      const settings = { ...app.settings.read(), brightness: 55 };
      const time = context.currentTime + 0.02;
      const ping = (frequency, duration, amplitude, delay = 0) => (
        melodyVoice(context, destination, time + delay, frequency, duration, amplitude, settings)
      );

      switch (kind) {
        case 'tap': ping(560, 0.09, 0.16); break;
        case 'move': ping(440, 0.11, 0.18); break;
        case 'deny': bassVoice(context, destination, time, 180, 0.16, 0.2); break;
        case 'coin': ping(880, 0.1, 0.16); ping(1320, 0.14, 0.13, 0.07); break;
        case 'win': [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => ping(frequency, 0.32, 0.15, index * 0.09)); break;
        default: break;
      }
    } catch (error) {
      reportFailure(error);
    }
  }

  async function dispose() {
    stopPlayback();
    window.clearTimeout(stopTimer);
    stopTimer = 0;
    silenceSources();

    const context = audio.context;
    audio.context = null;
    audio.graph = null;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }

  app.audioEngine = Object.freeze({
    createGraph,
    dispose,
    ensureAudio,
    playSfx,
    restartPlayback,
    scheduleStep,
    setMuted,
    startPlayback,
    stopPlayback,
    togglePlayback,
    updateGraph
  });
})();
