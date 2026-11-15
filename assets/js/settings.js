(() => {
  'use strict';

  const app = window.LoopSmith;
  const { steps } = app.constants;
  const { scales, voiceStyles, presets, presetLabels } = app.catalog;

  const SCALE_KEYS = Object.freeze(Object.keys(scales));
  const VOICE_KEYS = Object.freeze(Object.keys(voiceStyles));
  const DEFAULT_PROGRESSION = Object.freeze([0, -3, -5, -7]);
  const MAX_SEED_LENGTH = 96;
  const MAX_LABEL_LENGTH = 64;
  const MAX_STRUCTURE_LENGTH = 96;

  /**
   * @typedef {Object} Settings
   * @property {string} seed            Reproduces the melodic decisions.
   * @property {number} root            Pitch class of the tonic, 0-11.
   * @property {string} scale           Key from `catalog.scales`.
   * @property {number} bpm             55-150.
   * @property {number} energy          0-100.
   * @property {number} density         68-100.
   * @property {number} brightness      0-100.
   * @property {number} space           0-100.
   * @property {number} swing           0-35.
   * @property {number} volume          0-100 monitor level; never affects exports.
   * @property {boolean} pad
   * @property {boolean} drums
   * @property {string} voiceStyle      Key from `catalog.voiceStyles`.
   * @property {string} motifName
   * @property {string} structure
   * @property {string} profileKey
   * @property {string} profileLabel
   * @property {number[]} progression   Four semitone offsets, cycled every eight steps.
   * @property {Array<number|null>} melody  Exactly `steps` scale degrees; `null` is a rest.
   */

  const ORIGINAL = presets.original;

  /** Baseline for a form that has never been written by the application. */
  const DEFAULTS = Object.freeze({
    seed: ORIGINAL.seed,
    root: ORIGINAL.root,
    scale: ORIGINAL.scale,
    bpm: ORIGINAL.bpm,
    energy: ORIGINAL.energy,
    density: ORIGINAL.density,
    brightness: ORIGINAL.brightness,
    space: ORIGINAL.space,
    swing: ORIGINAL.swing,
    volume: app.ranges.volume.fallback,
    pad: ORIGINAL.pad,
    drums: ORIGINAL.drums,
    voiceStyle: ORIGINAL.voiceStyle || 'bell',
    motifName: 'Game Arc',
    structure: 'Original repeating theme',
    profileKey: 'original',
    profileLabel: presetLabels.original || 'Original',
    progression: ORIGINAL.progression,
    melody: Object.freeze(Array(steps).fill(0))
  });

  /** @type {Settings|null} */
  let snapshot = null;
  const listeners = new Set();

  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  /**
   * Normalises free-form text. Control characters are removed because seeds and
   * motif names are interpolated into downloadable handoff files.
   */
  function normalizeText(value, fallback, maxLength = MAX_LABEL_LENGTH) {
    if (typeof value !== 'string') return fallback;
    const text = value
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
    return text || fallback;
  }

  function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return fallback;
  }

  /**
   * Coerces a melody of arbitrary length into exactly `steps` legal degrees.
   * Invalid entries become rests, which is always musically safe.
   *
   * @param {unknown} value
   * @param {number} degreeCount
   * @param {Array<number|null>} fallback
   */
  function normalizeMelody(value, degreeCount, fallback) {
    const source = Array.isArray(value) ? value : fallback;
    const limit = Math.max(1, degreeCount) - 1;
    const melody = new Array(steps);

    for (let index = 0; index < steps; index += 1) {
      const note = source[index];
      if (note === null || note === undefined) {
        melody[index] = null;
        continue;
      }
      const numeric = Number(note);
      melody[index] = Number.isFinite(numeric)
        ? app.math.clamp(Math.trunc(numeric), 0, limit)
        : null;
    }

    return melody;
  }

  /** Four semitone offsets, clamped to a musical range that cannot leave the keyboard. */
  function normalizeProgression(value) {
    const source = Array.isArray(value) ? value : DEFAULT_PROGRESSION;
    const progression = new Array(DEFAULT_PROGRESSION.length);

    for (let index = 0; index < DEFAULT_PROGRESSION.length; index += 1) {
      const numeric = Number(source[index]);
      progression[index] = Number.isFinite(numeric)
        ? app.math.clamp(Math.trunc(numeric), -12, 12)
        : DEFAULT_PROGRESSION[index];
    }

    return progression;
  }

  /**
   * Validates an arbitrary object into a complete, immutable Settings snapshot.
   * This is the single gate between untrusted input (form values, restored
   * sessions, shared links) and every consumer of the musical model.
   *
   * @param {unknown} input
   * @returns {Settings}
   */
  function normalize(input) {
    const source = isPlainObject(input) ? input : {};
    const scale = SCALE_KEYS.includes(source.scale) ? source.scale : DEFAULTS.scale;
    const degreeCount = scales[scale].semitones.length;

    /** @type {Settings} */
    const settings = {
      seed: normalizeText(source.seed, DEFAULTS.seed, MAX_SEED_LENGTH),
      root: app.math.toInteger(source.root, app.ranges.root),
      scale,
      bpm: app.math.toInteger(source.bpm, app.ranges.bpm),
      energy: app.math.toInteger(source.energy, app.ranges.energy),
      density: app.math.toInteger(source.density, app.ranges.density),
      brightness: app.math.toInteger(source.brightness, app.ranges.brightness),
      space: app.math.toInteger(source.space, app.ranges.space),
      swing: app.math.toInteger(source.swing, app.ranges.swing),
      volume: app.math.toInteger(source.volume, app.ranges.volume),
      pad: normalizeBoolean(source.pad, DEFAULTS.pad),
      drums: normalizeBoolean(source.drums, DEFAULTS.drums),
      voiceStyle: VOICE_KEYS.includes(source.voiceStyle) ? source.voiceStyle : DEFAULTS.voiceStyle,
      motifName: normalizeText(source.motifName, DEFAULTS.motifName),
      structure: normalizeText(source.structure, DEFAULTS.structure, MAX_STRUCTURE_LENGTH),
      profileKey: normalizeText(source.profileKey, DEFAULTS.profileKey),
      profileLabel: normalizeText(source.profileLabel, DEFAULTS.profileLabel),
      progression: Object.freeze(normalizeProgression(source.progression)),
      melody: Object.freeze(normalizeMelody(source.melody, degreeCount, DEFAULTS.melody))
    };

    return Object.freeze(settings);
  }

  /** Reads the current settings, building and caching the snapshot on first use. */
  function read() {
    if (snapshot) return snapshot;

    const source = {
      seed: app.dom.require('seed').value,
      scale: app.dom.require('scale').value,
      pad: app.dom.require('pad').checked,
      drums: app.dom.require('drums').checked,
      melody: app.state.melody,
      progression: app.state.progression,
      voiceStyle: app.state.voiceStyle,
      motifName: app.state.motifName,
      structure: app.state.structure,
      profileKey: app.state.profileKey,
      profileLabel: app.state.profileLabel
    };
    for (const id of app.numericIds) source[id] = app.dom.require(id).value;

    snapshot = normalize(source);
    return snapshot;
  }

  /**
   * Pushes a normalised snapshot into the form and the shared state. Callers see
   * the result through `subscribe()`; nothing reads the form directly afterwards.
   *
   * @param {Settings} settings
   */
  function apply(settings) {
    app.dom.require('seed').value = settings.seed;
    app.dom.require('scale').value = settings.scale;
    for (const id of app.numericIds) app.dom.require(id).value = String(settings[id]);
    app.dom.require('pad').checked = settings.pad;
    app.dom.require('drums').checked = settings.drums;

    app.state.melody = [...settings.melody];
    app.state.progression = [...settings.progression];
    app.state.voiceStyle = settings.voiceStyle;
    app.state.motifName = settings.motifName;
    app.state.structure = settings.structure;
    app.state.profileKey = settings.profileKey;
    app.state.profileLabel = settings.profileLabel;
  }

  const sameArray = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  };

  /** @returns {Set<keyof Settings>} */
  function diff(previous, next) {
    const changed = new Set();
    for (const key of Object.keys(next)) {
      const before = previous[key];
      const after = next[key];
      const equal = Array.isArray(after) ? sameArray(before, after) : before === after;
      if (!equal) changed.add(key);
    }
    return changed;
  }

  function notify(settings, previous) {
    const changed = previous ? diff(previous, settings) : new Set(Object.keys(settings));
    for (const listener of listeners) {
      try {
        listener({ settings, previous: previous || null, changed });
      } catch (error) {
        // A failing observer must not prevent the remaining observers from
        // updating, and must never leave the musical model half-applied.
        console.error('Settings listener failed', error);
      }
    }
  }

  /**
   * Applies a partial change and notifies observers. Unknown keys are dropped by
   * `normalize`, so untrusted payloads cannot extend the model.
   *
   * @param {Partial<Settings>} partial
   * @returns {Settings}
   */
  function write(partial) {
    const previous = read();
    const next = normalize({ ...previous, ...(isPlainObject(partial) ? partial : {}) });
    apply(next);
    snapshot = next;
    notify(next, previous);
    return next;
  }

  /**
   * Re-reads the form after a native input event and publishes the difference.
   * Form controls are the origin of user edits, so every input handler calls
   * this instead of touching the cached snapshot.
   *
   * @returns {Settings}
   */
  function sync() {
    const previous = snapshot;
    snapshot = null;
    const next = read();
    notify(next, previous);
    return next;
  }

  /** Drops the cache so the next read re-validates the form. */
  function invalidate() {
    snapshot = null;
  }

  /**
   * Sets or clears a single sequencer step. Out-of-range degrees are clamped and
   * invalid steps are ignored, which keeps the grid and the model in sync even
   * with a malformed event payload.
   *
   * @param {number} step
   * @param {number|null} degree
   */
  function setNote(step, degree) {
    const current = read();
    if (!Number.isInteger(step) || step < 0 || step >= steps) return current;

    const melody = [...current.melody];
    const limit = scales[current.scale].semitones.length - 1;
    melody[step] = degree === null ? null : app.math.clamp(Math.trunc(Number(degree)), 0, limit);
    return write({ melody });
  }

  /**
   * Registers an observer. Listeners run synchronously in registration order.
   * @param {(detail: {settings: Settings, previous: Settings|null, changed: Set<string>}) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('A settings listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  app.settings = Object.freeze({
    DEFAULTS,
    invalidate,
    normalize,
    read,
    setNote,
    subscribe,
    sync,
    write
  });
})();
