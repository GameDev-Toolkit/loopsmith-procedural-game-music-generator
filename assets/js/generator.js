(() => {
  'use strict';

  const app = window.LoopSmith;
  const { steps, stepsPerBar, minActiveNotes } = app.constants;
  const { motifLibrary, progressionBank, scales, variationProfiles } = app.catalog;

  const barCount = steps / stepsPerBar;
  // The final bar is a cadence and is never thinned by the rest placer.
  const codaStart = steps - stepsPerBar;

  const clampDegree = (value, scaleLength) => Math.max(0, Math.min(scaleLength - 1, value));

  const pickFrom = (values, random) => values[Math.floor(random() * values.length)];

  /** In-place Fisher-Yates driven by the seeded RNG so shuffles stay reproducible. */
  function shuffle(values, random) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
    }
    return values;
  }

  /** Collapses leaps wider than a fourth so phrases stay singable after transformation. */
  function smoothPhrase(notes, scaleLength) {
    const result = notes.map((note) => clampDegree(note, scaleLength));

    for (let index = 1; index < result.length; index += 1) {
      const leap = result[index] - result[index - 1];
      if (Math.abs(leap) > 3) {
        result[index] = clampDegree(result[index - 1] + Math.sign(leap) * 2, scaleLength);
      }
    }

    return result;
  }

  /**
   * Derives a variation of a phrase by nudging a bounded number of interior
   * steps. Phrase boundaries are left alone because they anchor the listener's
   * ear, and a mostly descending last note reads as a cadence.
   */
  function varyPhrase(source, random, scaleLength, changes = 2, transpose = 0) {
    const result = source.map((note) => clampDegree(note + transpose, scaleLength));
    const positions = shuffle(Array.from({ length: result.length - 2 }, (_, index) => index + 1), random);

    // Sampling without replacement bounds the work and keeps each variation legible.
    for (const position of positions.slice(0, Math.min(changes, positions.length))) {
      const direction = random() < 0.5 ? -1 : 1;
      const distance = random() < 0.82 ? 1 : 2;
      result[position] = clampDegree(result[position] + direction * distance, scaleLength);
    }

    if (random() < 0.7) {
      const last = result.length - 1;
      result[last] = clampDegree(Math.min(result[last - 1], result[last]), scaleLength);
    }

    return smoothPhrase(result, scaleLength);
  }

  /**
   * Converts the requested density into rests while preserving downbeats, the
   * coda, and a maximum of one rest per bar. Weak positions are tried first so
   * low densities still land on musically defensible places.
   */
  function applyMusicalRests(notes, density, random) {
    const result = [...notes];
    const clampedDensity = app.math.toInteger(density, app.ranges.density);
    const desiredActiveNotes = Math.max(minActiveNotes, Math.min(steps, Math.round(steps * clampedDensity / 100)));
    const targetRestCount = steps - desiredActiveNotes;
    if (targetRestCount <= 0) return result;

    const candidates = [3, 1, 2].flatMap((position) => {
      const group = [];
      for (let bar = 0; bar < barCount; bar += 1) {
        const step = bar * stepsPerBar + position;
        if (step < codaStart) group.push(step);
      }
      return shuffle(group, random);
    });

    let restCount = 0;
    for (const step of candidates) {
      if (restCount >= targetRestCount) break;

      const barStart = step - (step % stepsPerBar);
      const barHasRest = result.slice(barStart, barStart + stepsPerBar).includes(null);
      const touchesRest = result[step - 1] === null || result[step + 1] === null;
      if (barHasRest || touchesRest) continue;

      result[step] = null;
      restCount += 1;
    }

    return result;
  }

  /** Structural invariants every generated melody must satisfy before it reaches the UI or an export. */
  function validateMelody(notes, scaleLength) {
    if (!Array.isArray(notes) || notes.length !== steps) return false;

    for (let index = 0; index < steps; index += 1) {
      const note = notes[index];
      const validDegree = note === null || (Number.isInteger(note) && note >= 0 && note < scaleLength);
      const protectedStep = index % stepsPerBar === 0 || index >= codaStart;
      if (!validDegree || (protectedStep && note === null)) return false;
    }

    for (let bar = 0; bar < barCount; bar += 1) {
      let rests = 0;
      for (let offset = 0; offset < stepsPerBar; offset += 1) {
        if (notes[bar * stepsPerBar + offset] === null) rests += 1;
      }
      if (rests > 1) return false;
    }

    return true;
  }

  /**
   * Deterministic for (seed, scale, density). Any change to the decision order
   * below alters existing seeds, which is why the RNG namespace carries a
   * version and `constants.generatorVersion` is exported with every handoff.
   *
   * @param {{seed: string, scale: string, density: number}} settings
   * @returns {{notes: Array<number|null>, motifName: string, structure: string}}
   */
  function composeMelody(settings) {
    const scale = scales[settings.scale];
    if (!scale) throw new Error(`Unknown scale "${settings.scale}".`);

    const random = app.math.rngFrom(`${settings.seed}-motif-engine-v3`);
    const density = app.math.toInteger(settings.density, app.ranges.density);
    const scaleLength = scale.semitones.length;
    const motif = pickFrom(motifLibrary, random);
    let phraseA = motif.notes.map((note) => clampDegree(note, scaleLength));

    if (random() < 0.42) {
      const shift = random() < 0.72 ? 1 : -1;
      phraseA = phraseA.map((note) => clampDegree(note + shift, scaleLength));
    }

    if (random() < 0.18) {
      const low = Math.min(...phraseA);
      const high = Math.max(...phraseA);
      phraseA = phraseA.map((note) => clampDegree(high - (note - low), scaleLength));
    }

    phraseA = smoothPhrase(phraseA, scaleLength);
    const phraseA1 = varyPhrase(phraseA, random, scaleLength, 2, random() < 0.22 ? 1 : 0);
    let phraseB;

    if (random() < 0.42) {
      const secondMotif = pickFrom(motifLibrary, random).notes;
      phraseB = smoothPhrase(secondMotif.map((note) => clampDegree(note + (random() < 0.5 ? 0 : 1), scaleLength)), scaleLength);
    } else {
      phraseB = varyPhrase(phraseA, random, scaleLength, 3, random() < 0.5 ? 1 : -1);
    }

    const phraseA2 = varyPhrase(phraseA, random, scaleLength, 2);
    const phraseB1 = varyPhrase(phraseB, random, scaleLength, 2);
    const structures = [
      { name: 'A A′ B A″ + coda', phrases: [phraseA, phraseA1, phraseB, phraseA2] },
      { name: 'A B A′ B′ + coda', phrases: [phraseA, phraseB, phraseA1, phraseB1] },
      { name: 'A A′ A″ B + coda', phrases: [phraseA, phraseA1, phraseA2, phraseB] },
      { name: 'A B B′ A′ + coda', phrases: [phraseA, phraseB, phraseB1, phraseA1] }
    ];
    const structure = pickFrom(structures, random);
    const cadenceSource = random() < 0.68 ? phraseA2 : phraseB1;
    const cadence = [cadenceSource[4], cadenceSource[5], random() < 0.55 ? 1 : 2, 0]
      .map((note) => clampDegree(note, scaleLength));
    const completePhrase = structure.phrases.flat().concat(cadence).slice(0, steps);
    const notes = applyMusicalRests(completePhrase, density, random);

    if (!validateMelody(notes, scaleLength)) {
      throw new Error('Generated melody failed its structural invariants.');
    }

    return { notes, motifName: motif.name, structure: structure.name };
  }

  /** Picks an integer inside `range` that differs from `previous` by at least `minimumDelta` when the range allows it. */
  function variedInteger(random, range, previous, minimumDelta) {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const value = Math.round(range[0] + random() * (range[1] - range[0]));
      if (value !== previous && Math.abs(value - previous) >= minimumDelta) return value;
    }

    return Math.abs(previous - range[0]) > Math.abs(previous - range[1]) ? range[0] : range[1];
  }

  /**
   * Builds a complete new musical identity that is audibly different from the
   * current one: a different profile, progression, root, and seed. This path is
   * intentionally non-deterministic; reproducibility comes from the resulting
   * seed, which the caller stores with the composition.
   *
   * @param {object} previousSettings
   * @param {string} currentProfileKey
   * @param {number[]} currentProgression
   */
  function createFullVariation(previousSettings, currentProfileKey, currentProgression) {
    const profileKeys = Object.keys(variationProfiles).filter((key) => key !== currentProfileKey);
    const selectionRandom = app.math.rngFrom(`${Date.now()}-${app.math.entropyToken()}-${previousSettings.seed}`);
    const profileKey = pickFrom(profileKeys, selectionRandom);
    const profile = variationProfiles[profileKey];
    const seed = `${profileKey}-${app.math.entropyToken()}`;
    const random = app.math.rngFrom(seed);
    const pick = (values) => pickFrom(values, random);

    const currentProgressionKey = (currentProgression || []).join(',');
    const progressionChoices = progressionBank.filter((progression) => progression.join(',') !== currentProgressionKey);
    const progression = pick(progressionChoices.length ? progressionChoices : progressionBank);

    const previousRoot = app.math.toInteger(previousSettings.root, app.ranges.root);

    return {
      profileKey,
      profileLabel: profile.label,
      seed,
      root: (previousRoot + 1 + Math.floor(random() * 11)) % 12,
      scale: pick(profile.scales),
      bpm: variedInteger(random, profile.bpm, app.math.toInteger(previousSettings.bpm, app.ranges.bpm), 7),
      energy: variedInteger(random, profile.energy, app.math.toInteger(previousSettings.energy, app.ranges.energy), 10),
      density: variedInteger(random, profile.density, app.math.toInteger(previousSettings.density, app.ranges.density), 6),
      brightness: variedInteger(random, profile.brightness, app.math.toInteger(previousSettings.brightness, app.ranges.brightness), 12),
      space: variedInteger(random, profile.space, app.math.toInteger(previousSettings.space, app.ranges.space), 12),
      swing: variedInteger(random, profile.swing, app.math.toInteger(previousSettings.swing, app.ranges.swing), 3),
      pad: pick(profile.pad),
      drums: pick(profile.drums),
      voiceStyle: pick(profile.voices),
      progression: [...progression]
    };
  }

  app.generator = Object.freeze({
    applyMusicalRests,
    composeMelody,
    createFullVariation,
    validateMelody
  });
})();
