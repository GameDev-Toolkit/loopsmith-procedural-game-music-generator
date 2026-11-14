'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

global.window = {};

require(path.join(__dirname, '..', 'assets', 'js', 'config.js'));
require(path.join(__dirname, '..', 'assets', 'js', 'export.js'));

const app = global.window.LoopSmith;

const settings = {
  seed: 'test-seed',
  root: 9,
  scale: 'majorPent',
  bpm: 120,
  energy: 50,
  density: 88,
  brightness: 35,
  space: 14,
  swing: 10,
  volume: 100,
  pad: true,
  drums: false,
  voiceStyle: 'bell',
  motifName: 'Game Arc',
  structure: 'A A′ B A″ + coda',
  profileKey: 'classic',
  profileLabel: 'Classic Dots',
  progression: [0, -3, -5, -7],
  melody: [0, null, 2, 4, 5, 3, 1, 0, 2, 4, 5, 3, 4, 2, 3, 0, 0, 2, 4, 3, 5, 2, 4, 1, 2, 4, 5, 3, 4, 2, 3, 0, 4, 3, 1, 0]
};

/** Minimal AudioBuffer surface consumed by `encodeWav`. */
function createBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData: (channel) => channels[channel]
  };
}

const readBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));

describe('WAV encoding', () => {
  it('writes a valid RIFF header for 16-bit PCM', async () => {
    const bytes = await readBytes(app.exporter.encodeWav(createBuffer([new Float32Array(5)], 8000)));
    const view = new DataView(bytes.buffer);

    assert.equal(ascii(bytes, 0, 4), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 10);
    assert.equal(ascii(bytes, 8, 4), 'WAVE');
    assert.equal(ascii(bytes, 12, 4), 'fmt ');
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1, 'PCM format tag');
    assert.equal(view.getUint16(22, true), 1, 'mono');
    assert.equal(view.getUint32(24, true), 8000);
    assert.equal(view.getUint32(28, true), 16000, 'byte rate');
    assert.equal(view.getUint16(32, true), 2, 'block align');
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(ascii(bytes, 36, 4), 'data');
    assert.equal(view.getUint32(40, true), 10);
    assert.equal(bytes.length, 44 + 10);
  });

  it('interleaves channels and clamps samples to the 16-bit range', async () => {
    const left = new Float32Array([-2, 0, 0.5]);
    const right = new Float32Array([2, -0.5, 0]);
    const bytes = await readBytes(app.exporter.encodeWav(createBuffer([left, right], 44100)));
    const view = new DataView(bytes.buffer);

    assert.equal(view.getUint32(40, true), 12, 'two channels, three frames');
    assert.equal(view.getInt16(44, true), -32768);
    assert.equal(view.getInt16(46, true), 32767);
    assert.equal(view.getInt16(48, true), 0);
    assert.equal(view.getInt16(50, true), -16384);
    assert.equal(view.getInt16(52, true), 16383);
    assert.equal(view.getInt16(54, true), 0);
  });
});

describe('handoff spec', () => {
  it('describes the loop with stable, engine-neutral fields', () => {
    const spec = app.exporter.buildSpec(settings);

    assert.equal(spec.format, 'loopsmith-game-music-v1');
    assert.equal(spec.generator_version, app.constants.generatorVersion);
    assert.equal(spec.variation_profile, 'Classic Dots');
    assert.equal(spec.tempo.bpm, 120);
    assert.equal(spec.tempo.step_seconds, 0.25);
    assert.equal(spec.tempo.loop_seconds, 9);
    assert.equal(spec.tempo.bars_per_loop, 9);
    assert.equal(spec.harmony.root_note, 'A');
    assert.equal(spec.harmony.base_midi, 57);
    assert.equal(spec.harmony.base_hz, 220);
    assert.deepEqual(spec.harmony.scale_semitones, [0, 2, 4, 7, 9, 12, 14]);
    assert.equal(spec.composition.active_notes, 35);
    assert.equal(spec.composition.rests, 1);
    assert.equal(spec.melody.degrees[1], null);
    assert.equal(spec.melody.frequencies_hz[1], null);
    assert.equal(spec.melody.frequencies_hz[0], 220);
    assert.equal(spec.integration.music_bus, 'Music');
  });

  it('keeps numeric formatting stable for downstream parsers', () => {
    const spec = app.exporter.buildSpec(settings);
    assert.equal(Number.isInteger(spec.tempo.step_seconds * 1000), true);
    assert.equal(typeof spec.sound.note_duration_seconds, 'number');
    assert.match(String(spec.sound.harmonic_mix), /^\d+(\.\d{1,3})?$/);
  });

  it('is serialisable without cycles', () => {
    const json = JSON.stringify(app.exporter.buildSpec(settings));
    assert.equal(JSON.parse(json).seed, 'test-seed');
  });
});

describe('Godot and agent handoff', () => {
  it('emits constants that match the spec', () => {
    const godot = app.exporter.buildGodot(settings);
    assert.match(godot, /const RATE := 16000\.0/);
    assert.match(godot, /const SCALE := \[0, 2, 4, 7, 9, 12, 14\]/);
    assert.match(godot, /const PATTERN := \[0, -1, 2, 4, 5, 3, 1, 0/);
    assert.match(godot, /const HARMONY_STEPS := 8/);
    assert.match(godot, /const USE_PAD := true/);
    assert.match(godot, /const USE_SOFT_DRUMS := false/);
  });

  it('cannot be broken out of by a crafted seed', () => {
    const hostile = { ...settings, seed: 'x\nconst INJECTED := 1\n#', motifName: 'a\r\nb' };
    const godot = app.exporter.buildGodot(hostile);

    assert.equal(godot.includes('INJECTED'), true, 'The seed text is preserved.');
    assert.equal(/^\s*const INJECTED/m.test(godot), false, 'The seed must not start a new statement.');
    assert.equal(godot.split('\n').filter((line) => line.startsWith('# Seed:')).length, 1);
    assert.equal(godot.includes('\r'), false);
  });

  it('quotes the parameters the game implementation has to match', () => {
    const prompt = app.exporter.buildPrompt(settings);
    assert.match(prompt, /36-step PATTERN/);
    assert.match(prompt, /Tempo: 120 BPM; step interval: 0\.25 seconds/);
    assert.match(prompt, /Ambient pad: enabled/);
    assert.match(prompt, /Reference melodic frequencies by step/);
    assert.equal(/^\s*const INJECTED/m.test(app.exporter.buildPrompt({ ...settings, seed: 'a\nconst INJECTED' })), false);
  });
});
