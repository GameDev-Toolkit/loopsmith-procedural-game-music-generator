(() => {
  'use strict';

  const app = window.LoopSmith;
  const { steps } = app.constants;
  const { presets, presetLabels } = app.catalog;

  const DEFAULT_VOICE_STYLE = 'bell';
  const ORIGINAL_MOTIF_NAME = 'Game Arc';
  const ORIGINAL_STRUCTURE = 'Original repeating theme';

  /** Pushes a settings-like object into the form controls and session state. Missing keys are left untouched. */
  function writeSettings(values) {
    app.$('seed').value = values.seed;
    app.$('root').value = values.root;
    app.$('scale').value = values.scale;
    app.$('bpm').value = values.bpm;
    app.$('energy').value = values.energy;
    app.$('density').value = values.density;
    app.$('brightness').value = values.brightness;
    app.$('space').value = values.space;
    app.$('swing').value = values.swing;
    app.$('pad').checked = values.pad;
    app.$('drums').checked = values.drums;
    app.state.progression = [...values.progression];
    app.state.voiceStyle = values.voiceStyle || DEFAULT_VOICE_STYLE;
  }

  /** Re-renders derived UI and pushes graph-affecting controls to the live audio chain. */
  function refresh() {
    app.ui.updateOutputs();
    app.audioEngine.updateGraph();
  }

  function generateMelody(forceGenerated = false) {
    const settings = app.readSettings();
    const preset = presets[app.$('preset').value];

    if (!forceGenerated && preset?.fixed && settings.seed === preset.seed) {
      // The flagship preset ships a hand-written theme rather than a generated one.
      app.state.melody = Array.from({ length: steps }, (_, index) => preset.fixed[index % preset.fixed.length]);
      app.state.motifName = ORIGINAL_MOTIF_NAME;
      app.state.structure = ORIGINAL_STRUCTURE;
    } else {
      const composition = app.generator.composeMelody(settings);
      app.state.melody = composition.notes;
      app.state.motifName = composition.motifName;
      app.state.structure = composition.structure;
    }

    app.ui.renderGrid();
    refresh();
  }

  function applyPreset(name) {
    const preset = presets[name];
    if (!preset) return;

    writeSettings(preset);
    app.state.profileKey = name;
    app.state.profileLabel = presetLabels[name] || 'Preset';
    generateMelody();
  }

  function generateFullVariation() {
    const previousSettings = app.readSettings();
    const wasPlaying = app.audioState.playing;
    const variation = app.generator.createFullVariation(previousSettings, app.state.profileKey, app.state.progression);

    app.$('preset').value = 'random';
    writeSettings(variation);
    app.state.profileKey = variation.profileKey;
    app.state.profileLabel = variation.profileLabel;
    generateMelody(true);
    app.ui.toast(`New character: ${variation.profileLabel}`);

    if (wasPlaying) app.audioEngine.restartPlayback();
  }

  async function copyHandoff() {
    const textArea = app.$('handoffText');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(textArea.value);
    } catch (_) {
      // file:// pages and some permission policies block the async API; fall
      // back to the selection-based command before asking the user to copy manually.
      textArea.focus();
      textArea.select();
      if (!document.execCommand('copy')) {
        app.ui.toast('Select the handoff text and copy it manually');
        return;
      }
    }
    app.ui.toast('Handoff copied');
  }

  function selectTab(tab) {
    document.querySelectorAll('.tab').forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    app.state.currentTab = tab.dataset.tab;
    app.ui.updateOutputs();
  }

  function toggleHandoff() {
    const toggle = app.$('handoffToggle');
    const collapsed = toggle.closest('.handoff').classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? 'Expand' : 'Collapse';
  }

  function onKeyDown(event) {
    if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;

    const target = document.activeElement;
    const tag = target?.tagName || '';
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) || target?.isContentEditable) return;

    event.preventDefault();
    app.audioEngine.togglePlayback();
  }

  function bindEvents() {
    app.$('preset').addEventListener('change', (event) => {
      if (event.target.value === 'random') generateFullVariation();
      else applyPreset(event.target.value);
    });
    app.$('newSeed').addEventListener('click', generateFullVariation);
    app.$('generate').addEventListener('click', generateFullVariation);
    app.$('seed').addEventListener('change', () => generateMelody(true));

    // Scale and density feed the composition itself, so they regenerate on
    // commit; everything else is an arrangement parameter applied live.
    for (const id of app.controlIds) {
      if (id !== 'scale') app.$(id).addEventListener('input', refresh);
    }
    app.$('scale').addEventListener('change', () => generateMelody(true));
    app.$('density').addEventListener('change', () => generateMelody(true));

    app.$('stepGrid').addEventListener('click', app.ui.onGridClick);
    app.$('play').addEventListener('click', app.audioEngine.togglePlayback);
    app.$('exportWav').addEventListener('click', app.exporter.exportWav);
    document.querySelectorAll('[data-sfx]').forEach((button) => {
      button.addEventListener('click', () => app.audioEngine.playSfx(button.dataset.sfx));
    });

    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab)));
    app.$('copyHandoff').addEventListener('click', copyHandoff);
    app.$('downloadSpec').addEventListener('click', app.exporter.downloadSpec);
    app.$('handoffToggle').addEventListener('click', toggleHandoff);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pagehide', () => app.audioEngine.dispose());
  }

  function initialize() {
    bindEvents();
    applyPreset('original');
    app.ui.drawScope();

    if (!(window.AudioContext || window.webkitAudioContext)) {
      app.$('play').disabled = true;
      app.$('audioStatus').textContent = 'Web Audio unsupported';
      app.$('audioStatus').closest('.status').classList.add('is-error');
    }
  }

  initialize();
})();
