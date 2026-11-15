(() => {
  'use strict';

  const app = window.LoopSmith = window.LoopSmith || {};

  /**
   * Recursively freezes arrays and plain objects. Catalog data and tuning values
   * are shared by the generator, the audio engine, and the exporters; freezing
   * turns an accidental mutation into a loud failure in strict mode instead of a
   * silent behaviour change.
   *
   * @template T
   * @param {T} value
   * @returns {T}
   */
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
    return value;
  }

  app.constants = deepFreeze({
    steps: 36,
    stepsPerBar: 4,
    harmonySteps: 8,
    /** Generated material never contains fewer sounding notes than this. */
    minActiveNotes: 28,
    /** Fraction of a step that an off-beat note is delayed by when swing is requested. */
    swingDepth: 0.45,
    melodyBaseMidi: 48,
    bassBaseMidi: 36,
    /** Bumped whenever a change to the generator alters the output of existing seeds. */
    generatorVersion: 3
  });

  /**
   * Valid ranges for every numeric control. Values are clamped through these
   * definitions whenever settings are read from the form, written by code,
   * restored from storage, or decoded from a shared link. This is the only place
   * that decides what a legal tempo, density, or volume is.
   */
  app.ranges = deepFreeze({
    root: { min: 0, max: 11, fallback: 9 },
    bpm: { min: 55, max: 150, fallback: 71 },
    energy: { min: 0, max: 100, fallback: 32 },
    density: { min: 68, max: 100, fallback: 88 },
    brightness: { min: 0, max: 100, fallback: 35 },
    space: { min: 0, max: 100, fallback: 14 },
    swing: { min: 0, max: 35, fallback: 0 },
    volume: { min: 0, max: 100, fallback: 100 }
  });

  /** Form controls that hold a numeric value, in the order the UI presents them. */
  app.numericIds = Object.freeze(['root', 'bpm', 'energy', 'density', 'brightness', 'space', 'swing', 'volume']);

  /** Numeric controls that are presented with a live read-out. */
  app.outputIds = Object.freeze(['bpm', 'energy', 'density', 'brightness', 'space', 'swing', 'volume']);

  /**
   * Engine tuning. Keeping these in one frozen table avoids magic numbers spread
   * across the scheduler, the voice builders, and the offline renderer, and makes
   * the difference between live and offline rendering explicit.
   */
  app.tuning = deepFreeze({
    scheduler: {
      intervalMs: 25,
      lookAheadSeconds: 0.12,
      // Background tabs throttle timers to roughly one call per second, so the
      // scheduling window is widened there to avoid audible gaps.
      hiddenLookAheadSeconds: 1.5,
      startLatencySeconds: 0.06,
      // Resynchronise instead of emitting a burst of overdue steps after a stall.
      maxCatchUpSeconds: 0.5
    },
    audio: {
      masterGain: 0.62,
      minGain: 0.0001,
      filterQ: 0.35,
      dryGain: 0.94,
      reverbSendScale: 0.42,
      impulseSeed: 'loopsmith-room-v1',
      impulseSeconds: 1.7,
      impulseDecay: 2.7,
      hatSeconds: 0.045,
      stopFadeSeconds: 0.035
    },
    export: {
      sampleRate: 44100,
      repeats: 2,
      tailSeconds: 2,
      headerBytes: 44
    }
  });

  app.catalog = deepFreeze({
    noteNames: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
    scales: {
      majorPent: { label: 'major pentatonic', short: 'major pentatonic', semitones: [0, 2, 4, 7, 9, 12, 14] },
      minorPent: { label: 'minor pentatonic', short: 'minor pentatonic', semitones: [0, 3, 5, 7, 10, 12, 15] },
      dorian: { label: 'Dorian', short: 'dorian', semitones: [0, 2, 3, 5, 7, 9, 10] },
      major: { label: 'major', short: 'major', semitones: [0, 2, 4, 5, 7, 9, 11] }
    },
    presets: {
      original: { seed: 'swipe-dots-01', root: 9, scale: 'majorPent', bpm: 71, energy: 32, density: 88, brightness: 35, space: 14, swing: 0, pad: false, drums: false, progression: [0, -3, -5, -7], fixed: [0, 2, 4, 3, 5, 2, 4, 1, 0, 2, 4, 3, 5, 2, 4, 1] },
      calm: { seed: 'quiet-orbit-24', root: 2, scale: 'majorPent', bpm: 78, energy: 28, density: 84, brightness: 42, space: 48, swing: 5, pad: true, drums: false, progression: [0, -5, -3, -7], voiceStyle: 'warm' },
      arcade: { seed: 'neon-pulse-88', root: 6, scale: 'majorPent', bpm: 108, energy: 68, density: 94, brightness: 76, space: 24, swing: 10, pad: false, drums: true, progression: [0, -5, -2, -7], voiceStyle: 'crystal' },
      mystery: { seed: 'soft-riddle-17', root: 0, scale: 'dorian', bpm: 74, energy: 38, density: 80, brightness: 30, space: 60, swing: 8, pad: true, drums: false, progression: [0, -2, -5, -3], voiceStyle: 'soft' },
      focus: { seed: 'clean-focus-06', root: 4, scale: 'majorPent', bpm: 92, energy: 44, density: 90, brightness: 58, space: 30, swing: 0, pad: true, drums: false, progression: [0, -5, -3, -5], voiceStyle: 'bell' }
    },
    presetLabels: { original: 'Original', calm: 'Calm', arcade: 'Neon', mystery: 'Mystery', focus: 'Focus' },

    // Profiles describe coherent musical regions, not fixed songs. Repeated
    // entries intentionally bias the generator toward the project's bright
    // puzzle-game identity.
    variationProfiles: {
      classic: { label: 'Classic Dots', bpm: [64, 82], energy: [26, 48], density: [88, 100], brightness: [24, 48], space: [6, 24], swing: [0, 4], scales: ['majorPent', 'majorPent', 'majorPent', 'major'], pad: [false], drums: [false], voices: ['bell'] },
      morning: { label: 'Morning Puzzle', bpm: [70, 90], energy: [30, 54], density: [82, 96], brightness: [38, 62], space: [12, 34], swing: [0, 7], scales: ['majorPent', 'majorPent', 'major'], pad: [false, true], drums: [false], voices: ['bell', 'warm'] },
      glass: { label: 'Glass Garden', bpm: [62, 84], energy: [24, 46], density: [80, 94], brightness: [60, 86], space: [34, 62], swing: [0, 8], scales: ['majorPent', 'majorPent', 'dorian'], pad: [true], drums: [false], voices: ['glass', 'crystal'] },
      playful: { label: 'Playful Steps', bpm: [84, 108], energy: [48, 72], density: [88, 100], brightness: [50, 76], space: [8, 30], swing: [4, 14], scales: ['majorPent', 'majorPent', 'major'], pad: [false], drums: [false, true], voices: ['bell', 'pluck'] },
      moonlit: { label: 'Moonlit Logic', bpm: [60, 80], energy: [20, 42], density: [76, 90], brightness: [20, 46], space: [40, 68], swing: [0, 9], scales: ['minorPent', 'dorian', 'majorPent'], pad: [true], drums: [false], voices: ['soft', 'bell'] },
      momentum: { label: 'Soft Momentum', bpm: [78, 100], energy: [42, 66], density: [84, 98], brightness: [32, 60], space: [16, 40], swing: [6, 16], scales: ['majorPent', 'dorian', 'majorPent'], pad: [false, true], drums: [false], voices: ['warm', 'pluck'] },
      bright: { label: 'Bright Combo', bpm: [88, 112], energy: [54, 78], density: [90, 100], brightness: [66, 90], space: [8, 28], swing: [0, 8], scales: ['majorPent', 'major', 'majorPent'], pad: [false], drums: [true, false], voices: ['crystal', 'bell'] },
      clockwork: { label: 'Clockwork Calm', bpm: [90, 112], energy: [38, 62], density: [92, 100], brightness: [42, 68], space: [6, 22], swing: [0, 3], scales: ['majorPent', 'major'], pad: [false], drums: [false, true], voices: ['pluck', 'bell'] },
      curious: { label: 'Curious Bounce', bpm: [76, 98], energy: [42, 68], density: [80, 94], brightness: [48, 76], space: [18, 44], swing: [10, 20], scales: ['majorPent', 'dorian', 'majorPent'], pad: [false], drums: [false, true], voices: ['pluck', 'glass'] },
      floating: { label: 'Floating Focus', bpm: [58, 78], energy: [18, 38], density: [74, 88], brightness: [28, 56], space: [48, 72], swing: [2, 10], scales: ['majorPent', 'majorPent', 'major'], pad: [true], drums: [false], voices: ['soft', 'warm'] },
      circuit: { label: 'Warm Circuit', bpm: [72, 94], energy: [34, 58], density: [84, 96], brightness: [18, 44], space: [18, 38], swing: [0, 10], scales: ['majorPent', 'major', 'majorPent'], pad: [false, true], drums: [false], voices: ['warm', 'bell'] },
      drift: { label: 'Crystal Drift', bpm: [66, 88], energy: [28, 54], density: [78, 92], brightness: [70, 94], space: [42, 70], swing: [4, 13], scales: ['majorPent', 'dorian'], pad: [true], drums: [false], voices: ['crystal', 'glass'] },
      twilight: { label: 'Twilight Puzzle', bpm: [64, 86], energy: [30, 56], density: [76, 92], brightness: [24, 54], space: [30, 58], swing: [3, 12], scales: ['minorPent', 'dorian'], pad: [true, false], drums: [false], voices: ['soft', 'bell'] },
      tiny: { label: 'Tiny Machines', bpm: [96, 118], energy: [50, 76], density: [90, 100], brightness: [54, 82], space: [6, 24], swing: [0, 6], scales: ['majorPent', 'major'], pad: [false], drums: [true, false], voices: ['pluck', 'crystal'] },
      meadow: { label: 'Digital Meadow', bpm: [68, 92], energy: [28, 52], density: [82, 96], brightness: [36, 66], space: [28, 54], swing: [2, 11], scales: ['majorPent', 'majorPent', 'major'], pad: [true, false], drums: [false], voices: ['bell', 'glass'] },
      wonder: { label: 'Gentle Wonder', bpm: [60, 82], energy: [22, 46], density: [80, 94], brightness: [44, 72], space: [38, 66], swing: [0, 8], scales: ['majorPent', 'majorPent', 'dorian'], pad: [true], drums: [false], voices: ['bell', 'crystal'] }
    },
    progressionBank: [
      [0, -3, -5, -7], [0, -5, -7, -3], [0, -7, -5, -3], [0, -3, -7, -5],
      [0, -5, -3, -7], [0, -2, -5, -7], [0, -3, -5, -2], [0, -5, -2, -7],
      [0, -2, -7, -5], [0, -7, -3, -5], [0, -5, -7, -5], [0, -3, -5, -3],
      [0, 2, -3, -5], [0, -2, -3, -7], [0, -5, -3, -2], [0, -7, -5, -7],
      [0, -3, -2, -5], [0, -2, -5, -3], [0, -5, -2, -3], [0, -7, -2, -5],
      [0, -3, -7, -2], [0, -2, -7, -3], [0, -5, -7, -2], [0, -7, -3, -2]
    ],
    motifLibrary: [
      { name: 'Game Arc', notes: [0, 2, 4, 3, 5, 2, 4, 1] },
      { name: 'Small Climb', notes: [0, 1, 3, 2, 4, 2, 3, 1] },
      { name: 'High Answer', notes: [2, 4, 5, 3, 4, 2, 3, 0] },
      { name: 'Round Trip', notes: [0, 3, 2, 4, 3, 5, 2, 1] },
      { name: 'Falling Light', notes: [1, 3, 5, 4, 2, 4, 3, 0] },
      { name: 'Skip And Return', notes: [0, 2, 1, 4, 3, 5, 4, 2] },
      { name: 'Gentle Zigzag', notes: [3, 1, 2, 4, 3, 5, 2, 0] },
      { name: 'Wide Spark', notes: [0, 4, 2, 5, 3, 4, 1, 2] },
      { name: 'Soft Descent', notes: [2, 3, 5, 4, 2, 1, 3, 0] },
      { name: 'Growing Line', notes: [0, 1, 2, 4, 5, 3, 2, 1] },
      { name: 'Question Mark', notes: [1, 4, 3, 5, 2, 4, 1, 0] },
      { name: 'Bright Fold', notes: [0, 2, 5, 4, 3, 1, 4, 2] },
      { name: 'Falling Steps', notes: [2, 5, 4, 1, 3, 0, 2, 1] },
      { name: 'Open Window', notes: [0, 3, 5, 2, 4, 1, 3, 2] },
      { name: 'Little Ladder', notes: [1, 2, 4, 5, 3, 4, 2, 0] },
      { name: 'Pocket Theme', notes: [0, 2, 4, 1, 3, 5, 2, 1] }
    ],
    voiceStyles: {
      bell: { primary: 'sine', harmonicRatio: 2, harmonicGain: 1 },
      warm: { primary: 'sine', harmonicRatio: 2, harmonicGain: 0.55 },
      glass: { primary: 'sine', harmonicRatio: 2.72, harmonicGain: 0.72 },
      crystal: { primary: 'sine', harmonicRatio: 3.01, harmonicGain: 0.62 },
      pluck: { primary: 'triangle', harmonicRatio: 2, harmonicGain: 0.42 },
      soft: { primary: 'sine', harmonicRatio: 1.5, harmonicGain: 0.34 }
    }
  });

  /**
   * Session state that has no form control of its own. Everything else is read
   * from the form by the settings module, which keeps a single source of truth.
   */
  app.state = {
    progression: [0, -3, -5, -7],
    melody: Array(app.constants.steps).fill(0),
    currentTab: 'prompt',
    profileKey: 'original',
    profileLabel: 'Original',
    voiceStyle: 'bell',
    motifName: 'Game Arc',
    structure: 'Original repeating theme'
  };

  /** Live audio objects. Only the audio engine writes here; the UI reads `playing` and `graph`. */
  app.audioState = {
    context: null,
    graph: null,
    starting: null,
    schedulerTimer: null,
    nextStepTime: 0,
    step: 0,
    playing: false,
    sources: new Set()
  };

  /**
   * Element lookup cache. Elements are resolved once and reused, which keeps
   * hot paths (the scheduler, the playhead) free of repeated tree walks.
   */
  const elementCache = new Map();

  app.dom = Object.freeze({
    /** @param {string} id */
    get(id) {
      let element = elementCache.get(id);
      if (element === undefined) {
        element = typeof document === 'undefined' ? null : document.getElementById(id);
        if (element) elementCache.set(id, element);
      }
      return element;
    },
    /** Resolves an element that the application cannot work without. */
    require(id) {
      const element = app.dom.get(id);
      if (!element) throw new Error(`Missing required element #${id}.`);
      return element;
    },
    /** Clears the cache; used by tests that mount a fresh document. */
    reset() {
      elementCache.clear();
    }
  });

  /** Shorthand used across the UI layer. */
  app.$ = app.dom.get;

  app.math = Object.freeze({
    /**
     * Clamps a finite number into an inclusive range.
     * @param {number} value
     * @param {number} min
     * @param {number} max
     */
    clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    },

    /**
     * Coerces arbitrary input into an integer inside a configured range. Only
     * numbers and numeric strings are accepted; everything else (null, empty
     * strings, booleans, objects) falls back to the range default instead of
     * producing NaN or a silent zero.
     *
     * @param {unknown} value
     * @param {{min: number, max: number, fallback: number}} range
     */
    toInteger(value, range) {
      let numeric = NaN;
      if (typeof value === 'number') numeric = value;
      else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);

      if (!Number.isFinite(numeric)) return range.fallback;
      return app.math.clamp(Math.round(numeric), range.min, range.max);
    },

    /** 32-bit FNV-1a. Fast, dependency-free, and stable across engines. */
    hashSeed(value) {
      const text = String(value);
      let hash = 2166136261 >>> 0;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    },

    /** Mulberry32 seeded with hashSeed(); returns a float in [0, 1). */
    rngFrom(seed) {
      let state = app.math.hashSeed(seed);
      return () => {
        state |= 0;
        state = state + 0x6D2B79F5 | 0;
        let value = Math.imul(state ^ state >>> 15, 1 | state);
        value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
      };
    },

    /** Equal-tempered frequency of a MIDI note number. */
    midiHz(midi) {
      return 440 * Math.pow(2, (midi - 69) / 12);
    },

    /** Pitch-class name for a MIDI note number. */
    midiToNoteName(midi) {
      const names = app.catalog.noteNames;
      return names[((Math.round(midi) % 12) + 12) % 12];
    },

    /** Duration of one sequencer step in seconds. */
    stepSeconds(settings) {
      const bpm = app.math.toInteger(settings && settings.bpm, app.ranges.bpm);
      return 30 / bpm;
    },

    /** Duration of one full pass through the sequence in seconds. */
    loopSeconds(settings) {
      return app.math.stepSeconds(settings) * app.constants.steps;
    },

    /** Number of sounding steps in a melody (rests are `null`). */
    activeNoteCount(melody) {
      let count = 0;
      for (const note of melody) if (note !== null) count += 1;
      return count;
    },

    /** Delay applied to odd steps so live playback and offline export share one swing feel. */
    swingSeconds(step, settings) {
      if (step % 2 === 0) return 0;
      const swing = app.math.toInteger(settings && settings.swing, app.ranges.swing);
      return app.math.stepSeconds(settings) * (swing / 100) * app.constants.swingDepth;
    },

    /** Reduces arbitrary text to a conservative, cross-platform file-name stem. */
    safeFileName(value) {
      const stem = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
      return stem || 'game-loop';
    },

    /** Short non-deterministic token, used only to seed "change everything" variations. */
    entropyToken() {
      const cryptoApi = globalThis.crypto;
      if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        const values = new Uint32Array(2);
        cryptoApi.getRandomValues(values);
        return `${values[0].toString(36)}${values[1].toString(36)}`.slice(0, 12);
      }
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`.slice(-12);
    }
  });
})();
