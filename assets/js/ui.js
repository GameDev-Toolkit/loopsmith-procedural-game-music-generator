(() => {
  'use strict';

  const app = window.LoopSmith;
  const { harmonySteps, steps, stepsPerBar, melodyBaseMidi } = app.constants;
  const { noteNames, scales } = app.catalog;

  const barCount = steps / stepsPerBar;
  const TOAST_DURATION_MS = 1800;

  // gridCells[step][degree] -> button. Rebuilt only when the number of degree rows changes.
  const gridCells = Array.from({ length: steps }, () => []);
  let gridRowCount = 0;
  let playingStep = -1;
  let toastTimer = 0;

  function updateGridStep(step) {
    const activeDegree = app.state.melody[step];
    gridCells[step].forEach((cell, degree) => {
      const active = activeDegree === degree;
      cell.classList.toggle('active', active);
      cell.setAttribute('aria-pressed', String(active));
    });
  }

  function updateGrid() {
    for (let step = 0; step < steps; step += 1) updateGridStep(step);
  }

  function buildGrid(rowCount) {
    const grid = app.$('stepGrid');
    const fragment = document.createDocumentFragment();

    gridCells.forEach((cells) => cells.splice(0));

    for (let row = rowCount - 1; row >= 0; row -= 1) {
      const label = document.createElement('div');
      label.className = 'degree-label';
      label.textContent = row + 1;
      fragment.appendChild(label);

      for (let step = 0; step < steps; step += 1) {
        const cell = document.createElement('button');
        const title = `Step ${step + 1}, scale degree ${row + 1}`;
        cell.type = 'button';
        cell.className = step % stepsPerBar === 0 ? 'step-cell beat' : 'step-cell';
        cell.title = title;
        cell.dataset.step = step;
        cell.dataset.degree = row;
        cell.setAttribute('aria-label', title);
        gridCells[step][row] = cell;
        fragment.appendChild(cell);
      }
    }

    grid.replaceChildren(fragment);
    gridRowCount = rowCount;

    const numbers = document.createDocumentFragment();
    numbers.appendChild(document.createElement('span'));
    for (let step = 0; step < steps; step += 1) {
      const number = document.createElement('span');
      number.textContent = step + 1;
      numbers.appendChild(number);
    }
    app.$('beatNumbers').replaceChildren(numbers);
  }

  /** Single delegated handler for the whole grid: toggles a note or turns the active cell into a rest. */
  function onGridClick(event) {
    const cell = event.target.closest('.step-cell');
    if (!cell) return;

    const step = Number(cell.dataset.step);
    const degree = Number(cell.dataset.degree);
    app.state.melody[step] = app.state.melody[step] === degree ? null : degree;
    updateGridStep(step);
    updateOutputs();
  }

  /** Syncs the sequencer with the current scale and melody, rebuilding the DOM only when the row count changes. */
  function renderGrid() {
    const rowCount = scales[app.$('scale').value].semitones.length;
    if (rowCount !== gridRowCount) buildGrid(rowCount);
    updateGrid();
  }

  function setPlayheadCells(step, playing) {
    gridCells[step].forEach((cell) => cell.classList.toggle('playing', playing));
  }

  function clearPlayhead() {
    if (playingStep >= 0) setPlayheadCells(playingStep, false);
    playingStep = -1;
    app.$('nowPlaying').textContent = '—';
    app.$('transportTime').textContent = `Bar 1/${barCount} · Step 1/${steps}`;
  }

  function showPlayhead(step) {
    if (playingStep >= 0) setPlayheadCells(playingStep, false);
    playingStep = step;
    setPlayheadCells(step, true);

    const bar = Math.floor(step / stepsPerBar) + 1;
    const degree = app.state.melody[step];
    app.$('transportTime').textContent = `Bar ${bar}/${barCount} · Step ${step + 1}/${steps}`;

    if (degree === null || degree === undefined) {
      app.$('nowPlaying').textContent = 'rest';
      return;
    }

    const settings = app.readSettings();
    const chord = settings.progression[Math.floor(step / harmonySteps) % settings.progression.length];
    const midi = melodyBaseMidi + settings.root + chord + scales[settings.scale].semitones[degree];
    app.$('nowPlaying').textContent = noteNames[((midi % 12) + 12) % 12];
  }

  function setPlaybackState(playing) {
    app.$('playIcon').textContent = playing ? '■' : '▶';
    app.$('playText').textContent = playing ? 'Stop' : 'Play';
    app.$('audioStatus').textContent = playing ? 'Playing' : 'Ready';
    app.$('audioStatus').closest('.status').classList.remove('is-error');
    scope.setActive(playing);
  }

  function reportAudioError(message) {
    const status = app.$('audioStatus');
    status.textContent = 'Audio unavailable';
    status.closest('.status').classList.add('is-error');
    toast(message || 'Audio is unavailable');
  }

  function setExportState(rendering) {
    const button = app.$('exportWav');
    button.disabled = rendering;
    button.textContent = rendering ? 'Rendering…' : 'Export WAV';
  }

  /** Refreshes every derived read-out (slider values, session meta, handoff text) from the current settings. */
  function updateOutputs() {
    const settings = app.readSettings();
    for (const key of ['bpm', 'energy', 'density', 'brightness', 'space', 'swing']) {
      app.$(`${key}Out`).textContent = key === 'bpm' ? `${settings[key]} BPM` : `${settings[key]}%`;
    }

    const activeNotes = app.math.activeNoteCount(settings.melody);
    app.$('metaKey').textContent = `${noteNames[settings.root]} ${scales[settings.scale].short}`;
    app.$('metaLoop').textContent = `${app.math.loopSeconds(settings).toFixed(1)} s`;
    app.$('metaProfile').textContent = app.state.profileLabel;
    app.$('melodyDetails').textContent = `${settings.motifName} · ${activeNotes}/${steps} notes · ${settings.structure}`;
    app.$('handoffText').value = renderHandoff(settings);
  }

  function renderHandoff(settings) {
    switch (app.state.currentTab) {
      case 'json': return JSON.stringify(app.exporter.buildSpec(settings), null, 2);
      case 'godot': return app.exporter.buildGodot(settings);
      default: return app.exporter.buildPrompt(settings);
    }
  }

  function toast(message) {
    const element = app.$('toast');
    element.textContent = message;
    element.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.classList.remove('show'), TOAST_DURATION_MS);
  }

  /**
   * Waveform view. The animation loop only runs while audio is playing; when
   * idle a single flat frame is drawn and redrawn on resize, which keeps the
   * page from spending a frame budget on an unchanging picture.
   */
  const scope = (() => {
    let canvas = null;
    let context = null;
    let samples = new Uint8Array(0);
    let active = false;
    let frameHandle = 0;

    function draw() {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      context.strokeStyle = 'rgba(255, 255, 255, 0.055)';
      context.lineWidth = 1;
      context.beginPath();
      for (let step = 0; step < steps; step += 1) {
        const x = step / steps * rect.width;
        context.moveTo(x, 0);
        context.lineTo(x, rect.height);
      }
      context.stroke();

      const analyser = active ? app.audioState.graph?.analyser : null;
      if (analyser) {
        if (samples.length !== analyser.fftSize) samples = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(samples);
      } else {
        if (samples.length === 0) samples = new Uint8Array(2);
        samples.fill(128);
      }

      const midline = rect.height / 2;
      const lastIndex = samples.length - 1;
      context.beginPath();
      context.lineWidth = 2.2;
      context.strokeStyle = active ? '#d8ff62' : '#5c5d68';
      for (let index = 0; index <= lastIndex; index += 1) {
        const x = index / lastIndex * rect.width;
        const y = midline + (samples[index] - 128) / 128 * rect.height * 1.28;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }

    function frame() {
      frameHandle = 0;
      if (!context) return;
      draw();
      if (active) frameHandle = window.requestAnimationFrame(frame);
    }

    function requestFrame() {
      if (!frameHandle && context) frameHandle = window.requestAnimationFrame(frame);
    }

    function start() {
      canvas = app.$('scope');
      context = canvas.getContext('2d');
      if (!context) return;

      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(requestFrame).observe(canvas);
      } else {
        window.addEventListener('resize', requestFrame);
      }
      requestFrame();
    }

    function setActive(playing) {
      active = playing;
      requestFrame();
    }

    return { start, setActive };
  })();

  app.ui = Object.freeze({
    clearPlayhead,
    drawScope: scope.start,
    onGridClick,
    renderGrid,
    reportAudioError,
    setExportState,
    setPlaybackState,
    showPlayhead,
    toast,
    updateGrid,
    updateOutputs
  });
})();
