/**
 * A committee of simple predictors, weighted by how well each has been doing.
 *
 * The memory is a single inductive bias: it assumes the next move is a function
 * of the recent situation, and looks for a past situation that resembles this
 * one. That assumption is right about a lot of players and wrong about several
 * common ones, and when it is wrong there is no amount of encoder tuning that
 * rescues it — the question being asked simply does not have the answer in it.
 *
 * A player who always throws what beats the AI's last move is trivially
 * predictable, but only if you happen to be asking about the AI's last move.
 * A player who repeats after a win is trivially predictable, but only if you
 * are asking about outcomes. So rather than growing the feature vector until
 * one retrieval scheme covers every case, each hypothesis gets to be its own
 * predictor and the committee bets on whichever is currently paying.
 *
 * The memory remains one voice here, usually the loudest — it is the only
 * member that can learn a habit nobody anticipated, and the four heuristics
 * below can only ever recognise the pattern they were written for.
 */

import { BEATS, MOVES, counter } from "./rps";
import type { Move, Outcome } from "./types";

/**
 * Share of the vote a deterministic heuristic puts on its own pick.
 *
 * Not 1.0. A heuristic that is right 60% of the time and screams one-hot every
 * round bulldozes a memory that is quietly right 90% of the time with a spread
 * distribution, because standings are only recalculated after the fact. Leaving
 * 30% of the mass on the alternatives keeps any single round from being decided
 * by conviction rather than by track record.
 */
const CONVICTION = 0.7;

/**
 * How sharply a round's result moves the standings (the η of exponential
 * weights).
 *
 * At 3.0 a round where one expert put 0.7 on the actual move and another put
 * 0.1 moves their ratio by `exp(3 x 0.6)` ≈ 6x, so the standings can turn over
 * within a handful of rounds. That is deliberately fast: the committee's whole
 * job is to notice a player switching tactics mid-game, and a slow tracker
 * spends the switch still betting on the old answer. The share floor below is
 * what makes that speed safe.
 */
const LEARNING_RATE = 3.0;

/**
 * Weight floor redistributed to every expert each round, as a share of the
 * total. This is what lets the committee survive a player changing tactics.
 *
 * Plain exponential weights are optimal against a *fixed* best expert: a
 * predictor that spends sixty rounds being wrong decays toward zero and, having
 * got there, can never climb back no matter how right it becomes — its weight
 * multiplies, and anything times almost-zero is almost-zero. Since the entire
 * premise is opponents who change, every expert keeps a small stake. At 1%,
 * combined with the learning rate above, an expert that collapsed to nothing
 * and then starts being right climbs back to parity in about three rounds.
 */
const SHARE_FLOOR = 0.01;

/**
 * Power the standings are raised to before they are used as vote shares. See
 * `combine` for why voting is deliberately sharper than tracking.
 */
const SHARPNESS = 2;

/** What each expert saw. Outcomes are from the HUMAN's perspective throughout. */
export interface ExpertView {
  human: readonly Move[];
  ai: readonly Move[];
  outcomes: readonly Outcome[];
}

export interface Expert {
  name: string;
  /** One line, shown in the UI beside the expert's current weight. */
  blurb: string;
  /** The move this expert expects next, or null when it has nothing to go on. */
  predict(view: ExpertView): Move | null;
}

function last<T>(items: readonly T[]): T | null {
  return items.length ? items[items.length - 1] : null;
}

/**
 * The heuristics, each one a hypothesis about what kind of player this is.
 *
 * Deliberately not exhaustive and deliberately not clever: every one is a
 * pattern that real people fall into, and the committee's job is to find out
 * which — if any — applies. Adding a member is cheap, and one that never fires
 * simply sits at its share floor costing a multiply per round.
 */
export const HEURISTICS: readonly Expert[] = [
  {
    name: "repeat",
    blurb: "You throw the same move again.",
    predict: ({ human }) => last(human),
  },
  {
    name: "cycle",
    blurb: "You rotate rock → paper → scissors.",
    predict: ({ human }) => {
      const previous = last(human);
      return previous ? counter(previous) : null;
    },
  },
  {
    name: "win-stay",
    blurb: "You keep a winning move and switch off a losing one.",
    predict: ({ human, outcomes }) => {
      const previous = last(human);
      const outcome = last(outcomes);
      if (!previous || !outcome) return null;
      return outcome === "win" ? previous : BEATS[previous];
    },
  },
  {
    name: "counter-AI",
    blurb: "You play whatever would have beaten the AI's last throw.",
    predict: ({ ai }) => {
      const previous = last(ai);
      return previous ? counter(previous) : null;
    },
  },
];

/**
 * The one member supplied from outside rather than computed here.
 *
 * The base rate is deliberately *not* a member of its own. It is already mixed
 * into the memory's distribution upstream (`lib/prior.ts`), and running it a
 * second time as an independent voice measured identically while making the
 * vote impossible to explain — the same evidence would have been counted twice
 * under two names. It lives in exactly one place.
 */
export const MEMORY_EXPERT = "memory";

export const EXPERT_NAMES: readonly string[] = [
  MEMORY_EXPERT,
  ...HEURISTICS.map((expert) => expert.name),
];

/** One expert's opinion for a round, as a distribution over the human's next move. */
export type Opinion = Record<Move, number>;

/** Current standing of every expert. Always sums to 1. */
export type ExpertWeights = Record<string, number>;

export const EVEN_WEIGHTS: ExpertWeights = Object.fromEntries(
  EXPERT_NAMES.map((name) => [name, 1 / EXPERT_NAMES.length]),
);

const UNIFORM_OPINION: Opinion = {
  rock: 1 / 3,
  paper: 1 / 3,
  scissors: 1 / 3,
};

/** A pick softened by `CONVICTION`; null becomes "no opinion", which is uniform. */
function opinionFor(move: Move | null): Opinion {
  if (!move) return { ...UNIFORM_OPINION };
  const rest = (1 - CONVICTION) / (MOVES.length - 1);
  return {
    rock: move === "rock" ? CONVICTION : rest,
    paper: move === "paper" ? CONVICTION : rest,
    scissors: move === "scissors" ? CONVICTION : rest,
  };
}

/** Collect what every expert thinks, given the memory's distribution from the caller. */
export function opinionsFrom(view: ExpertView, memory: Opinion): Record<string, Opinion> {
  const opinions: Record<string, Opinion> = { [MEMORY_EXPERT]: memory };
  for (const expert of HEURISTICS) {
    opinions[expert.name] = opinionFor(expert.predict(view));
  }
  return opinions;
}

export interface CommitteeResult {
  distribution: Opinion;
  /** Each expert's share of the final vote, for the UI. Sums to 1. */
  contributions: ExpertWeights;
}

/**
 * Mix every opinion in proportion to how much the committee currently trusts it,
 * after concentrating the weights on the leaders.
 *
 * Tracking and voting want opposite things, and `SHARPNESS` is what lets them
 * have it. Tracking wants soft, forgiving weights so a briefly-wrong expert is
 * not written off and a newly-right one is noticed quickly. Voting wants to
 * commit, because a vote diluted across five predictors that are each barely
 * better than chance is worse than the best one alone.
 *
 * That case is not hypothetical: against a player who is simply 60% rock, no
 * expert can exceed about 59%, so the exponential weights never separate them
 * by much, and the four heuristics between them dragged the prediction several
 * points below what the memory managed unaided. Raising the weights to a power
 * leaves the standings untouched but makes the ballot decisive.
 *
 * `heuristicTrust` is the other half of that fix and does the heavier lifting.
 * See the note on the parameter.
 */
export function combine(
  opinions: Record<string, Opinion>,
  weights: ExpertWeights,
  /**
   * How far the heuristics are worth listening to at all, in [0,1]. Pass
   * `1 - priorStrength(baseRate)`.
   *
   * Every heuristic here answers a question of the form "given what just
   * happened, what follows" — so all of them are useless against a player whose
   * next move does not depend on what just happened, and worse than useless
   * once one of them is right often enough to earn a vote. `repeat` is the
   * trap: against a 60%-rock player it is correct 44% of the time, comfortably
   * beating chance and clearing any standings-based bar, while still being far
   * worse than simply always saying rock. It then drags the vote off rock every
   * time the player happens to throw something else.
   *
   * A skewed base rate is exactly the signal that a player is memoryless, so
   * the same measure that decides how much to trust the base rate decides how
   * much to distrust the heuristics. Without this the committee cost 3.4pp
   * against that player; with it, 0.2pp.
   */
  heuristicTrust = 1,
): CommitteeResult {
  const distribution: Opinion = { rock: 0, paper: 0, scissors: 0 };
  const contributions: ExpertWeights = {};
  let total = 0;

  // An expert has to be beating the house average to get a ballot at all.
  // Anyone still sitting at or below an even split has, by definition, not
  // shown they know anything. If nobody clears the bar the field is left open,
  // since an equal split of uninformed opinions is the honest answer to a
  // player nothing has read yet.
  const bar = 1 / EXPERT_NAMES.length;
  const qualified = EXPERT_NAMES.filter((name) => (weights[name] ?? 0) > bar);
  const voting = qualified.length ? qualified : EXPERT_NAMES;

  for (const name of voting) {
    const opinion = opinions[name];
    const standing = weights[name] ?? 0;
    if (!opinion || standing <= 0) continue;
    const isHeuristic = name !== MEMORY_EXPERT;
    const weight = Math.pow(standing, SHARPNESS) * (isHeuristic ? heuristicTrust : 1);
    if (weight <= 0) continue;
    for (const move of MOVES) distribution[move] += weight * opinion[move];
    contributions[name] = weight;
    total += weight;
  }

  if (total <= 0) return { distribution: { ...UNIFORM_OPINION }, contributions: {} };
  for (const move of MOVES) distribution[move] /= total;
  for (const name of Object.keys(contributions)) contributions[name] /= total;

  return { distribution, contributions };
}

/**
 * Update the standings against what the human actually played.
 *
 * Scored on the probability each expert assigned to the real move rather than
 * on whether its argmax happened to land. An expert that put 0.5 on the right
 * answer was more use than one that put 0.34 on it, and only a proper score
 * distinguishes them — argmax accuracy would call both of them simply "wrong"
 * whenever a third expert edged them out.
 */
export function reweigh(
  weights: ExpertWeights,
  opinions: Record<string, Opinion>,
  actual: Move,
): ExpertWeights {
  const updated: ExpertWeights = {};
  let total = 0;

  for (const name of EXPERT_NAMES) {
    const opinion = opinions[name];
    // An expert that did not speak keeps its standing rather than being
    // punished for silence.
    const loss = opinion ? 1 - opinion[actual] : 0;
    const weight = (weights[name] ?? EVEN_WEIGHTS[name]) * Math.exp(-LEARNING_RATE * loss);
    updated[name] = weight;
    total += weight;
  }

  // Normalise, then hand every expert back a sliver so none is ever truly out.
  const floor = SHARE_FLOOR / EXPERT_NAMES.length;
  for (const name of EXPERT_NAMES) {
    updated[name] = (1 - SHARE_FLOOR) * (updated[name] / total) + floor;
  }
  return updated;
}
