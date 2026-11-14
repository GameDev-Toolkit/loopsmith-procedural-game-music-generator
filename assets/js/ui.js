(() => {
  'use strict';

  const app = window.LoopSmith;
  const { steps, stepsPerBar, harmonySteps, melodyBaseMidi } = app.constants;
  const { noteNames, scales } = app.catalog;

  const barCount = steps / stepsPerBar;
  const TOAST_MS = 1800;
  // Rebuilding the handoff document is far more expensive than re-rendering the
  // read-outs, so it is debounced independently of the animation frame.
  const HANDOFF_RENDER_DELAY_MS = 120;

  const REQUIRED_IDS = Object.freeze([
    'audioStatus',
    'beatNumbers',
    'copyHandoff',
    'copyLink',
    'downloadSpec',
    'exportWav',
    'handoffText',
    'handoffToggle',
    'melodyDetails',
    'metaKey',
    'metaLoop',
    'metaProfile',
    'nowPlaying',
    'play',
    'playIcon',
    'playText',
    'redoStep',
    'scope',
    'stepGrid',
    'toast',
    'transportTime',
    'undoStep'
  ]);

  /** @type {Record<string, HTMLElement>} */
  const elements = Object.create(null);
  /** gridCells[step][degree] -> button */
  const gridCells = Array.from({ length: steps }, () => []);

  let beatNumbersRendered = false;
  let gridRows = 0;
  let playingStep = -1;
  let focusedCell = { step: 0, degree: 0 };
  let toastTimer = 0;
  let outputsFrame = 0;
  let pendingSettings = null;
  let pendingHandoff = null;
  let handoffTimer = 0;
  let tabs = [];

  const nextFrame = (callback) => (
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(callback, 16)
  );

  const cancelFrame = (handle) => {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
  };

  /* ------------------------------------------------------------------ *
   * Sequencer
   * ------------------------------------------------------------------ */

  function paintStep(step, degree) {
    const cells = gridCells[step];
    for (let index = 0; index < cells.length; index += 1) {
      const active = degree === index;
      const cell = cells[index];
      if (cell.classList.contains('active') !== active) cell.classList.toggle('active', active);
      const pressed = String(active);
      if (cell.getAttribute('aria-pressed') !== pressed) cell.setAttribute('aria-pressed', pressed);
    }
  }

  function applyTabIndex() {
    for (let step = 0; step < steps; step += 1) {
      const row = gridCells[step];
      for (let degree = 0; degree < row.length; degree += 1) {
        row[degree].tabIndex = step === focusedCell.step && degree === focusedCell.degree ? 0 : -1;
      }
    }
  }

  function renderBeatNumbers() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createElement('span'));
    for (let step = 0; step < steps; step += 1) {
      const number = document.createElement('span');
      number.textContent = String(step + 1);
      fragment.appendChild(number);
    }
    elements.beatNumbers.replaceChildren(fragment);
    beatNumbersRendered = true;
  }

  function buildGrid(rows) {
    for (const cells of gridCells) cells.length = 0;

    const fragment = document.createDocumentFragment();
    for (let row = rows - 1; row >= 0; row -= 1) {
      const label = document.createElement('div');
      label.className = 'degree-label';
      label.textContent = String(row + 1);
      fragment.appendChild(label);

      for (let step = 0; step < steps; step += 1) {
        const cell = document.createElement('button');
        const description = `Step ${step + 1}, scale degree ${row + 1}`;
        cell.type = 'button';
        cell.className = step % stepsPerBar === 0 ? 'step-cell beat' : 'step-cell';
        cell.dataset.step = String(step);
        cell.dataset.degree = String(row);
        cell.title = description;
        cell.setAttribute('aria-label', description);
        cell.tabIndex = -1;
        gridCells[step][row] = cell;
        fragment.appendChild(cell);
      }
    }

    elements.stepGrid.replaceChildren(fragment);
    gridRows = rows;
    focusedCell.degree = Math.min(focusedCell.degree, rows - 1);
    applyTabIndex();

    if (!beatNumbersRendered) renderBeatNumbers();
  }

  /**
   * Reconciles the sequencer with the current settings. Only steps whose degree
   * changed are repainted, which keeps editing cheap on a 252-cell grid.
   */
  function syncGrid(settings, previous) {
    const rows = scales[settings.scale].semitones.length;
    const rebuilt = rows !== gridRows;
    if (rebuilt) buildGrid(rows);

    if (rebuilt || !previous) {
      for (let step = 0; step < steps; step += 1) paintStep(step, settings.melody[step]);
      return;
    }

    for (let step = 0; step < steps; step += 1) {
      if (previous.melody[step] !== settings.melody[step]) paintStep(step, settings.melody[step]);
    }
  }

  function focusCell(step, degree) {
    const row = gridCells[step];
    if (!row || !row[degree]) return;
    focusedCell = { step, degree };
    applyTabIndex();
    row[degree].focus();
  }

  function toggleCell(step, degree) {
    const current = app.settings.read().melody[step];
    app.settings.setNote(step, current === degree ? null : degree);
  }

  function onGridClick(event) {
    const cell = event.target.closest('.step-cell');
    if (!cell || !elements.stepGrid.contains(cell)) return;

    const step = Number(cell.dataset.step);
    const degree = Number(cell.dataset.degree);
    focusedCell = { step, degree };
    applyTabIndex();
    toggleCell(step, degree);
  }

  /** Arrow keys move between steps and degrees; the grid holds a single tab stop. */
  function onGridKeyDown(event) {
    const cell = event.target.closest('.step-cell');
    if (!cell || !elements.stepGrid.contains(cell)) return;

    const step = Number(cell.dataset.step);
    const degree = Number(cell.dataset.degree);
    let nextStep = step;
    let nextDegree = degree;

    switch (event.key) {
      case 'ArrowRight': nextStep = Math.min(steps - 1, step + 1); break;
      case 'ArrowLeft': nextStep = Math.max(0, step - 1); break;
      case 'ArrowUp': nextDegree = Math.min(gridRows - 1, degree + 1); break;
      case 'ArrowDown': nextDegree = Math.max(0, degree - 1); break;
      case 'Home': nextStep = 0; break;
      case 'End': nextStep = steps - 1; break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        toggleCell(step, degree);
        return;
      default:
        return;
    }

    event.preventDefault();
    focusCell(nextStep, nextDegree);
  }

  /* ------------------------------------------------------------------ *
   * Playhead and transport read-outs
   * ------------------------------------------------------------------ */

  function setPlayheadState(step, playing) {
    const cells = gridCells[step];
    if (!cells) return;
    for (const cell of cells) cell.classList.toggle('playing', playing);
  }

  function clearPlayhead() {
    if (playingStep >= 0) setPlayheadState(playingStep, false);
    playingStep = -1;
    elements.nowPlaying.textContent = '—';
    elements.transportTime.textContent = `Bar 1/${barCount} · Step 1/${steps}`;
  }

  function showPlayhead(step, settings) {
    if (step === playingStep) return;
    if (playingStep >= 0) setPlayheadState(playingStep, false);
    playingStep = step;
    setPlayheadState(step, true);

    const bar = Math.floor(step / stepsPerBar) + 1;
    elements.transportTime.textContent = `Bar ${bar}/${barCount} · Step ${step + 1}/${steps}`;

    const degree = settings.melody[step];
    if (degree === null || degree === undefined) {
      elements.nowPlaying.textContent = 'rest';
      return;
    }

    const progression = settings.progression;
    const chord = progression[Math.floor(step / harmonySteps) % progression.length];
    const midi = melodyBaseMidi + settings.root + chord + scales[settings.scale].semitones[degree];
    elements.nowPlaying.textContent = app.math.midiToNoteName(midi);
  }

  function setPlaybackState(playing) {
    elements.playIcon.textContent = playing ? '■' : '▶';
    elements.playText.textContent = playing ? 'Stop' : 'Play';
    elements.audioStatus.textContent = playing ? 'Playing' : 'Ready';
    elements.status.classList.remove('is-error');
    scope.setActive(playing);
  }

  function setStatus(message, isError = false) {
    elements.audioStatus.textContent = message;
    elements.status.classList.toggle('is-error', Boolean(isError));
  }

  function reportAudioError(message) {
    setStatus('Audio unavailable', true);
    toast(message || 'Audio is unavailable');
  }

  function setExportState(rendering) {
    elements.exportWav.disabled = Boolean(rendering);
    elements.exportWav.textContent = rendering ? 'Rendering…' : 'Export WAV';
  }

  function setHistoryState(canUndo, canRedo) {
    elements.undoStep.disabled = !canUndo;
    elements.redoStep.disabled = !canRedo;
  }

  /* ------------------------------------------------------------------ *
   * Derived read-outs and handoff text
   * ------------------------------------------------------------------ */

  function renderOutputs(settings) {
    for (const id of app.outputIds) {
      elements[`${id}Out`].textContent = id === 'bpm' ? `${settings.bpm} BPM` : `${settings[id]}%`;
    }

    const activeNotes = app.math.activeNoteCount(settings.melody);
    elements.metaKey.textContent = `${noteNames[settings.root]} ${scales[settings.scale].short}`;
    elements.metaLoop.textContent = `${app.math.loopSeconds(settings).toFixed(1)} s`;
    elements.metaProfile.textContent = settings.profileLabel;
    elements.melodyDetails.textContent = `${settings.motifName} · ${activeNotes}/${steps} notes · ${settings.structure}`;
  }

  function isHandoffOpen() {
    return !elements.handoff.classList.contains('collapsed');
  }

  function renderHandoff(settings = app.settings.read()) {
    const tab = app.state.currentTab;
    elements.handoffText.value = tab === 'json'
      ? JSON.stringify(app.exporter.buildSpec(settings), null, 2)
      : tab === 'godot'
        ? app.exporter.buildGodot(settings)
        : app.exporter.buildPrompt(settings);
  }

  /** Queues a handoff rebuild; repeated edits inside the delay collapse into one. */
  function scheduleHandoffRender(settings) {
    pendingHandoff = settings;
    window.clearTimeout(handoffTimer);
    handoffTimer = window.setTimeout(() => {
      handoffTimer = 0;
      const current = pendingHandoff || app.settings.read();
      pendingHandoff = null;
      if (isHandoffOpen()) renderHandoff(current);
    }, HANDOFF_RENDER_DELAY_MS);
  }

  /**
   * Coalesces read-out updates into one animation frame. Slider drags fire many
   * input events per frame, so the cheap read-outs follow the frame while the
   * handoff document is debounced further.
   */
  function requestOutputs(settings) {
    pendingSettings = settings;
    if (isHandoffOpen()) scheduleHandoffRender(settings);
    if (outputsFrame) return;

    outputsFrame = nextFrame(() => {
      outputsFrame = 0;
      const current = pendingSettings || app.settings.read();
      pendingSettings = null;
      renderOutputs(current);
    });
  }

  /* ------------------------------------------------------------------ *
   * Clipboard and notifications
   * ------------------------------------------------------------------ */

  function legacyCopy(text) {
    if (typeof document.execCommand !== 'function') return false;

    const previousFocus = document.activeElement;
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.setAttribute('aria-hidden', 'true');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    helper.remove();
    // Returning focus keeps keyboard navigation where the user left it.
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    return copied;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // Insecure contexts and permission policies reject the async API; fall
      // back to the selection-based command before asking the user to copy.
    }
    return legacyCopy(text);
  }

  function toast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => elements.toast.classList.remove('show'), TOAST_MS);
  }

  async function copyHandoff() {
    const copied = await copyText(elements.handoffText.value);
    if (copied) {
      toast('Handoff copied');
      return;
    }
    elements.handoffText.focus();
    elements.handoffText.select();
    toast('Select the handoff text and copy it manually');
  }

  /* ------------------------------------------------------------------ *
   * Handoff panel
   * ------------------------------------------------------------------ */

  function selectTab(name) {
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    app.state.currentTab = name;
    renderHandoff();
  }

  function toggleHandoff() {
    const collapsed = elements.handoff.classList.toggle('collapsed');
    elements.handoffToggle.setAttribute('aria-expanded', String(!collapsed));
    elements.handoffToggle.textContent = collapsed ? 'Expand' : 'Collapse';
    if (!collapsed) renderHandoff();
  }

  /* ------------------------------------------------------------------ *
   * Waveform
   * ------------------------------------------------------------------ */

  const scope = (() => {
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const MIN_PAINT_INTERVAL_MS = 90;

    let canvas = null;
    let context = null;
    let active = false;
    let frame = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let samples = new Uint8Array(0);
    let lastPaint = 0;

    /** Reads layout once per resize instead of once per animation frame. */
    function measure() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const targetWidth = Math.max(1, Math.round(rect.width * ratio));
      const targetHeight = Math.max(1, Math.round(rect.height * ratio));

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      width = rect.width;
      height = rect.height;
      pixelRatio = ratio;
    }

    function draw() {
      if (!context || width <= 0 || height <= 0) return;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      context.strokeStyle = 'rgba(255, 255, 255, 0.055)';
      context.lineWidth = 1;
      context.beginPath();
      for (let step = 0; step <= steps; step += 1) {
        const x = Math.round(step / steps * width) + 0.5;
        context.moveTo(x, 0);
        context.lineTo(x, height);
      }
      context.stroke();

      const analyser = active ? app.audioState.graph && app.audioState.graph.analyser : null;
      if (analyser) {
        if (samples.length !== analyser.fftSize) samples = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(samples);
      } else {
        if (samples.length !== 2) samples = new Uint8Array(2);
        samples.fill(128);
      }

      const midline = height / 2;
      // A 1024-sample analyser frame is more detail than one screen width needs;
      // sampling it down keeps the polyline cheap without changing its shape.
      const stride = Math.max(1, Math.floor(samples.length / 512));
      context.beginPath();
      context.lineWidth = 2.2;
      context.strokeStyle = active ? '#d8ff62' : '#5c5d68';
      for (let index = 0; index < samples.length; index += stride) {
        const x = index / (samples.length - 1) * width;
        const y = midline + (samples[index] - 128) / 128 * height * 1.28;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }

    function tick(timestamp) {
      frame = 0;
      if (!active) {
        draw();
        return;
      }
      if (reducedMotion && timestamp - lastPaint < MIN_PAINT_INTERVAL_MS) {
        frame = nextFrame(tick);
        return;
      }
      lastPaint = timestamp;
      draw();
      frame = nextFrame(tick);
    }

    function requestPaint() {
      if (frame) return;
      frame = nextFrame(tick);
    }

    function start() {
      canvas = elements.scope;
      context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (!context) return;

      measure();
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
          measure();
          requestPaint();
        }).observe(canvas);
      } else {
        window.addEventListener('resize', () => {
          measure();
          requestPaint();
        });
      }
      requestPaint();
    }

    function setActive(playing) {
      active = Boolean(playing);
      if (active) {
        requestPaint();
        return;
      }
      if (frame) {
        cancelFrame(frame);
        frame = 0;
      }
      draw();
    }

    return { setActive, start };
  })();

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  function bindInteractions() {
    elements.stepGrid.addEventListener('click', onGridClick);
    elements.stepGrid.addEventListener('keydown', onGridKeyDown);
    elements.copyHandoff.addEventListener('click', copyHandoff);
    elements.handoffToggle.addEventListener('click', toggleHandoff);
    for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }

  function init() {
    for (const id of REQUIRED_IDS) elements[id] = app.dom.require(id);
    for (const id of app.outputIds) elements[`${id}Out`] = app.dom.require(`${id}Out`);

    elements.status = elements.audioStatus.closest('.status') || elements.audioStatus;
    elements.handoff = elements.handoffToggle.closest('.handoff') || elements.handoffToggle;
    tabs = Array.from(document.querySelectorAll('.tab'));

    bindInteractions();
    scope.start();
  }

  app.ui = Object.freeze({
    clearPlayhead,
    copyText,
    init,
    renderHandoff,
    renderOutputs,
    reportAudioError,
    requestOutputs,
    setExportState,
    setHistoryState,
    setPlaybackState,
    setStatus,
    showPlayhead,
    syncGrid,
    toast
  });
})();
