/**
 * Does the encoder actually predict better, or just separate better?
 *
 * The switch away from the sentence transformer was justified on cosine
 * separation — a near-miss context scoring 0.6978 instead of 0.9934. That is a
 * proxy. Higher contrast can equally mean over-specificity, where only
 * near-exact histories match and a strategy change leaves the AI confidently
 * wrong. This measures the thing that actually matters instead: how often the
 * next human move is predicted correctly.
 *
 *   npx tsx scripts/bench-encoder.ts
 *
 * Deliberately headless and free of the store: it drives `embedContext` and
 * `aggregate` directly, which is the whole prediction path, so a result here is
 * about the encoder and the weighting rather than about IndexedDB.
 */

import { embedContext } from "../lib/feature-embed";
import { aggregate } from "../lib/predict";
import { EMPTY_TALLY, type MoveTally, observeMove, priorFrom } from "../lib/prior";
import { RECALL_K } from "../lib/config";
import { BEATS, buildContext, historyTail, invertOutcome, judge } from "../lib/rps";
import type { EpisodeMeta, Move, Outcome, Recalled } from "../lib/types";

const MOVES: Move[] = ["rock", "paper", "scissors"];

/* ------------------------------------------------------------- opponents */

interface Player {
  name: string;
  /** Given the full history so far, what does this player throw next? */
  next(history: { human: Move[]; ai: Move[]; outcomes: Outcome[] }, round: number): Move;
}

/** Deterministic PRNG so a run is reproducible. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makePlayers(seed: number): Player[] {
  const rand = rng(seed);
  return [
    {
      name: "cyclic R>P>S",
      next: (_h, round) => MOVES[round % 3],
    },
    {
      name: "win-stay lose-shift",
      // The classic human heuristic, and the one the current encoder has no
      // dedicated features for — its bigrams are human→human only.
      next: ({ human, outcomes }) => {
        if (human.length === 0) return "rock";
        const last = human[human.length - 1];
        const outcome = outcomes[outcomes.length - 1];
        if (outcome === "win") return last;
        return BEATS[last];
      },
    },
    {
      name: "reacts to AI's last move",
      next: ({ ai }) => {
        if (ai.length === 0) return "paper";
        // Plays what would have beaten the AI's previous throw.
        const beatsIt = MOVES.find((m) => BEATS[m] === ai[ai.length - 1]);
        return beatsIt ?? "rock";
      },
    },
    {
      name: "frequency-biased (60% rock)",
      next: () => (rand() < 0.6 ? "rock" : rand() < 0.5 ? "paper" : "scissors"),
    },
    {
      name: "switches strategy at halfway",
      next: ({ human, outcomes }, round) => {
        if (round < 60) return MOVES[round % 3];
        if (human.length === 0) return "rock";
        const last = human[human.length - 1];
        return outcomes[outcomes.length - 1] === "win" ? last : BEATS[last];
      },
    },
    {
      name: "restless (new tactic every 25)",
      next: ({ human, ai, outcomes }, round) => {
        const tactic = Math.floor(round / 25) % 4;
        const lastHuman = human[human.length - 1];
        const lastAi = ai[ai.length - 1];
        if (tactic === 0) return MOVES[round % 3];
        if (!lastHuman || !lastAi) return "rock";
        if (tactic === 1) return outcomes[outcomes.length - 1] === "win" ? lastHuman : BEATS[lastHuman];
        if (tactic === 2) return MOVES.find((m) => BEATS[m] === lastAi) ?? "rock";
        return lastHuman;
      },
    },
    {
      name: "genuinely random",
      next: () => MOVES[Math.floor(rand() * 3)],
    },
  ];
}

/**
 * A second set, written to be unlike anything the predictor was tuned against.
 *
 * These exist because of a mistake worth not repeating. An expert-committee
 * change was measured against the set above, could not be justified by it, and
 * was then "rescued" by adding an opponent built to suit it and by fitting four
 * constants to the resulting table. Scored on this set, with those constants
 * frozen, it came out at -0.5pp mean and -2.7pp on its worst case, and was
 * reverted.
 *
 * The rule that produced these: an opponent must not be a restatement of any
 * mechanism in the predictor. `Markov on own last throw` is the one that
 * mattered — a player whose bias is in the *transitions* rather than the
 * marginal, which is invisible to any test that only looks at how often each
 * move is thrown.
 */
function makeHeldoutPlayers(seed: number): Player[] {
  const rand = rng(seed);

  // Fixed once, never tuned. Deliberately not a rotation.
  const MARKOV: Record<Move, [number, number, number]> = {
    rock: [0.5, 0.2, 0.3],
    paper: [0.2, 0.3, 0.5],
    scissors: [0.4, 0.4, 0.2],
  };
  const sample = (weights: [number, number, number]): Move => {
    let ticket = rand();
    for (let i = 0; i < 3; i++) {
      ticket -= weights[i];
      if (ticket <= 0) return MOVES[i];
    }
    return MOVES[2];
  };

  let bias: [number, number, number] = [1 / 3, 1 / 3, 1 / 3];
  let expires = 0;

  return [
    {
      name: "copies the AI's last move",
      next: ({ ai }) => (ai.length ? ai[ai.length - 1] : "rock"),
    },
    {
      name: "lose-stay win-shift",
      next: ({ human, outcomes }) => {
        if (human.length === 0) return "paper";
        const previous = human[human.length - 1];
        return outcomes[outcomes.length - 1] === "win" ? BEATS[previous] : previous;
      },
    },
    {
      name: "Markov on own last throw",
      next: ({ human }) => (human.length ? sample(MARKOV[human[human.length - 1]]) : "rock"),
    },
    {
      // Regime change with nothing built to catch it.
      name: "sticky random (new bias 15-40)",
      next: (_h, round) => {
        if (round >= expires) {
          const raw: [number, number, number] = [rand(), rand(), rand()];
          const total = raw[0] + raw[1] + raw[2];
          bias = [raw[0] / total, raw[1] / total, raw[2] / total];
          expires = round + 15 + Math.floor(rand() * 26);
        }
        return sample(bias);
      },
    },
    {
      name: "four-beat R,R,P,S",
      next: (_h, round) => (["rock", "rock", "paper", "scissors"] as Move[])[round % 4],
    },
  ];
}

/* ---------------------------------------------------------------- runner */

interface Episode {
  vector: Float32Array;
  meta: EpisodeMeta;
}

/** The same exact-cosine scan the browser store performs. */
function recall(store: Episode[], query: Float32Array, k: number): Recalled[] {
  return store
    .map((episode, index) => {
      let dot = 0;
      for (let d = 0; d < query.length; d++) dot += query[d] * episode.vector[d];
      return {
        id: String(index),
        distance: 1 - dot,
        meta: episode.meta,
        influence: 0,
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

/**
 * Frequency baseline: predict whatever this player has thrown most often.
 * If the vector memory cannot beat this, it is not earning its complexity.
 */
function frequencyBaseline(human: Move[]): Move | null {
  if (human.length === 0) return null;
  const tally: Record<Move, number> = { rock: 0, paper: 0, scissors: 0 };
  for (const move of human) tally[move]++;
  return MOVES.reduce((best, m) => (tally[m] > tally[best] ? m : best), MOVES[0]);
}

function run(player: Player, rounds: number, warmup: number) {
  const store: Episode[] = [];
  const human: Move[] = [];
  const ai: Move[] = [];
  const outcomes: Outcome[] = [];
  let tally: MoveTally = EMPTY_TALLY;

  let scored = 0;
  let hits = 0;
  let memoryOnlyHits = 0;
  let baselineHits = 0;
  let seq = 0;
  let leanSum = 0;
  let leanCount = 0;

  for (let round = 0; round < rounds; round++) {
    const context = buildContext({ humanMoves: human, aiMoves: ai, outcomes });
    const tail = historyTail(human);

    // Predict before seeing the throw — the same ordering the game enforces.
    let predicted: Move | null = null;
    let memoryOnly: Move | null = null;
    if (store.length >= 6) {
      const hitsBack = recall(store, embedContext(context), Math.min(RECALL_K, store.length));
      const shared = { recalled: hitsBack, currentSeq: seq, tail, memorySize: store.length };
      const blended = aggregate({ ...shared, prior: priorFrom(tally) });
      predicted = blended.predictedHuman;
      leanSum += blended.priorWeight;
      leanCount++;
      // Omitting the prior defaults it to uniform, which is inert in the blend
      // — so this is exactly the pre-blend behaviour, measured side by side
      // rather than claimed from a previous run on a different machine.
      memoryOnly = aggregate(shared).predictedHuman;
    }
    const baseline = frequencyBaseline(human);

    const actual = player.next({ human, ai, outcomes }, round);

    // Only rounds where a prediction was actually made are scored, and the
    // first `warmup` are skipped so a cold store does not drag the number.
    if (round >= warmup) {
      if (predicted) {
        scored++;
        if (predicted === actual) hits++;
        if (memoryOnly === actual) memoryOnlyHits++;
        if (baseline === actual) baselineHits++;
      }
    }

    // The AI counters its read; without this its own moves never enter the
    // context and any opponent reacting to the AI cannot be modelled.
    // `BEATS[X]` is the move X defeats, so countering X means the move whose
    // BEATS entry is X — not BEATS[X], which is the move that loses to it.
    const counter = (move: Move) => MOVES.find((m) => BEATS[m] === move) ?? move;
    const aiMove = predicted ? counter(predicted) : MOVES[round % 3];
    const outcome = judge(actual, aiMove);

    const meta: EpisodeMeta = {
      context,
      nextHumanMove: actual,
      aiMove,
      aiOutcome: invertOutcome(outcome),
      historyTail: tail,
      seq: seq++,
      round: round + 1,
      ts: Date.now(),
    };
    store.push({ vector: embedContext(context), meta });

    human.push(actual);
    ai.push(aiMove);
    outcomes.push(outcome);
    tally = observeMove(tally, actual);
  }

  return {
    scored,
    rate: scored ? hits / scored : 0,
    memoryOnly: scored ? memoryOnlyHits / scored : 0,
    baseline: scored ? baselineHits / scored : 0,
    /** Mean share of the vote the base rate took. Diagnoses the blend directly. */
    lean: leanCount ? leanSum / leanCount : 0,
  };
}

/* ----------------------------------------------------------------- main */

const ROUNDS = 250;
const WARMUP = 20;
const SEEDS = [2, 3, 5, 11, 17, 23, 31, 41, 53, 67];

console.log(`\n${ROUNDS} rounds per run, first ${WARMUP} discarded, ${SEEDS.length} seeds averaged.`);
console.log("Chance is 33.3%.  `k-NN` is the memory vote alone, `blend` mixes in the");
console.log("base rate, `freq` is a most-common-move baseline. `delta` is blend - freq:");
console.log("the column that has to stop being negative.\n");
console.log("`lean` is how much of the vote the base rate took, averaged over rounds.\n");
table("FAMILIAR — opponents the predictor has been developed against", makePlayers);
table("HELD OUT — unlike any mechanism in the predictor; do not tune on these", makeHeldoutPlayers);

function table(title: string, build: (seed: number) => Player[]) {
  console.log(`${title}\n`);
  console.log("opponent                         k-NN    blend     freq    delta   lean");
  console.log("─────────────────────────────────────────────────────────────────────────");

  let totalBlend = 0;
  let totalMemory = 0;
  let totalBaseline = 0;

  for (const player of build(SEEDS[0])) {
    let rate = 0;
    let memoryOnly = 0;
    let base = 0;
    let lean = 0;
    for (const seed of SEEDS) {
      const fresh = build(seed).find((p) => p.name === player.name)!;
      const result = run(fresh, ROUNDS, WARMUP);
      rate += result.rate;
      memoryOnly += result.memoryOnly;
      base += result.baseline;
      lean += result.lean;
    }
    rate /= SEEDS.length;
    memoryOnly /= SEEDS.length;
    base /= SEEDS.length;
    lean /= SEEDS.length;
    totalBlend += rate;
    totalMemory += memoryOnly;
    totalBaseline += base;

    const delta = rate - base;
    console.log(
      `${player.name.padEnd(30)}${pct(memoryOnly)}  ${pct(rate)}  ${pct(base)}  ${(
        (delta >= 0 ? "+" : "") + (delta * 100).toFixed(1)
      ).padStart(6)}pp  ${pct(lean)}`,
    );
  }

  const n = build(1).length;
  console.log("─────────────────────────────────────────────────────────────────────────");
  console.log(
    `${"mean".padEnd(30)}${pct(totalMemory / n)}  ${pct(totalBlend / n)}  ${pct(
      totalBaseline / n,
    )}\n`,
  );
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1).padStart(5)}%`;
}
