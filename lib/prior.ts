/**
 * The base rate: how often this player throws each move, irrespective of context.
 *
 * k-NN answers "what did they do after situations like this one". That is the
 * wrong question for a player whose next move does not depend on the situation.
 * Someone who simply throws rock 60% of the time carries all of their signal in
 * the marginal, and a twelve-neighbour vote is a high-variance estimate of a
 * number a running tally measures directly.
 *
 * The benchmark made that concrete: against a 60%-rock player the memory lost
 * to a most-common-move baseline by 4.9pp at 150 rounds and 7.7pp at 250. The
 * gap *widened* with data, which is the tell that it was structural rather than
 * a sampling artefact — the neighbourhood never stops being noisy, while the
 * tally keeps converging.
 *
 * Two properties make blending this in safe rather than a trade-off:
 *
 *   - **A uniform prior cannot change an argmax.** Mixing `1/3, 1/3, 1/3` into
 *     any distribution shifts every move by the same amount, so the winner
 *     still wins. Against a player with no bias — every scripted opponent here
 *     except the frequency-biased one — the blend is inert no matter how much
 *     weight it gets. It only bites when there is a real bias to exploit.
 *   - **It is an exponential moving average, not a lifetime count.** A player
 *     who shifts from rock-heavy to paper-heavy is followed rather than
 *     averaged against their own history.
 */

import { MOVES } from "./rps";
import type { Move } from "./types";

/**
 * Per-episode decay on the tally. `1 / (1 - 0.99)` makes the effective window
 * about a hundred rounds: long enough that the estimate is stable, short enough
 * that a deliberate change of habit is picked up within a game rather than
 * being outvoted by everything that came before it.
 */
export const PRIOR_DECAY = 0.99;

/** Recency-weighted counts of what the player has thrown. */
export type MoveTally = Record<Move, number>;

export const EMPTY_TALLY: MoveTally = { rock: 0, paper: 0, scissors: 0 };

/**
 * Fold one observed move into the tally.
 *
 * Pure: three numbers are not worth mutating in place, and a value type here
 * means the store can hand its tally out without callers being able to corrupt
 * the running estimate.
 */
export function observeMove(tally: MoveTally, move: Move): MoveTally {
  const next: MoveTally = {
    rock: tally.rock * PRIOR_DECAY,
    paper: tally.paper * PRIOR_DECAY,
    scissors: tally.scissors * PRIOR_DECAY,
  };
  next[move] += 1;
  return next;
}

/** Build a tally from scratch, oldest move first. Used on load and in the bench. */
export function tallyOf(moves: readonly Move[]): MoveTally {
  let tally = EMPTY_TALLY;
  for (const move of moves) tally = observeMove(tally, move);
  return tally;
}

/**
 * Normalise a tally into a probability distribution.
 *
 * Laplace-smoothed by one pseudo-count per move, which does the cold-start work:
 * an empty tally comes out exactly uniform, so a brand-new player contributes a
 * prior that provably cannot alter a prediction. The decay caps a saturated
 * tally at `1 / (1 - PRIOR_DECAY)` = 100, so by the time the estimate is worth
 * something the pseudo-counts are around 1% of the mass and stop mattering.
 */
export function priorFrom(tally: MoveTally): Record<Move, number> {
  const total = tally.rock + tally.paper + tally.scissors + MOVES.length;
  return {
    rock: (tally.rock + 1) / total,
    paper: (tally.paper + 1) / total,
    scissors: (tally.scissors + 1) / total,
  };
}

/** The distribution an empty tally produces: exactly uniform, and inert in a blend. */
export const UNIFORM_PRIOR: Record<Move, number> = priorFrom(EMPTY_TALLY);

/**
 * Total variation distance from uniform for a player who throws one move half
 * the time and the other two a quarter each.
 *
 * Used as the point where a bias counts as fully established rather than the
 * theoretical maximum of a player who throws one move every single time. The
 * reason is sampling noise: the tally's effective sample size is
 * `1 / (1 - PRIOR_DECAY)` = 100, so the standard error on a move's share is
 * about `sqrt(0.33 * 0.67 / 100)` = 0.047. A 50/25/25 split sits roughly 3.5
 * standard errors out — comfortably past what shuffling alone produces —
 * whereas normalising against 100/0/0 would score that same real, exploitable
 * bias at a quarter strength and let the memory's noise outvote it.
 */
const CLEAR_BIAS = 1 / 6;

/**
 * How much this prior actually claims, in [0,1]. Uniform scores 0.
 *
 * This exists because "the memory is unsure" and "the base rate is worth
 * hearing" are different questions, and gating only on the first gets the
 * second wrong in a specific case: immediately after a player changes strategy
 * the memory is *correctly* unsure, while the base rate is a stale average of
 * two regimes and actively misleading. Weighting by how far the prior sits from
 * uniform means an uninformative prior stands down instead of shouting.
 */
export function priorStrength(prior: Record<Move, number>): number {
  const uniform = 1 / MOVES.length;
  const totalVariation =
    MOVES.reduce((sum, move) => sum + Math.abs(prior[move] - uniform), 0) / 2;
  return Math.min(1, totalVariation / CLEAR_BIAS);
}
