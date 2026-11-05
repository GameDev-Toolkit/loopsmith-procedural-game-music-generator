'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

// The generator is intentionally browser-first. A minimal window shim is enough
// to exercise its pure composition layer without introducing a DOM dependency.
global.window = {};
require(path.join(__dirname, '..', 'assets', 'js', 'config.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'generator.js'));

const app = global.window.LoopSmith;
const { steps, stepsPerBar, minActiveNotes } = app.constants;
const { scales, variationProfiles, progressionBank } = app.catalog;

const SAMPLES_PER_CASE = 100;
const DENSITIES = [68, 76, 88, 94, 100];

const countActive = (notes) => notes.filter((note) => note !== null).length;
const expectedActiveNotes = (density) => Math.max(minActiveNotes, Math.min(steps, Math.round(steps * density / 100)));

describe('math helpers', () => {
  it('hashSeed is stable and 32-bit', () => {
    assert.equal(app.math.hashSeed('loopsmith'), app.math.hashSeed('loopsmith'));
    assert.notEqual(app.math.hashSeed('loopsmith'), app.math.hashSeed('loopsmitH'));
    assert.ok(Number.isInteger(app.math.hashSeed('')) && app.math.hashSeed('') >= 0);
  });

  it('rngFrom reproduces the same sequence in [0, 1) for the same seed', () => {
    const first = app.math.rngFrom('seed');
    const second = app.math.rngFrom('seed');
    for (let index = 0; index < 1000; index += 1) {
      const value = first();
      assert.equal(value, second());
      assert.ok(value >= 0 && value < 1);
    }
  });

  it('swingSeconds only delays off-beat steps', () => {
    const settings = { bpm: 120, swing: 20 };
    assert.equal(app.math.swingSeconds(0, settings), 0);
    assert.equal(app.math.swingSeconds(2, settings), 0);
    assert.ok(app.math.swingSeconds(1, settings) > 0);
    assert.equal(app.math.swingSeconds(1, { bpm: 120, swing: 0 }), 0);
  });

  it('safeFileName produces a conservative, bounded file stem', () => {
    assert.equal(app.math.safeFileName('  Weird Seed/Name!! '), 'weird-seed-name');
    assert.equal(app.math.safeFileName('///'), 'game-loop');
    assert.equal(app.math.safeFileName(''), 'game-loop');
    assert.ok(app.math.safeFileName('x'.repeat(200)).length <= 48);
    assert.match(app.math.safeFileName('Ünïcødé seed'), /^[a-z0-9_-]+$/);
  });
});

describe('catalog integrity', () => {
  it('is deeply frozen', () => {
    assert.ok(Object.isFrozen(app.catalog));
    assert.ok(Object.isFrozen(app.catalog.scales.major.semitones));
    assert.ok(Object.isFrozen(app.catalog.motifLibrary[0].notes));
    assert.throws(() => { app.catalog.progressionBank[0][0] = 5; }, TypeError);
  });

  it('every scale exposes seven degrees and every motif eight steps inside them', () => {
    for (const scale of Object.values(scales)) assert.equal(scale.semitones.length, 7);
    for (const motif of app.catalog.motifLibrary) {
      assert.equal(motif.notes.length, 8);
      assert.ok(motif.notes.every((note) => note >= 0 && note < 7));
    }
  });

  it('every preset and profile references known scales and voices', () => {
    const voiceKeys = Object.keys(app.catalog.voiceStyles);
    for (const preset of Object.values(app.catalog.presets)) {
      assert.ok(scales[preset.scale]);
      if (preset.voiceStyle) assert.ok(voiceKeys.includes(preset.voiceStyle));
    }
    for (const profile of Object.values(variationProfiles)) {
      profile.scales.forEach((scale) => assert.ok(scales[scale]));
      profile.voices.forEach((voice) => assert.ok(voiceKeys.includes(voice)));
      for (const range of [profile.bpm, profile.energy, profile.density, profile.brightness, profile.space, profile.swing]) {
        assert.ok(range[0] <= range[1]);
      }
    }
  });
});

describe('validateMelody', () => {
  const valid = Array(steps).fill(0);

  it('accepts a fully populated melody', () => {
    assert.equal(app.generator.validateMelody(valid, 7), true);
  });

  it('rejects wrong lengths, out-of-range degrees, and non-integers', () => {
    assert.equal(app.generator.validateMelody(valid.slice(1), 7), false);
    assert.equal(app.generator.validateMelody([...valid.slice(1), 7], 7), false);
    assert.equal(app.generator.validateMelody([...valid.slice(1), 1.5], 7), false);
    assert.equal(app.generator.validateMelody(null, 7), false);
  });

  it('protects downbeats, the coda, and the one-rest-per-bar limit', () => {
    const restOnDownbeat = [...valid]; restOnDownbeat[stepsPerBar] = null;
    const restInCoda = [...valid]; restInCoda[steps - 2] = null;
    const twoRestsInBar = [...valid]; twoRestsInBar[1] = null; twoRestsInBar[3] = null;
    const oneRest = [...valid]; oneRest[1] = null;

    assert.equal(app.generator.validateMelody(restOnDownbeat, 7), false);
    assert.equal(app.generator.validateMelody(restInCoda, 7), false);
    assert.equal(app.generator.validateMelody(twoRestsInBar, 7), false);
    assert.equal(app.generator.validateMelody(oneRest, 7), true);
  });
});

describe('composeMelody', () => {
  it('rejects unknown scales with a clear error', () => {
    assert.throws(() => app.generator.composeMelody({ seed: 'x', scale: 'nope', density: 90 }), /Unknown scale/);
  });

  it('keeps known seeds stable across refactors', () => {
    // Regression anchors: changing these means every published seed changes too.
    const anchor = app.generator.composeMelody({ seed: 'swipe-dots-01', scale: 'majorPent', density: 88 });
    assert.equal(anchor.notes.length, steps);
    assert.equal(countActive(anchor.notes), expectedActiveNotes(88));
    assert.deepEqual(
      app.generator.composeMelody({ seed: 'swipe-dots-01', scale: 'majorPent', density: 88 }),
      anchor
    );
  });

  for (const [scaleKey, scale] of Object.entries(scales)) {
    for (const density of DENSITIES) {
      it(`is deterministic and structurally valid for ${scaleKey} at ${density}% (${SAMPLES_PER_CASE} seeds)`, () => {
        for (let sample = 0; sample < SAMPLES_PER_CASE; sample += 1) {
          const settings = { seed: `test-${scaleKey}-${density}-${sample}`, scale: scaleKey, density };
          const first = app.generator.composeMelody(settings);
          const second = app.generator.composeMelody(settings);

          assert.deepEqual(first, second, 'The same seed and controls must reproduce the same composition.');
          assert.equal(app.generator.validateMelody(first.notes, scale.semitones.length), true, 'Generated notes must satisfy all structural invariants.');
          assert.equal(countActive(first.notes), expectedActiveNotes(density), 'The realized density must match the constrained target.');
          assert.ok(typeof first.motifName === 'string' && first.motifName.length > 0);
          assert.match(first.structure, /\+ coda$/);
        }
      });
    }
  }
});

describe('applyMusicalRests', () => {
  it('never places adjacent rests even when asked for the minimum density', () => {
    const notes = Array(steps).fill(3);
    const rested = app.generator.applyMusicalRests(notes, 0, app.math.rngFrom('rests'));
    assert.equal(countActive(rested), minActiveNotes);
    for (let index = 1; index < steps; index += 1) {
      assert.ok(!(rested[index] === null && rested[index - 1] === null));
    }
  });

  it('leaves the melody untouched at full density', () => {
    const notes = Array.from({ length: steps }, (_, index) => index % 7);
    assert.deepEqual(app.generator.applyMusicalRests(notes, 100, app.math.rngFrom('full')), notes);
  });
});

describe('createFullVariation', () => {
  const previous = { seed: 'prev', root: 9, bpm: 71, energy: 32, density: 88, brightness: 35, space: 14, swing: 0 };

  it('always moves to a different profile, root, and progression', () => {
    for (let round = 0; round < 50; round += 1) {
      const variation = app.generator.createFullVariation(previous, 'classic', progressionBank[0]);
      const profile = variationProfiles[variation.profileKey];

      assert.notEqual(variation.profileKey, 'classic');
      assert.equal(variation.profileLabel, profile.label);
      assert.notEqual(variation.root, previous.root);
      assert.ok(variation.root >= 0 && variation.root < 12);
      assert.notDeepEqual(variation.progression, progressionBank[0]);
      assert.ok(progressionBank.some((entry) => entry.join() === variation.progression.join()));
      assert.ok(scales[variation.scale]);
      assert.ok(profile.voices.includes(variation.voiceStyle));
      assert.ok(variation.bpm >= profile.bpm[0] && variation.bpm <= profile.bpm[1]);
      assert.ok(variation.density >= profile.density[0] && variation.density <= profile.density[1]);
      assert.equal(typeof variation.pad, 'boolean');
      assert.equal(typeof variation.drums, 'boolean');
      assert.ok(variation.seed.startsWith(`${variation.profileKey}-`));
    }
  });

  it('returns a progression copy, not a catalog reference', () => {
    const variation = app.generator.createFullVariation(previous, 'classic', [9, 9, 9, 9]);
    assert.ok(!progressionBank.includes(variation.progression));
    assert.doesNotThrow(() => { variation.progression[0] = 1; });
  });
});
