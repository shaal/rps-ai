/**
 * Pure prediction math: turn a set of recalled episodes into a move.
 *
 * Kept free of I/O so the whole decision procedure can be reasoned about and
 * tested on synthetic episode lists.
 */

import { UNIFORM_PRIOR, priorStrength } from "./prior";
import { BEATS, MOVES, counter, randomMove, trailingMatchScore } from "./rps";
import type { Intent, Mode, Move, Reasoning, Recalled } from "./types";

/**
 * Softening constant in the inverse-distance weight `1 / (EPS + d^2)`.
 *
 * Without it an exact context match (d ~ 1e-14) would take effectively infinite
 * weight and drown out every other memory. At 0.01 a d=0.02 neighbour weighs
 * roughly 3x a d=0.15 one, which is a usable spread for this embedding space.
 */
const EPS = 0.01;

/** Recency half-life in episodes. Older habits fade so a strategy switch lands. */
const DECAY_TAU = 150;

/** Extra weight for an episode whose recent moves literally match the present. */
const MATCH_BONUS = 1.0;

/** Effective neighbour count at which evidence counts as fully supported. */
const SUPPORT_TARGET = 5;

/** Memory size at which the cold-start penalty on confidence fully lifts. */
const COLD_START_EPISODES = 25;

/**
 * Sampling temperature for picking which move to play against.
 *
 * The prediction runs at full strength in every mode — this is not a difficulty
 * dial. It exists because always countering the argmax makes the AI a fixed
 * function of the history, which a human detects in about ten rounds and then
 * counter-counters. A little sampling is stronger play, not weaker.
 */
const TEMPERATURE = 0.5;

/** Rate of outright random throws, for the same anti-exploitation reason. */
const EXPLORE_RATE = 0.05;

export interface ModeProfile {
  label: string;
  blurb: string;
}

export const MODE_PROFILES: Record<Mode, ModeProfile> = {
  dominate: {
    label: "Dominate",
    blurb: "Plays every read it gets. No handicap, no mercy.",
  },
  level: {
    label: "Level",
    blurb: "Steers the score toward a tie, dropping rounds when it gets ahead.",
  },
  yield: {
    label: "Yield",
    blurb: "Throws rounds on purpose. The better it reads you, the harder you win.",
  },
};

const ZERO_DISTRIBUTION: Record<Move, number> = { rock: 0, paper: 0, scissors: 0 };

export interface AggregateResult {
  distribution: Record<Move, number>;
  predictedHuman: Move | null;
  confidence: number;
  meanDistance: number;
  effectiveN: number;
  /** How decisively the winner beat the runner-up, in [0,1]. */
  margin: number;
  /** Share of the final distribution taken from the base rate rather than memory. */
  priorWeight: number;
  /** Each predictor's share of the final vote. Empty until a committee is applied. */
  contributions: Record<string, number>;
  /** Input episodes annotated with the share of the vote each one carried. */
  weighted: Recalled[];
}

const EMPTY_AGGREGATE: AggregateResult = {
  distribution: { rock: 0, paper: 0, scissors: 0 },
  predictedHuman: null,
  confidence: 0,
  meanDistance: 0,
  effectiveN: 0,
  margin: 0,
  priorWeight: 0,
  contributions: {},
  weighted: [],
};

export interface AggregateArgs {
  recalled: Recalled[];
  /**
   * Monotonic index of the round being predicted, for recency decay.
   *
   * Must come from the same counter that stamped `meta.seq`, NOT from the store
   * size. Those two agree right up until the episode cap, at which point the
   * size freezes while `seq` keeps climbing — `age` then collapses to zero for
   * every episode and recency weighting silently stops existing.
   */
  currentSeq: number;
  /** Last few human moves, for the trailing-match re-rank. */
  tail: string;
  /** Total episodes held, for the cold-start term in confidence. */
  memorySize: number;
  /** This player's base rate. Defaults to uniform, which is inert in the blend. */
  prior?: Record<Move, number>;
}

function argmax(distribution: Record<Move, number>): Move {
  return MOVES.reduce((best, move) =>
    distribution[move] > distribution[best] ? move : best,
  );
}

/** How decisively the winner beat the runner-up. Zero on a tie, near one when lopsided. */
function marginOf(distribution: Record<Move, number>): number {
  const shares = MOVES.map((move) => distribution[move]).sort((a, b) => b - a);
  return shares[0] + shares[1] > 0 ? (shares[0] - shares[1]) / (shares[0] + shares[1]) : 0;
}

/**
 * Distance-weighted vote over what the human played next in similar situations.
 *
 * Each episode's weight combines three independent signals:
 *   - inverse squared cosine distance (how similar the situation was),
 *   - exponential recency decay (how current that habit still is),
 *   - a trailing-move match bonus (a hybrid re-rank against exact recent moves,
 *     which is more reliable than the embedding alone in this tight space).
 *
 * The result is then mixed with the player's base rate, because this vote can
 * only answer "what followed situations like this one" and some players do not
 * play a function of the situation at all. See `lib/prior.ts`.
 */
export function aggregate({
  recalled,
  currentSeq,
  tail,
  memorySize,
  prior = UNIFORM_PRIOR,
}: AggregateArgs): AggregateResult {
  // With no usable memory the base rate is still a real prediction, and a
  // better one than a coin flip. Confidence stays at zero, so the score
  // controller treats it as the guess it is.
  const priorOnly = (): AggregateResult => ({
    ...EMPTY_AGGREGATE,
    distribution: { ...prior },
    predictedHuman: argmax(prior),
    margin: marginOf(prior),
    priorWeight: 1,
  });

  if (recalled.length === 0) return priorOnly();

  const weights = recalled.map((episode) => {
    const proximity = 1 / (EPS + episode.distance * episode.distance);
    const age = Math.max(0, currentSeq - episode.meta.seq);
    const recency = Math.exp(-age / DECAY_TAU);
    const match = trailingMatchScore(tail, episode.meta.historyTail);
    return proximity * recency * (1 + MATCH_BONUS * match);
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return priorOnly();

  const memoryVote: Record<Move, number> = { ...ZERO_DISTRIBUTION };
  recalled.forEach((episode, i) => {
    memoryVote[episode.meta.nextHumanMove] += weights[i] / totalWeight;
  });

  // Effective sample size: near 1 when a single memory dominates the vote,
  // near N when many memories contribute evenly.
  const sumSquares = weights.reduce((sum, w) => sum + w * w, 0);
  const effectiveN = (totalWeight * totalWeight) / sumSquares;

  // Honest confidence: how decisively the winning move beat the alternative,
  // how many memories effectively contributed, and how much the AI has seen.
  // Any one being weak caps the number.
  //
  // `margin` rather than `topShare` carries the concentration term — both
  // measure the same lopsidedness, so multiplying them double-counts it and
  // understates a read that is genuinely working. Margin is also the sharper
  // discriminator: a topShare of 0.4 can mean a clear winner or a three-way
  // tie, whereas margin goes to zero on the tie.
  //
  // There is deliberately no absolute-distance term. These embeddings sit
  // within ~0.001-0.09 cosine of each other, so anything of the form
  // `1 - d/reference` stays pinned near 1.0 and never rejects a bad
  // neighbourhood — it would look like a signal while measuring nothing.
  const support = clamp(effectiveN / SUPPORT_TARGET, 0, 1);
  const maturity = clamp(memorySize / COLD_START_EPISODES, 0, 1);
  const memoryConfidence = marginOf(memoryVote) * support * maturity;

  // How much to fall back on the base rate. This is gated on confidence in the
  // *memory* specifically — the question being asked is "is this neighbourhood
  // worth listening to", and only the pre-blend vote can answer it.
  //
  // The failure it exists to prevent is subtle: against a player with a fixed
  // bias the memory's argmax is not biased, it is merely noisy, flipping
  // between moves as twelve neighbours reshuffle. Blending in a stable estimate
  // is variance reduction, which is why it can beat the memory without the
  // memory being wrong on average.
  const priorWeight = clamp((1 - memoryConfidence) * priorStrength(prior), 0, 1);
  const distribution: Record<Move, number> = {
    rock: (1 - priorWeight) * memoryVote.rock + priorWeight * prior.rock,
    paper: (1 - priorWeight) * memoryVote.paper + priorWeight * prior.paper,
    scissors: (1 - priorWeight) * memoryVote.scissors + priorWeight * prior.scissors,
  };

  const predictedHuman = argmax(distribution);

  // Reported against the blend rather than the raw vote, so the number on
  // screen describes the prediction actually being made.
  const margin = marginOf(distribution);
  const confidence = margin * support * maturity;

  // Mean distance across only the episodes backing the winning move — the
  // distance of contradicting memories says nothing about this prediction.
  let backingWeight = 0;
  let backingDistance = 0;
  recalled.forEach((episode, i) => {
    if (episode.meta.nextHumanMove !== predictedHuman) return;
    backingWeight += weights[i];
    backingDistance += weights[i] * episode.distance;
  });
  const meanDistance = backingWeight > 0 ? backingDistance / backingWeight : 0;

  const weighted = recalled
    .map((episode, i) => ({ ...episode, influence: weights[i] / totalWeight }))
    .sort((a, b) => b.influence - a.influence);

  return {
    distribution,
    predictedHuman,
    confidence,
    meanDistance,
    effectiveN,
    margin,
    priorWeight,
    // Filled in by `applyCommittee`. On its own the memory is the only voice.
    contributions: {},
    weighted,
  };
}

/**
 * Replace the memory's verdict with the committee's, keeping everything the
 * memory measured about its own evidence.
 *
 * `support` and `maturity` deliberately still come from the memory. They
 * describe how much evidence exists at all — effective neighbour count and
 * store size — which the committee does not change and cannot improve on. Only
 * `margin` is recomputed, because that one is a property of the distribution
 * being predicted from, and that distribution is now the panel's.
 */
export function applyCommittee(
  memory: AggregateResult,
  panel: { distribution: Record<Move, number>; contributions: Record<string, number> },
  memorySize: number,
): AggregateResult {
  const margin = marginOf(panel.distribution);
  const support = clamp(memory.effectiveN / SUPPORT_TARGET, 0, 1);
  const maturity = clamp(memorySize / COLD_START_EPISODES, 0, 1);

  return {
    ...memory,
    distribution: panel.distribution,
    predictedHuman: argmax(panel.distribution),
    margin,
    confidence: margin * support * maturity,
    contributions: panel.contributions,
  };
}

/**
 * Assemble the AI's reasoning for a round.
 *
 * `intent` comes from the score controller and decides what the AI does with
 * its read; this function decides which move that read lands on.
 */
export function decide(
  aggregateResult: AggregateResult,
  intent: Intent,
  context: string,
  topN: number,
  control: Reasoning["control"],
): Reasoning {
  const {
    distribution,
    predictedHuman,
    confidence,
    meanDistance,
    effectiveN,
    margin,
    priorWeight,
    contributions,
    weighted,
  } = aggregateResult;

  const base: Omit<Reasoning, "explored" | "playedAgainst"> = {
    mode: "adaptive",
    context,
    predictedHuman,
    intent,
    distribution,
    confidence,
    neighbors: weighted.length,
    meanDistance,
    effectiveN,
    margin,
    priorWeight,
    contributions,
    topNeighbors: weighted.slice(0, topN),
    control,
  };

  // Exploring is pointless when the AI is trying to lose: a random throw will
  // not reliably concede, it just adds noise to a deliberate act.
  const mayExplore = intent !== "lose";

  if (!predictedHuman || (mayExplore && Math.random() < EXPLORE_RATE)) {
    return { ...base, explored: true, playedAgainst: null };
  }

  return {
    ...base,
    explored: false,
    playedAgainst: sampleWithTemperature(distribution, TEMPERATURE),
  };
}

/**
 * The move the AI should actually throw.
 *
 * With a predicted human move X the AI can aim at any of the three outcomes:
 * `counter(X)` beats it, `X` draws with it, and `BEATS[X]` — the move X
 * defeats — loses to it. Which one it picks is the score controller's call.
 */
export function moveFor(reasoning: Reasoning): Move {
  const target = reasoning.playedAgainst;
  if (!target) return randomMove();

  switch (reasoning.intent) {
    case "win":
      return counter(target);
    case "draw":
      return target;
    case "lose":
      return BEATS[target];
  }
}

/**
 * Sample a move from `distribution` after raising it to the power `1/temperature`.
 * Low temperature concentrates on the favourite; high temperature flattens toward
 * uniform.
 */
export function sampleWithTemperature(
  distribution: Record<Move, number>,
  temperature: number,
): Move {
  const safeTemperature = Math.max(temperature, 0.05);
  const adjusted = MOVES.map((move) =>
    Math.pow(Math.max(distribution[move], 0), 1 / safeTemperature),
  );
  const total = adjusted.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || !Number.isFinite(total)) return randomMove();

  let ticket = Math.random() * total;
  for (let i = 0; i < MOVES.length; i++) {
    ticket -= adjusted[i];
    if (ticket <= 0) return MOVES[i];
  }
  return MOVES[MOVES.length - 1];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
