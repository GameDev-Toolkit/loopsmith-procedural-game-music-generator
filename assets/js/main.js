(() => {
  'use strict';

  const app = window.LoopSmith;
  const { steps } = app.constants;
  const { presets, presetLabels } = app.catalog;

  const HISTORY_LIMIT = 60;
  // Consecutive changes to a single control within this window collapse into one
  // undo entry, so dragging a slider produces one step rather than sixty.
  const HISTORY_COALESCE_MS = 450;
  const LOCATION_SYNC_DELAY_MS = 600;
  const ORIGINAL_MOTIF = 'Game Arc';
  const ORIGINAL_STRUCTURE = 'Original repeating theme';

  const history = {
    past: [],
    future: [],
    lastPushAt: 0,
    lastSignature: '',
    recording: false
  };

  let muted = false;
  let locationTimer = 0;
  let startupComplete = false;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ------------------------------------------------------------------ *
   * Undo history
   * ------------------------------------------------------------------ */

  function updateHistoryState() {
    app.ui.setHistoryState(history.past.length > 0, history.future.length > 0);
  }

  function recordHistory(previous, changed) {
    if (!history.recording || !previous || changed.size === 0) return;

    const timestamp = now();
    const signature = Array.from(changed).sort().join(',');
    const isContinuousDrag = changed.size === 1
      && !changed.has('melody')
      && signature === history.lastSignature
      && timestamp - history.lastPushAt < HISTORY_COALESCE_MS;

    if (!isContinuousDrag) {
      history.past.push(previous);
      if (history.past.length > HISTORY_LIMIT) history.past.shift();
      history.future.length = 0;
    }

    history.lastPushAt = timestamp;
    history.lastSignature = signature;
    updateHistoryState();
  }

  function applySnapshot(snapshot) {
    history.recording = false;
    history.lastSignature = '';
    try {
      app.settings.write(snapshot);
    } finally {
      history.recording = true;
    }
    updateHistoryState();
  }

  function undo() {
    const entry = history.past.pop();
    if (!entry) return;
    history.future.push(app.settings.read());
    applySnapshot(entry);
  }

  function redo() {
    const entry = history.future.pop();
    if (!entry) return;
    history.past.push(app.settings.read());
    applySnapshot(entry);
  }

  /* ------------------------------------------------------------------ *
   * Composition
   * ------------------------------------------------------------------ */

  function setPresetSelection(value) {
    const select = app.dom.require('preset');
    if (select.value !== value) select.value = value;
  }

  /** Full settings for a named preset, including the melody it implies. */
  function presetSnapshot(key) {
    const preset = presets[key];
    const base = app.settings.read();
    const values = {
      ...base,
      ...preset,
      voiceStyle: preset.voiceStyle || base.voiceStyle,
      profileKey: key,
      profileLabel: presetLabels[key] || base.profileLabel
    };

    if (preset.fixed) {
      values.melody = Array.from({ length: steps }, (_, index) => preset.fixed[index % preset.fixed.length]);
      values.motifName = ORIGINAL_MOTIF;
      values.structure = ORIGINAL_STRUCTURE;
    } else {
      const composition = app.generator.composeMelody(values);
      values.melody = composition.notes;
      values.motifName = composition.motifName;
      values.structure = composition.structure;
    }

    return values;
  }

  function applyPreset(key) {
    if (!presets[key]) return;
    setPresetSelection(key);
    app.settings.write(presetSnapshot(key));
  }

  /** Recomputes the melody from the current seed, scale, and density. */
  function regenerate() {
    const settings = app.settings.read();
    const composition = app.generator.composeMelody(settings);
    app.settings.write({
      melody: composition.notes,
      motifName: composition.motifName,
      structure: composition.structure
    });
  }

  function generateFullVariation() {
    const previous = app.settings.read();
    const wasPlaying = app.audioState.playing;
    const variation = app.generator.createFullVariation(previous, previous.profileKey, previous.progression);
    const candidate = { ...previous, ...variation };
    const composition = app.generator.composeMelody(candidate);

    app.settings.write({
      ...candidate,
      melody: composition.notes,
      motifName: composition.motifName,
      structure: composition.structure
    });
    setPresetSelection('random');
    app.ui.toast(`New character: ${variation.profileLabel}`);

    if (wasPlaying) app.audioEngine.restartPlayback();
  }

  /* ------------------------------------------------------------------ *
   * Sharing and monitoring
   * ------------------------------------------------------------------ */

  function scheduleLocationSync(settings) {
    if (!startupComplete) return;

    window.clearTimeout(locationTimer);
    locationTimer = window.setTimeout(() => {
      locationTimer = 0;
      app.session.syncLocation(app.settings.read());
    }, LOCATION_SYNC_DELAY_MS);
  }

  async function copyShareLink() {
    const settings = app.settings.read();
    const url = app.session.buildShareUrl(settings);
    const synced = app.session.syncLocation(settings);

    const copied = await app.ui.copyText(url);
    if (copied) {
      app.ui.toast('Share link copied');
      return;
    }
    app.ui.toast(synced ? 'The link is in the address bar' : 'Copying a link is blocked here');
  }

  function toggleMute() {
    muted = app.audioEngine.setMuted(!muted);
    app.ui.toast(muted ? 'Muted' : 'Sound on');
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function onSettingsChanged({ settings, previous, changed }) {
    app.ui.syncGrid(settings, previous);
    app.ui.requestOutputs(settings);
    app.audioEngine.updateGraph(settings);
    app.session.scheduleSave(settings);
    scheduleLocationSync(settings);
    recordHistory(previous, changed);
  }

  function bindControls() {
    for (const id of app.numericIds) {
      const control = app.dom.require(id);
      const publish = () => app.settings.sync();
      control.addEventListener('input', publish);
      control.addEventListener('change', publish);
    }

    const pad = app.dom.require('pad');
    const drums = app.dom.require('drums');
    pad.addEventListener('change', () => app.settings.sync());
    drums.addEventListener('change', () => app.settings.sync());

    // Composition inputs regenerate on commit; everything else is an
    // arrangement parameter that is applied live.
    app.dom.require('density').addEventListener('change', regenerate);
    app.dom.require('scale').addEventListener('change', regenerate);
    app.dom.require('seed').addEventListener('change', regenerate);

    app.dom.require('preset').addEventListener('change', (event) => {
      if (event.target.value === 'random') generateFullVariation();
      else applyPreset(event.target.value);
    });
  }

  function bindTransport() {
    app.dom.require('play').addEventListener('click', () => app.audioEngine.togglePlayback());
    app.dom.require('generate').addEventListener('click', generateFullVariation);
    app.dom.require('newSeed').addEventListener('click', generateFullVariation);
    app.dom.require('exportWav').addEventListener('click', () => app.exporter.exportWav());
    app.dom.require('downloadSpec').addEventListener('click', () => app.exporter.downloadSpec());
    app.dom.require('copyLink').addEventListener('click', copyShareLink);
    app.dom.require('undoStep').addEventListener('click', undo);
    app.dom.require('redoStep').addEventListener('click', redo);

    for (const button of document.querySelectorAll('[data-sfx]')) {
      button.addEventListener('click', () => app.audioEngine.playSfx(button.dataset.sfx));
    }
  }

  function onKeyDown(event) {
    const target = event.target;
    const tag = (target && target.tagName) || '';
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target && target.isContentEditable);
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        // Leave undo inside text fields to the browser.
        if (inField) return;
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === 'y' && !inField) {
        event.preventDefault();
        redo();
      }
      return;
    }

    if (event.altKey || event.repeat) return;

    if (event.code === 'Space') {
      if (inField || tag === 'BUTTON' || tag === 'A') return;
      event.preventDefault();
      app.audioEngine.togglePlayback();
      return;
    }

    if ((event.key === 'm' || event.key === 'M') && !inField) toggleMute();
  }

  function bindGlobalEvents() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pagehide', () => {
      app.session.flush();
      app.audioEngine.dispose();
    });
  }

  /* ------------------------------------------------------------------ *
   * Startup
   * ------------------------------------------------------------------ */

  function resolveInitialSettings() {
    const shared = app.session.readShareFromLocation();
    if (shared) {
      setPresetSelection('random');
      return { values: shared, source: 'link' };
    }

    const stored = app.session.restore();
    if (stored) {
      setPresetSelection('random');
      return { values: stored, source: 'session' };
    }

    setPresetSelection('original');
    return { values: presetSnapshot('original'), source: 'preset' };
  }

  function reportUnsupportedAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) return;

    app.dom.require('play').disabled = true;
    app.ui.setStatus('Web Audio unsupported', true);
  }

  function start() {
    app.ui.init();
    bindControls();
    bindTransport();
    bindGlobalEvents();
    app.settings.subscribe(onSettingsChanged);

    const initial = resolveInitialSettings();
    app.settings.write(initial.values);

    history.recording = true;
    startupComplete = true;
    updateHistoryState();

    const settings = app.settings.read();
    app.ui.renderOutputs(settings);
    app.audioEngine.updateGraph(settings);
    reportUnsupportedAudio();

    if (initial.source === 'session') app.ui.toast('Restored your last session');
  }

  start();
})();
