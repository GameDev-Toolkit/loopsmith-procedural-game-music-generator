'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');
const { mountDom } = require('./support/dom-shim');

// The settings module is browser-first; the form shim is enough to exercise
// validation, caching, and the change notifications the rest of the app relies on.
global.window = {};
const dom = mountDom();

require(path.join(__dirname, '..', 'assets', 'js', 'config.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'settings.js'));

const app = global.window.LoopSmith;
const { steps } = app.constants;

function reset() {
  dom.elements.get('seed').value = 'swipe-dots-01';
  dom.elements.get('root').value = '9';
  dom.elements.get('scale').value = 'majorPent';
  dom.elements.get('bpm').value = '71';
  dom.elements.get('energy').value = '32';
  dom.elements.get('density').value = '88';
  dom.elements.get('brightness').value = '35';
  dom.elements.get('space').value = '14';
  dom.elements.get('swing').value = '0';
  dom.elements.get('volume').value = '100';
  dom.elements.get('pad').checked = false;
  dom.elements.get('drums').checked = false;

  app.state.melody = Array(steps).fill(0);
  app.state.progression = [0, -3, -5, -7];
  app.state.voiceStyle = 'bell';
  app.state.motifName = 'Game Arc';
  app.state.structure = 'Original repeating theme';
  app.state.profileKey = 'original';
  app.state.profileLabel = 'Original';
  app.settings.invalidate();
  // Establish the baseline snapshot that native form events are diffed against.
  app.settings.read();
}

const setControl = (id, value) => {
  dom.elements.get(id).value = String(value);
  app.settings.invalidate();
};

beforeEach(reset);

describe('settings validation', () => {
  it('clamps numeric controls into their configured ranges', () => {
    setControl('bpm', 0);
    assert.equal(app.settings.read().bpm, 55);

    setControl('bpm', 900);
    assert.equal(app.settings.read().bpm, 150);

    setControl('density', 20);
    assert.equal(app.settings.read().density, 68);

    setControl('swing', 99);
    assert.equal(app.settings.read().swing, 35);

    setControl('volume', -10);
    assert.equal(app.settings.read().volume, 0);
  });

  it('replaces non-numeric values with the range default instead of NaN', () => {
    setControl('bpm', 'not-a-number');
    assert.equal(app.settings.read().bpm, app.ranges.bpm.fallback);

    setControl('root', '');
    assert.equal(app.settings.read().root, app.ranges.root.fallback);

    const settings = app.settings.normalize({ bpm: null, root: undefined });
    assert.equal(settings.bpm, app.ranges.bpm.fallback);
    assert.equal(Number.isFinite(app.math.stepSeconds({ bpm: NaN })), true);
  });

  it('rejects unknown scales and voice styles', () => {
    setControl('scale', 'phrygian');
    assert.equal(app.settings.read().scale, 'majorPent');

    const settings = app.settings.write({ voiceStyle: 'laser' });
    assert.equal(settings.voiceStyle, 'bell');
  });

  it('drops unknown keys from untrusted payloads', () => {
    const settings = app.settings.write({ bpm: 90, evil: '<script>', __proto__: { polluted: true } });
    assert.equal(settings.bpm, 90);
    assert.equal('evil' in settings, false);
    assert.equal({}.polluted, undefined);
  });
});

describe('melody and progression normalisation', () => {
  it('always returns exactly one legal degree per step', () => {
    const settings = app.settings.write({
      melody: [1.7, 99, -3, 'x', null, ...Array(steps).fill(2)]
    });

    assert.equal(settings.melody.length, steps);
    assert.equal(settings.melody[0], 1);
    assert.equal(settings.melody[1], 6);
    assert.equal(settings.melody[2], 0);
    assert.equal(settings.melody[3], null);
    assert.equal(settings.melody[4], null);
  });

  it('pads a short melody with rests and trims an over-long one', () => {
    const settings = app.settings.write({ melody: [0, 1, 2] });
    assert.equal(settings.melody.length, steps);
    assert.deepEqual(settings.melody.slice(0, 3), [0, 1, 2]);
    assert.equal(settings.melody[3], null);
    assert.equal(settings.melody[steps - 1], null);
  });

  it('keeps four progression steps inside a playable range', () => {
    const settings = app.settings.write({ progression: [0, -99, 99] });
    assert.deepEqual(settings.progression, [0, -12, 12, -7]);
  });

  it('exposes immutable snapshots', () => {
    const settings = app.settings.read();
    assert.equal(Object.isFrozen(settings), true);
    assert.equal(Object.isFrozen(settings.melody), true);
    assert.throws(() => { settings.melody[0] = 5; }, TypeError);
  });
});

describe('text fields', () => {
  it('strips control characters and collapses whitespace', () => {
    const settings = app.settings.write({ seed: '  evil\nseed\u0000name  ' });
    assert.equal(settings.seed, 'evil seed name');
  });

  it('bounds the seed and keeps a fallback for empty input', () => {
    assert.equal(app.settings.write({ seed: 'x'.repeat(400) }).seed.length, 96);
    assert.equal(app.settings.write({ seed: '   ' }).seed, app.settings.DEFAULTS.seed);
  });
});

describe('form synchronisation', () => {
  it('writes settings into the form controls and shared state', () => {
    app.settings.write({ bpm: 120, pad: true, root: 3, scale: 'dorian' });

    assert.equal(dom.valueOf('bpm'), '120');
    assert.equal(dom.valueOf('root'), '3');
    assert.equal(dom.valueOf('scale'), 'dorian');
    assert.equal(dom.isChecked('pad'), true);
    assert.equal(app.state.melody.length, steps);
  });

  it('publishes native form edits through sync()', () => {
    const events = [];
    const unsubscribe = app.settings.subscribe((detail) => events.push(detail));

    dom.elements.get('bpm').value = '130';
    const settings = app.settings.sync();
    unsubscribe();

    assert.equal(settings.bpm, 130);
    assert.equal(events.length, 1);
    assert.deepEqual([...events[0].changed], ['bpm']);
    assert.equal(events[0].previous.bpm, 71);
  });

  it('reports an empty change set when the form did not change', () => {
    const events = [];
    const unsubscribe = app.settings.subscribe((detail) => events.push(detail));
    app.settings.sync();
    unsubscribe();

    assert.equal(events.length, 1);
    assert.equal(events[0].changed.size, 0);
  });

  it('caches snapshots until they are invalidated', () => {
    const first = app.settings.read();
    assert.equal(app.settings.read(), first);

    dom.elements.get('bpm').value = '99';
    assert.equal(app.settings.read().bpm, 71, 'The cache must not observe unannounced DOM writes.');

    app.settings.invalidate();
    assert.equal(app.settings.read().bpm, 99);
  });

  it('keeps notifying the remaining observers when one throws', () => {
    const originalError = console.error;
    console.error = () => {};
    const received = [];
    const unsubscribeFailing = app.settings.subscribe(() => { throw new Error('observer failure'); });
    const unsubscribeHealthy = app.settings.subscribe((detail) => received.push(detail));

    assert.doesNotThrow(() => app.settings.write({ bpm: 95 }));
    unsubscribeFailing();
    unsubscribeHealthy();
    console.error = originalError;

    assert.equal(received.length, 1);
    assert.equal(received[0].settings.bpm, 95);
  });
});

describe('setNote', () => {
  it('clamps degrees and clears a step with null', () => {
    const raised = app.settings.setNote(0, 99);
    assert.equal(raised.melody[0], 6);

    const cleared = app.settings.setNote(0, null);
    assert.equal(cleared.melody[0], null);
  });

  it('ignores steps outside the sequence', () => {
    const before = app.settings.read();
    assert.equal(app.settings.setNote(-1, 3), before);
    assert.equal(app.settings.setNote(steps, 3), before);
    assert.equal(app.settings.setNote(1.5, 3), before);
  });

  it('announces a melody change', () => {
    const events = [];
    const unsubscribe = app.settings.subscribe((detail) => events.push(detail));
    app.settings.setNote(4, 2);
    unsubscribe();

    assert.equal(events.length, 1);
    assert.deepEqual([...events[0].changed], ['melody']);
    assert.equal(events[0].settings.melody[4], 2);
  });
});
