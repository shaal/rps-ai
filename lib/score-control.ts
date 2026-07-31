/**
 * Score steering.
 *
 * Once the AI has a read on the human's next move it can choose to win, draw
 * or lose *on purpose* — but only conditionally, because it commits before the
 * human throws and the read is not always right.
 *
 * For a predicted human move X and read accuracy p, the expected change in
 * (AI score − human score) per round is:
 *
 *   win  intent → AI plays counter(X) →  (3p − 1) / 2
 *   draw intent → AI plays X          →  0, for any p
 *   lose intent → AI plays BEATS[X]   → −(3p − 1) / 2
 *
 * Two consequences drive the design here:
 *
 *  - Authority is proportional to (3p − 1)/2, which is zero at p = 1/3. A
 *    reader that is no better than chance cannot steer the score at all. It
 *    can still hold it, because draw intent is neutral at any p.
 *  - Draw intent is the correct "hold" action, not "play honestly" — playing
 *    the best read drifts the score upward.
 */

import type { ControlState, Intent, Mode } from "./types";

/** Error magnitude that must be exceeded before the controller acts at all. */
const DEADBAND = 1;

/** Proportional gain on the current score error. */
const KP = 1;

/** Integral gain, so a persistent deficit eventually forces a correction. */
const KI = 0.35;

/** Per-round bleed on the integral term, so old error does not haunt forever. */
const INTEGRAL_DECAY = 0.9;

/** Clamp on accumulated error, to stop the integral term winding up. */
const INTEGRAL_LIMIT = 6;

/** Control signal that maps to the maximum corrective probability. */
const SIGNAL_FOR_FULL_CORRECTION = 4;

/** Corrective action is never certain — a perfectly predictable steer is dull. */
const MAX_CORRECTION = 0.9;
const MIN_CORRECTION = 0.25;

/**
 * Below this confidence the read is not worth acting on. Steering on a bad
 * prediction is worse than not steering: it pushes the score the wrong way
 * about as often as the right way.
 */
const CONTROL_CONFIDENCE_FLOOR = 0.15;

/** Consecutive human wins after which Level stops trying to correct. */
const SPIRAL_LIMIT = 4;

export interface ControlInput {
  mode: Mode;
  /** AI score minus human score. */
  error: number;
  /** Accumulated error carried between rounds. */
  integral: number;
  /** The AI's confidence in this round's read. */
  confidence: number;
  /** True when the player can see the AI's committed move. */
  revealed: boolean;
  /** How many rounds the human has won in a row. */
  humanWinStreak: number;
  /** Uniform sample in [0,1). Injected so the decision stays testable. */
  roll: number;
}

export interface ControlDecision {
  intent: Intent;
  /** Null in `dominate`, which does not steer and has nothing to report. */
  control: ControlState | null;
  /** Integral to carry into the next round. */
  nextIntegral: number;
}

export function decideIntent(input: ControlInput): ControlDecision {
  const { mode, error, integral, confidence, revealed, humanWinStreak, roll } = input;

  // Dominate does not steer: it always plays the best read it has.
  if (mode === "dominate") {
    return { intent: "win", control: null, nextIntegral: 0 };
  }

  // Yield does not steer either — it concedes as hard as its read allows. How
  // far the human pulls ahead is then a direct readout of how well the AI
  // knows them, which is a more interesting property than a fixed handicap.
  if (mode === "yield") {
    const usable = confidence >= CONTROL_CONFIDENCE_FLOOR;
    return {
      intent: usable ? "lose" : "draw",
      control: {
        error,
        integral: 0,
        frozen: !usable,
        note: usable
          ? "Throwing the round on purpose."
          : "Read too weak to throw the round deliberately.",
      },
      nextIntegral: 0,
    };
  }

  // --- Level: steer the score toward parity. -------------------------------

  const decayed = clamp(integral * INTEGRAL_DECAY + error, -INTEGRAL_LIMIT, INTEGRAL_LIMIT);

  // A player reading the AI's hand wins every round by construction. Correcting
  // for that means escalating to maximum aggression under a label that promises
  // an even game, which reads as spite rather than balance. Hold instead.
  if (revealed) {
    return {
      intent: "draw",
      control: {
        error,
        integral: decayed,
        frozen: true,
        note: "You can see its hand — steering is off.",
      },
      nextIntegral: decayed,
    };
  }

  if (humanWinStreak >= SPIRAL_LIMIT) {
    return {
      intent: "draw",
      control: {
        error,
        integral: decayed,
        frozen: true,
        note: `Lost ${humanWinStreak} in a row — holding instead of chasing.`,
      },
      nextIntegral: decayed,
    };
  }

  if (confidence < CONTROL_CONFIDENCE_FLOOR) {
    return {
      intent: "draw",
      control: {
        error,
        integral: decayed,
        frozen: true,
        note: "Read too weak to steer on.",
      },
      nextIntegral: decayed,
    };
  }

  if (Math.abs(error) <= DEADBAND) {
    return {
      intent: "draw",
      control: {
        error,
        integral: decayed,
        frozen: false,
        note: "Close enough — holding the score.",
      },
      nextIntegral: decayed,
    };
  }

  const signal = KP * error + KI * decayed;
  const strength = clamp(
    Math.abs(signal) / SIGNAL_FOR_FULL_CORRECTION,
    MIN_CORRECTION,
    MAX_CORRECTION,
  );

  // Correct probabilistically, so the steering is not a fixed function the
  // player can read off the scoreboard.
  const correcting = roll < strength;
  const ahead = signal > 0;

  if (!correcting) {
    return {
      intent: "draw",
      control: {
        error,
        integral: decayed,
        frozen: false,
        note: ahead ? "Ahead — easing off." : "Behind — steadying.",
      },
      nextIntegral: decayed,
    };
  }

  return {
    intent: ahead ? "lose" : "win",
    control: {
      error,
      integral: decayed,
      frozen: false,
      note: ahead
        ? `Ahead by ${Math.abs(error)} — dropping this one.`
        : `Behind by ${Math.abs(error)} — taking this one.`,
    },
    nextIntegral: decayed,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, min), max);
}
