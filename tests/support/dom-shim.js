'use strict';

/**
 * Minimal document used by the settings tests. The studio only touches
 * `value`, `checked`, and `textContent` on form controls, so the shim exposes
 * exactly that surface instead of pulling a DOM implementation into the project.
 */
function mountDom(overrides = {}) {
  const initial = {
    seed: { value: 'swipe-dots-01' },
    root: { value: '9' },
    scale: { value: 'majorPent' },
    bpm: { value: '71' },
    energy: { value: '32' },
    density: { value: '88' },
    brightness: { value: '35' },
    space: { value: '14' },
    swing: { value: '0' },
    volume: { value: '100' },
    pad: { checked: false },
    drums: { checked: false },
    ...overrides
  };

  const elements = new Map();
  for (const [id, values] of Object.entries(initial)) {
    elements.set(id, {
      id,
      value: values.value === undefined ? '' : String(values.value),
      checked: Boolean(values.checked),
      textContent: ''
    });
  }

  global.document = {
    getElementById: (id) => elements.get(id) || null
  };

  return {
    elements,
    valueOf(id) {
      return elements.get(id).value;
    },
    isChecked(id) {
      return elements.get(id).checked;
    }
  };
}

module.exports = { mountDom };
