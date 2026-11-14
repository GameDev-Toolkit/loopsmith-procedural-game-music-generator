'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');

const STORED_KEY = 'loopsmith.session.v1';

/** In-memory stand-in for window.localStorage. */
function createStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); }
  };
}

function createWindow(storage) {
  return {
    localStorage: storage,
    location: { href: 'https://example.test/studio/index.html?mode=studio', hash: '' },
    history: {
      state: null,
      lastUrl: '',
      replaceState(state, title, url) { this.state = state; this.lastUrl = url; }
    },
    setTimeout,
    clearTimeout
  };
}

const storage = createStorage();
global.window = createWindow(storage);

require(path.join(__dirname, '..', 'assets', 'js', 'config.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'session.js'));

const app = global.window.LoopSmith;

const sampleSettings = {
  seed: 'Ünïcødé seed — 01',
  root: 3,
  scale: 'dorian',
  bpm: 96,
  energy: 44,
  density: 92,
  brightness: 58,
  space: 26,
  swing: 7,
  volume: 80,
  pad: true,
  drums: false,
  voiceStyle: 'warm',
  motifName: 'Bright Fold',
  structure: 'A B A′ B′ + coda',
  profileKey: 'circuit',
  profileLabel: 'Warm Circuit',
  progression: [0, -5, -3, -7],
  melody: [0, 2, null, 4, 5, null, 1, 3]
};

beforeEach(() => {
  storage.values.clear();
  global.window.location.hash = '';
  global.window.history.lastUrl = '';
});

describe('share links', () => {
  it('round-trips a complete arrangement through a URL-safe payload', () => {
    const decoded = app.session.decodeShare(app.session.encodeShare(sampleSettings));

    assert.ok(decoded, 'The payload must decode.');
    for (const [key, value] of Object.entries(sampleSettings)) {
      assert.deepEqual(decoded[key], value, `Field ${key} must survive the round trip.`);
    }
    assert.match(app.session.encodeShare(sampleSettings), /^[A-Za-z0-9_-]+$/, 'The payload must be URL safe.');
  });

  it('rejects malformed, oversized, and stale payloads', () => {
    assert.equal(app.session.decodeShare(''), null);
    assert.equal(app.session.decodeShare('%%%not-base64%%%'), null);
    assert.equal(app.session.decodeShare('a'.repeat(5000)), null);

    const stale = Buffer.from(JSON.stringify({ v: 2, seed: 'future' })).toString('base64url');
    assert.equal(app.session.decodeShare(stale), null);

    const empty = Buffer.from(JSON.stringify({ v: 1 })).toString('base64url');
    assert.equal(app.session.decodeShare(empty), null);

    const array = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64url');
    assert.equal(app.session.decodeShare(array), null);
  });

  it('ignores unknown fields in a decoded payload', () => {
    const payload = Buffer
      .from(JSON.stringify({ v: 1, seed: 'clean', injected: '<img onerror=alert(1)>' }))
      .toString('base64url');
    const decoded = app.session.decodeShare(payload);

    assert.equal(decoded.seed, 'clean');
    assert.equal('injected' in decoded, false);
  });

  it('builds a permalink that preserves the document path and query', () => {
    const url = app.session.buildShareUrl(sampleSettings);
    assert.ok(url.startsWith('https://example.test/studio/index.html?mode=studio#s='));
    assert.equal(app.session.decodeShare(new URL(url).hash.slice(3)).seed, sampleSettings.seed);
  });

  it('reads a shared arrangement from the location fragment', () => {
    const url = app.session.buildShareUrl(sampleSettings);
    global.window.location.hash = new URL(url).hash;

    const shared = app.session.readShareFromLocation();
    assert.equal(shared.scale, 'dorian');
    assert.equal(shared.bpm, 96);

    global.window.location.hash = '#s=corrupted';
    assert.equal(app.session.readShareFromLocation(), null);

    global.window.location.hash = '';
    assert.equal(app.session.readShareFromLocation(), null);
  });

  it('rewrites the fragment without throwing when the browser refuses', () => {
    assert.equal(app.session.syncLocation(sampleSettings), true);
    assert.match(global.window.history.lastUrl, /#s=[A-Za-z0-9_-]+$/);

    const refusing = { replaceState() { throw new Error('SecurityError'); } };
    assert.equal(app.session.syncLocation(sampleSettings, global.window.location, refusing), false);
  });
});

describe('session persistence', () => {
  it('stores and restores a snapshot', () => {
    assert.equal(app.session.save(sampleSettings), true);
    assert.ok(storage.values.has(STORED_KEY));

    const restored = app.session.restore();
    assert.equal(restored.seed, sampleSettings.seed);
    assert.deepEqual(restored.melody, sampleSettings.melody);
    assert.equal(restored.voiceStyle, 'warm');
  });

  it('flushes a queued write immediately', () => {
    app.session.scheduleSave(sampleSettings);
    assert.equal(storage.values.has(STORED_KEY), false, 'The write must stay queued.');

    assert.equal(app.session.flush(), true);
    assert.ok(storage.values.has(STORED_KEY));
  });

  it('clears the stored session', () => {
    app.session.save(sampleSettings);
    assert.equal(app.session.clear(), true);
    assert.equal(app.session.restore(), null);
  });

  it('ignores stored data from an incompatible version', () => {
    storage.setItem(STORED_KEY, JSON.stringify({ v: 99, seed: 'old' }));
    assert.equal(app.session.restore(), null);
  });

  it('degrades quietly when storage is unavailable or full', () => {
    const broken = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('denied'); }
    };
    const original = global.window.localStorage;
    global.window.localStorage = broken;

    assert.equal(app.session.save(sampleSettings), false);
    assert.equal(app.session.restore(), null);
    assert.doesNotThrow(() => app.session.flush());

    global.window.localStorage = original;
  });
});
