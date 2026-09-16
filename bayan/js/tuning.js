// Every "taste" constant in one place. Values come from the analysis of the reference recordings (see SOUND.md).
// Wave tables are cached per semitone: reload after editing `bands`; everything else is picked up by the next note.
export const TUNING = {
  melody: {
    // Reed tables per pitch band: dB per harmonic (rel h1), `slope` dB/harmonic past the table end, `noise` =
    // inter-harmonic breath floor (dB rel the table's 0 dB), optional `fmCents` = per-band bellows-flutter depth.
    // A note gets the dB-interpolation of the two bands around its MIDI number (clamped outside).
    // Fitted by analysis/fit.py, hand-tuned since (SOUND.md pass 6; pass-8/9 low tables reverted in pass 11).
    bands: [
      { midi: 55, curve: [-2, -15, -14, -16, -19, -20, -23, -23, -25, -27, -28, -29, -31, -32, -34, -35], slope: -1.5, noise: -66, fmCents: 1.8 }, // G3 and below (16' reeds, lowest 8' keys): reedier top, a little more bellows growl
      { midi: 64, curve: [0, -16, -17, -20, -25, -26, -32, -32, -34, -37], slope: -1, noise: -66 }, // Ab3-E4
      { midi: 72, curve: [0, -17, -13, -14, -19, -28, -30, -32, -30, -23, -26, -27, -27, -22, -27, -27], slope: -1, noise: -82 }, // mid  (G4-F5)
      { midi: 80, curve: [0, -23, -27, -32, -51, -47, -46, -35, -47, -52, -48, -37, -59, -65, -54, -50], slope: -1, noise: -94 }, // high (F#5-G#5)
      { midi: 81, curve: [2, -21, -25, -30, -49, -45, -44, -33, -45, -50, -46, -35, -57, -63, -52, -48], slope: -1, noise: -94 }, // A5: the 80-band +2 dB (A5-A6 were a touch quiet)
      { midi: 93, curve: [2, -21, -25, -30, -49, -45, -44, -33, -45, -50, -46, -35, -57, -63, -52, -48], slope: -2, noise: -95 }, // A6 and above (+2 dB like A5)
    ],
    cutoff: 4000,          // per-voice lowpass (two cascaded biquads); raised to cutoffMinHarm * f0 for high notes
    cutoffMinHarm: 6,      // high reeds are bright: the knee follows the pitch so h6 always passes
    openStart: 0.5,        // lowpass starts at openStart * cutoff and opens to `cutoff` (kept subtle: a wide sweep sounds like a wah)
    releaseClose: 0.6,     // lowpass closes to releaseClose * cutoff during the release
    openTau: 0.03,         // s, time constant of the spectral opening (~3 tau to arrive)
    legatoOpenTau: 0.035,  // s, harmonics fill in over ~60-100 ms on legato notes
    swell: 0.18,           // s, raised-cosine amplitude swell from silence (bellows starting); 10->90 % in ~0.6 of it
    legatoAttack: 0.018,   // s, raised-cosine attack when bellows already moving (6 ms was a percussive 'bom')
    release: 0.07,         // s
    fadeRelease: 1.5,      // s, the Space sustain pedal's fade — how long a key rings on when it comes up under the pedal
    pitchDip: -10,         // cents at note start (recordings: -14; eased so the scoop is not heard as a 'bwom')
    pitchTau: 0.05,        // s (settles in ~3 tau = 150 ms); pitchTau selects the exponential bend model (voice.js)
    spread: { noiseLp: 800, fmHz: 8, fmCents: 1.2 }, // breath-noise lowpass (Hz, keeps the breath under the fundamental); fast pitch flutter rate (Hz) and depth (cents rms)
    jitter: 1.5,           // cents rms of slow random pitch walk
    gain: 2.0, pan: -0.15, // gain doubled (+6 dB): the bass was overpowering the right hand
  },
  bass: {
    // A bass button is a fixed 16'+8' stack (the 4' is inaudible in the recordings); the register switches don't
    // apply. Each rank is a full reed at its own sounding pitch. 8' detune 0: +1 cent beat against the 16' reed's
    // shared partials at ~0.05-0.2 Hz, a very slow pulsing — removed.
    stack: [{ oct: 0, gain: 1.0, detune: 0 }, { oct: 1, gain: 0.78, detune: 0 }],
    // Reed tables (dB, absolute: level is part of the fit); the bass side's absolute-frequency envelope lives in
    // `bassBody`. One shared tail slope keeps the two ranks consistent as they cross bands (SOUND.md pass 7).
    // `octGain` = level of the stack's 8' reed at that pitch.
    // G2 keeps the pass-5 sound, A3/E4/B4 follow bass.mp3, C1/A1 are by construction (no reference below F#3).
    bands: [
      { midi: 24, curve: [2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -13], slope: -2, noise: -55, octGain: 1 }, // C1 and below (no reference: a huge slow reed, gentle rolloff so the note still carries)
      { midi: 28, curve: [-0, -1, -2, -4, -5, -6, -7, -8, -10, -11, -12, -13, -14, -16, -17, -18], slope: -2, noise: -55, octGain: 1 }, // E1 (levelled so D1 matches D2)
      { midi: 43, curve: [-9, 4, -7, -7, -12, -2, -8, -27, -12, -7, -17, -14, -11, -17, -8, -36], slope: -2, noise: -55, octGain: 1.0 }, // G2 (kept: the approved low-bass rumble)
      { midi: 64, curve: [-4, -6, 0, 2, 4, 4, 4, 0, 4, -2, -1, -5, -1, -4, -3, -7], slope: -2, noise: -58, octGain: 0.3 }, // E4 (bass.mp3 C4-F4)
      { midi: 71, curve: [0, -2, 5, 5, 5, -3, -1, -7, -1, -3, -1, -2, -3, -1, 2, 1], slope: -2, noise: -58, octGain: 0.2 }, // B4 and above (bass.mp3 F#4-B4; also the 8-foot reeds of high keys)
    ],
    cutoff: 5000, openStart: 0.5, releaseClose: 0.6, openTau: 0.03, legatoOpenTau: 0.035, swell: 0.14, legatoAttack: 0.012, release: 0.09, fadeRelease: 1.5,
    // bend-in from bass.mp3: legato notes start ~-12 cents and settle in ~85 ms; from silence ~-30 cents over ~250 ms
    pitchDip: -12, bendTime: 0.1, bendCurve: 2.5, bend: { lowCents: -10, lowTime: 0.24, top: 55, span: 30, silentMul: 2.5 },
    openStartHarm: 0, openTimeLow: 0.6, // pitch-relative opening off on the bass (0); the slider can switch it on
    onset: { fundDb: 0, fundTime: 0.12, midDb: 0, midHarm: 5, midTime: 0.3 }, // off on the bass by default
    timbre: { topDb: 0, topHz: 1000, midDb: 0, midHz: 1200, midQ: 1.5, h1Db: 0, lowWeighted: 1 },
    attackPeriods: 5,      // C1 (33 Hz) then swells over 150 ms instead of thumping in over two cycles
    spread: { noiseLp: 1500, fmHz: 8, fmCents: 1.2 }, jitter: 1.5, gain: 0.62, pan: 0.2,
  },
  cassotto: {
    // The 8c rank's reeds, and only its reeds: a reed *family*, never a `kind`, so no envelope/bend/spread/pan —
    // a cassotto note is a melody voice whose 8c rank draws its wave, breath noise, knee and gain from here.
    // (No per-band fmCents: flutter depth is per-voice, read from the voice's kind, so it would be dead data.)
    // Fitted to melody.mp3, SOUND.md §15: strong harmonics out to ~9 kHz ("the buzz"). Lower three bands are the
    // measured reed law; the upper three keep their pass-4 h1-h4 over a smooth reference tail.
    bands: [
      { midi: 55, curve: [0, -17.1, -2.6, -3.7, -10.2, -17.8, -15.6, -16.6, -16.7, -15.1, -20.8, -24.2, -27.6, -26.3, -25.2, -25.9, -27.3, -28.5, -29.2, -29.9, -30.4, -31.2, -31.6, -31.6], slope: -0.8, noise: -66 }, // G3 and below (16' reeds, lowest 8' keys): the reediest tail, checked against the A3 of melody.mp3
      { midi: 64, curve: [0, -18, -4.5, -11.5, -13.4, -11.2, -18.9, -25.2, -24.5, -25.2, -25.1, -25.8, -27.8, -29.6, -30.6, -31.5, -32.4, -33, -32.9, -33.6, -35.1, -36.8, -38.4, -40], slope: -1.2, noise: -66 }, // Ab3-E4
      { midi: 72, curve: [0, -20.3, -7.7, -10.9, -20.7, -20.6, -23.7, -25, -25.3, -27.2, -29.6, -30.7, -31.6, -32.1, -31.5, -31.2, -32.7, -34.2, -35.7, -37.2, -38.7, -40.2, -41.7, -43.2], slope: -1.5, noise: -82 }, // mid (G4-F5); the reference notes sit between this band and the one above
      { midi: 80, curve: [0, -23, -27, -32, -33.9, -35.5, -38.2, -40.5, -42.5, -44.3, -46, -47.5, -48.9, -50.2, -51.3, -52.5], slope: -2, noise: -94 }, // high (F#5-G#5): pass-4 h1-h4, then the reference tail (-6 dB/oct to 5 kHz, -12 above)
      { midi: 81, curve: [2, -21, -25, -30, -31.9, -34, -36.7, -39, -41, -42.8, -44.5, -46, -47.4, -48.7, -49.8, -51], slope: -2, noise: -94 }, // A5: the 80-band +2 dB (A5-A6 were a touch quiet)
      { midi: 93, curve: [2, -21, -25, -30, -33.9, -37, -39.7, -42, -44, -45.9, -47.5, -49, -50.4, -51.7, -52.9, -54], slope: -2, noise: -95 }, // A6 and above (+2 dB like A5)
    ],
    cutoff: 9000,          // melody.mp3's partials run out to ~9 kHz, 16-33 dB above the inter-harmonic floor; the
                           // melody's own 4 kHz knee cost 24 dB at 8 kHz, which is why the buzz never sounded there
    cutoffMinHarm: 6,      // as the melody: the knee follows the pitch so h6 always passes
    gain: 1.8,             // 0.9 dB under melody.gain — the brighter reed has the higher crest factor
  },
  bassBody: [ // bass-side resonator/radiation, on the bass and chord buses: [type, freq, Q, gain dB] (fitted to the
    // 16-foot reed's odd-harmonic level vs absolute frequency across all bass notes; see SOUND.md section 8)
    ['lowshelf', 291, 0.70, -15.0],
    ['peaking', 1060, 1.94, 9.1],
    ['peaking', 273, 0.77, 15.0],
    ['peaking', 633, 4.00, 4.1],
    ['peaking', 2118, 4.00, -4.3],
    ['highshelf', 600, 0.70, -17.5],
  ],
  body: [ // shared resonances: [freq, Q, gain dB]
    [1150, 6, 5],
    [1950, 6, -6],   // was -12 dB Q 8 (example.wav); low.mp3's instrument has a peak at 1.3-2 kHz, so the notch is softened.
    // To give the melody the old deeper notch without recoloring the bass, add to `melody` instead:
    //   timbre: { midDb: -6, midHz: 1950, midQ: 8, topDb: 0, topHz: 1000, h1Db: 0, lowWeighted: 0 }
    // (the per-rank peaking trim in voice.js; it stacks on this shared -6 dB, ~= the old -12 dB Q 8 for melody only)
    [2600, 8, 4],
  ],
  reverb: { seconds: 0.03, wet: 0.05 },
  pressure: { pitchCentsPerDb: -0.42, driftHz: 0.3, driftDb: 1.0 },
  pump: { boost: 0.5, seconds: 0.08, dip: 0, dipMs: 25 }, // Space: pressure boost while held, its ramp time; optional reversal dip (0 = tone never cuts)
  legatoWindow: 0.15,      // s after the last note-off during which a new note is still "legato"
  polyExp: 0.3,            // voice bus gain = base / n^polyExp
};
