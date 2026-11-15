(() => {
  'use strict';

  const app = window.LoopSmith;

  const STORAGE_KEY = 'loopsmith.session.v1';
  const SHARE_PARAM = 's';
  const SHARE_VERSION = 1;
  const MAX_PAYLOAD_LENGTH = 4096;
  const SAVE_DELAY_MS = 400;

  /**
   * Fields that travel with a session or a shared link. Anything outside this
   * list is ignored on the way in, so a crafted payload cannot add properties to
   * the settings model or reach code that consumes it.
   */
  const PERSISTED_FIELDS = Object.freeze([
    'seed',
    'root',
    'scale',
    'bpm',
    'energy',
    'density',
    'brightness',
    'space',
    'swing',
    'volume',
    'pad',
    'drums',
    'voiceStyle',
    'motifName',
    'structure',
    'profileKey',
    'profileLabel',
    'progression',
    'melody'
  ]);

  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  let saveTimer = 0;
  let pendingSettings = null;

  /* ------------------------------------------------------------------ *
   * Base64url helpers
   * ------------------------------------------------------------------ */

  function bytesToBase64(bytes) {
    let binary = '';
    // String.fromCharCode is variadic; chunking keeps large inputs off the
    // argument stack limit.
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  const toBase64Url = (text) => bytesToBase64(new TextEncoder().encode(text))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const fromBase64Url = (value) => {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return new TextDecoder().decode(base64ToBytes(padded));
  };

  /* ------------------------------------------------------------------ *
   * Payload encoding
   * ------------------------------------------------------------------ */

  function toPayload(settings) {
    const payload = { v: SHARE_VERSION };
    for (const field of PERSISTED_FIELDS) payload[field] = settings[field];
    return payload;
  }

  /**
   * Keeps only known fields of a decoded payload. Values are deliberately not
   * validated here: `app.settings.normalize` owns that responsibility, so there
   * is exactly one set of clamping rules in the application.
   */
  function pickFields(data) {
    if (!isPlainObject(data)) return null;
    const picked = {};
    let found = 0;
    for (const field of PERSISTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        picked[field] = data[field];
        found += 1;
      }
    }
    return found > 0 ? picked : null;
  }

  /**
   * Serialises a settings snapshot into a URL-safe string. Melodies contain
   * rests, so the payload is JSON encoded before base64 rather than packed.
   *
   * @param {object} settings
   * @returns {string}
   */
  function encodeShare(settings) {
    return toBase64Url(JSON.stringify(toPayload(settings)));
  }

  /** Parses a JSON payload shared by links and local storage. */
  function parsePayload(text) {
    try {
      const data = JSON.parse(text);
      if (!isPlainObject(data) || data.v !== SHARE_VERSION) return null;
      return pickFields(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * Decodes a shared payload. Returns `null` for anything that is not a complete,
   * current-version payload; malformed input must never throw at the call site.
   *
   * @param {string} value
   * @returns {object|null}
   */
  function decodeShare(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PAYLOAD_LENGTH) return null;

    try {
      return parsePayload(fromBase64Url(value));
    } catch (error) {
      return null;
    }
  }

  /**
   * Builds a permalink that carries the complete arrangement in the fragment.
   * The fragment never reaches a server, so a shared link stays as private as the
   * studio itself.
   */
  function buildShareUrl(settings, location = window.location) {
    const href = String((location && location.href) || '');
    const base = href.split('#')[0];
    return `${base}#${SHARE_PARAM}=${encodeShare(settings)}`;
  }

  /** Reads a shared arrangement from the current URL fragment, if there is one. */
  function readShareFromLocation(location = window.location) {
    const hash = (location && location.hash) || '';
    if (!hash.startsWith('#')) return null;

    try {
      const params = new URLSearchParams(hash.slice(1));
      return decodeShare(params.get(SHARE_PARAM) || '');
    } catch (error) {
      return null;
    }
  }

  /** Rewrites the fragment without adding a history entry. Ignored where the browser forbids it (file://). */
  function syncLocation(settings, location = window.location, history = window.history) {
    if (!location || !history || typeof history.replaceState !== 'function') return false;
    try {
      history.replaceState(history.state, '', buildShareUrl(settings, location));
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Local persistence
   * ------------------------------------------------------------------ */

  /**
   * Returns localStorage, or null when it is blocked. Private browsing modes and
   * embedded frames can expose the object while rejecting writes, so every
   * access below is additionally guarded.
   */
  function getStorage() {
    try {
      return window.localStorage || null;
    } catch (error) {
      return null;
    }
  }

  /** Writes a snapshot immediately. Returns false when persistence is unavailable. */
  function save(settings) {
    pendingSettings = null;
    window.clearTimeout(saveTimer);
    saveTimer = 0;

    const store = getStorage();
    if (!store) return false;

    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ ...toPayload(settings), savedAt: Date.now() }));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** Queues a snapshot write; repeated edits within the delay collapse into one write. */
  function scheduleSave(settings) {
    pendingSettings = settings;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
  }

  /** Writes a queued snapshot now, for example before the page is discarded. */
  function flush() {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    if (!pendingSettings) return false;
    return save(pendingSettings);
  }

  /** Restores the last session, or null when nothing usable is stored. */
  function restore() {
    const store = getStorage();
    if (!store) return null;

    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) return null;
      return parsePayload(raw);
    } catch (error) {
      return null;
    }
  }

  /** Removes the stored session. */
  function clear() {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    pendingSettings = null;

    const store = getStorage();
    if (!store) return false;
    try {
      store.removeItem(STORAGE_KEY);
      return true;
    } catch (error) {
      return false;
    }
  }

  app.session = Object.freeze({
    STORAGE_KEY,
    SHARE_PARAM,
    buildShareUrl,
    clear,
    decodeShare,
    encodeShare,
    flush,
    readShareFromLocation,
    restore,
    save,
    scheduleSave,
    syncLocation
  });
})();
