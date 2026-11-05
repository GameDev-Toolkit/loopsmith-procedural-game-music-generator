(() => {
  'use strict';

  const app = window.LoopSmith;
  const audio = app.audioState;
  const { harmonySteps, steps, stepsPerBar, melodyBaseMidi, bassBaseMidi } = app.constants;
  const { scales, voiceStyles } = app.catalog;

  // Scheduler tuning. The look-ahead must comfortably exceed the timer interval;
  // background tabs throttle timers to roughly once per second, so a wider
  // window is used there to avoid audible gaps.
  const SCHEDULER_INTERVAL_MS = 25;
  const LOOK_AHEAD_SECONDS = 0.12;
  const HIDDEN_LOOK_AHEAD_SECONDS = 1.5;
  const START_LATENCY_SECONDS = 0.06;

  const MIN_GAIN = 0.0001;
  const IMPULSE_SEED = 'loopsmith-room-v1';
  const IMPULSE_SECONDS = 1.7;
  const IMPULSE_DECAY = 2.7;
  const HAT_SECONDS = 0.045;

  // Impulse responses are pure functions of the sample rate, so each one is
  // generated once and copied into every new context (live or offline).
  const impulseCache = new Map();
  // One short white-noise buffer per context serves every hi-hat hit.
  const noiseBuffers = new WeakMap();

  const filterFrequency = (brightness) => 900 + brightness * 55;
  const reverbSend = (space) => space / 100 * 0.42;

  function impulseChannels(sampleRate) {
    let channels = impulseCache.get(sampleRate);
    if (channels) return channels;

    const length = Math.floor(sampleRate * IMPULSE_SECONDS);
    const random = app.math.rngFrom(IMPULSE_SEED);
    channels = [new Float32Array(length), new Float32Array(length)];

    for (const data of channels) {
      for (let index = 0; index < length; index += 1) {
        data[index] = (random() * 2 - 1) * Math.pow(1 - index / length, IMPULSE_DECAY);
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

    const length = Math.floor(context.sampleRate * HAT_SECONDS);
    const random = app.math.rngFrom('loopsmith-hat-v1');
    buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = random() * 2 - 1;

    noiseBuffers.set(context, buffer);
    return buffer;
  }

  /**
   * Builds the shared signal chain: mix -> low-pass -> (dry + convolution) ->
   * master -> limiter -> [analyser] -> destination. The same topology drives
   * live playback and offline WAV rendering so exports match what was heard.
   */
  function createGraph(context, settings, withAnalyser = false) {
    const mix = context.createGain();
    const filter = context.createBiquadFilter();
    const dry = context.createGain();
    const convolver = context.createConvolver();
    const wet = context.createGain();
    const master = context.createGain();
    const limiter = context.createDynamicsCompressor();

    filter.type = 'lowpass';
    filter.frequency.value = filterFrequency(settings.brightness);
    filter.Q.value = 0.35;
    dry.gain.value = 0.94;
    wet.gain.value = reverbSend(settings.space);
    master.gain.value = 0.62;
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

    let analyser = null;
    if (withAnalyser) {
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      limiter.connect(analyser);
      analyser.connect(context.destination);
    } else {
      limiter.connect(context.destination);
    }

    return { mix, filter, wet, master, limiter, analyser };
  }

  /** Tracks live sources so Stop can silence everything already queued. Offline contexts are left alone. */
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
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + HAT_SECONDS);
    source.connect(highPass);
    highPass.connect(gain);
    gain.connect(destination);
    source.start(time);
    trackSource(source, context);
  }

  /** Schedules every voice that sounds on `step` at absolute context time `time`. */
  function scheduleStep(context, graph, step, time, settings) {
    const scale = scales[settings.scale].semitones;
    const section = Math.floor(step / harmonySteps);
    const chord = settings.progression[section % settings.progression.length];
    const energy = settings.energy / 100;
    const stepDuration = app.math.stepSeconds(settings);
    const degree = settings.melody[step];
    const chordRootMidi = melodyBaseMidi + settings.root + chord;

    if (degree !== null && degree !== undefined) {
      const midi = chordRootMidi + scale[Math.min(degree, scale.length - 1)];
      melodyVoice(context, graph.mix, time, app.math.midiHz(midi), stepDuration * (2.75 + energy * 0.95), 0.082 + energy * 0.072, settings);
    }

    if (step % harmonySteps === 0) {
      bassVoice(context, graph.mix, time, app.math.midiHz(bassBaseMidi + settings.root + chord), stepDuration * 6.4, 0.075 + energy * 0.052);
      if (settings.pad) {
        for (const degreeIndex of [0, 2, 4]) {
          if (scale[degreeIndex] === undefined) continue;
          padVoice(context, graph.mix, time, app.math.midiHz(chordRootMidi + scale[degreeIndex]), stepDuration * 7.7, 0.014 + energy * 0.01);
        }
      }
    }

    if (settings.drums) {
      if (step % stepsPerBar === 0) kick(context, graph.mix, time, 0.09 + energy * 0.09);
      if (step % 2 === 1) hat(context, graph.mix, time, 0.018 + energy * 0.018);
    }
  }

  /**
   * Lazily creates the live context on first use and recovers from a context
   * that was closed (for example after a bfcache restore following pagehide).
   */
  async function ensureAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support the Web Audio API.');

    if (!audio.context || audio.context.state === 'closed') {
      audio.context = new AudioContextClass();
      audio.graph = createGraph(audio.context, app.readSettings(), true);
    }

    if (audio.context.state === 'suspended') await audio.context.resume();
  }

  /** Applies the controls that affect the shared graph without restarting playback. */
  function updateGraph() {
    if (!audio.graph || !audio.context) return;

    const settings = app.readSettings();
    const now = audio.context.currentTime;
    audio.graph.filter.frequency.setTargetAtTime(filterFrequency(settings.brightness), now, 0.04);
    audio.graph.wet.gain.setTargetAtTime(reverbSend(settings.space), now, 0.04);
  }

  function scheduleVisualStep(step, scheduledTime) {
    const delay = Math.max(0, (scheduledTime - audio.context.currentTime) * 1000);
    const timer = window.setTimeout(() => {
      audio.visualTimers.delete(timer);
      if (audio.playing) app.ui.showPlayhead(step);
    }, delay);
    audio.visualTimers.add(timer);
  }

  function scheduler() {
    if (!audio.playing || !audio.context) return;

    // Settings cannot change within a synchronous tick; read them once per pass.
    const settings = app.readSettings();
    const stepDuration = app.math.stepSeconds(settings);
    const lookAhead = document.hidden ? HIDDEN_LOOK_AHEAD_SECONDS : LOOK_AHEAD_SECONDS;
    const horizon = audio.context.currentTime + lookAhead;

    while (audio.nextStepTime < horizon) {
      const scheduledTime = audio.nextStepTime + app.math.swingSeconds(audio.step, settings);

      scheduleStep(audio.context, audio.graph, audio.step, scheduledTime, settings);
      scheduleVisualStep(audio.step, scheduledTime);
      audio.nextStepTime += stepDuration;
      audio.step = (audio.step + 1) % steps;
    }
  }

  async function startPlayback() {
    // Coalesce overlapping start requests (double-click, Space + click) into
    // one; otherwise a second scheduler interval would leak.
    if (audio.playing) return;
    if (audio.starting) return audio.starting;

    audio.starting = (async () => {
      await ensureAudio();
      audio.playing = true;
      audio.step = 0;
      audio.nextStepTime = audio.context.currentTime + START_LATENCY_SECONDS;
      scheduler();
      audio.schedulerTimer = window.setInterval(scheduler, SCHEDULER_INTERVAL_MS);
      app.ui.setPlaybackState(true);
    })();

    try {
      await audio.starting;
    } finally {
      audio.starting = null;
    }
  }

  function stopPlayback() {
    audio.playing = false;
    window.clearInterval(audio.schedulerTimer);
    audio.schedulerTimer = null;
    audio.visualTimers.forEach((timer) => window.clearTimeout(timer));
    audio.visualTimers.clear();
    audio.sources.forEach((source) => {
      try { source.stop(); } catch (_) { /* The node may already have ended naturally. */ }
    });
    audio.sources.clear();
    app.ui.clearPlayhead();
    app.ui.setPlaybackState(false);
  }

  function reportFailure(error) {
    console.error(error);
    app.ui.reportAudioError(error?.message);
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
      const time = audio.context.currentTime + 0.02;
      const destination = audio.graph.mix;
      const settings = { ...app.readSettings(), brightness: 55 };
      const ping = (frequency, duration, amplitude, delay = 0) => (
        melodyVoice(audio.context, destination, time + delay, frequency, duration, amplitude, settings)
      );

      switch (kind) {
        case 'tap': ping(560, 0.09, 0.16); break;
        case 'move': ping(440, 0.11, 0.18); break;
        case 'deny': bassVoice(audio.context, destination, time, 180, 0.16, 0.2); break;
        case 'coin': ping(880, 0.1, 0.16); ping(1320, 0.14, 0.13, 0.07); break;
        case 'win': [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => ping(frequency, 0.32, 0.15, index * 0.09)); break;
        default: break;
      }
    } catch (error) {
      reportFailure(error);
    }
  }

  async function dispose() {
    if (!audio.context) return;
    stopPlayback();
    await audio.context.close().catch(() => {});
    audio.context = null;
    audio.graph = null;
  }

  app.audioEngine = Object.freeze({
    createGraph,
    dispose,
    ensureAudio,
    playSfx,
    restartPlayback,
    scheduleStep,
    startPlayback,
    stopPlayback,
    togglePlayback,
    updateGraph
  });
})();
