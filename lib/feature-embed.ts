/**
 * Deterministic encoder from a context string to a vector.
 *
 * The server embeds `buildContext`'s output with a sentence transformer. That
 * was always a slightly odd fit, and `buildContext`'s own docblock says why:
 * near-identical English templates collapse into a tight cosine ball, so the
 * string was deliberately written as dense codes to claw the contrast back.
 * Which is the tell — the string is already a feature vector, serialised. It
 * was being round-tripped through a model trained on English to recover
 * structure it never lost.
 *
 * This reads the codes directly. The consequences are not subtle:
 *
 *   - no model asset at all, against 86MB that had to be split across five
 *     files to clear a hosting limit
 *   - about 0.01ms per encode, against ~317ms measured for the transformer
 *   - distance defined over the variables that actually determine the next
 *     throw, rather than over how alike two strings look as English
 *
 * The vector is L2-normalised, so everything downstream — cosine k-NN, the
 * distances shown in the scope, inverse-distance weighting — is untouched.
 *
 * Parsing the string rather than taking the raw fields is deliberate: the
 * string stays the canonical form, so `MemoryStore`, the export format and the
 * UI's "context it matched" panel all keep working unchanged.
 */

import { AI_CONTEXT_WINDOW, CONTEXT_WINDOW, MOVES } from "./rps";
import type { Move, Outcome } from "./types";

const MOVE_INDEX: Record<string, number> = { R: 0, P: 1, S: 2 };
const OUTCOME_INDEX: Record<string, number> = { W: 0, L: 1, D: 2 };

const OUTCOME_SLOTS = 3;

/**
 * Layout. Every block is a fixed span so a given feature always lands in the
 * same coordinate — that is what makes the cosine meaningful.
 */
const HUMAN_SPAN = CONTEXT_WINDOW * 3; // 18: last six human moves, one-hot each
const AI_SPAN = AI_CONTEXT_WINDOW * 3; //  12: last four AI moves
const OUTCOME_SPAN = OUTCOME_SLOTS * 3; //  9: last three outcomes
const STREAK_SPAN = 4; //                    3 for which move, 1 for how long
const BIGRAM_SPAN = 9; //                    3x3 transition counts
const FREQ_SPAN = 3; //                      normalised move histogram

/**
 * How far into the visit this situation is.
 *
 * Load-bearing, not decorative. Without it an opening — no moves, no streak, no
 * outcomes, no bigrams, all frequencies zero — encodes to the zero vector, and
 * a zero vector has distance 1.000 to every stored episode no matter what it
 * contains. So the one situation a returning player is guaranteed to be in was
 * the one situation that could retrieve nothing.
 *
 * `opening` fires only on a genuinely empty history, which gives two openings a
 * cosine of 1 with each other; `depth` places later rounds along a ramp so an
 * early situation does not read as identical to a late one.
 */
const PHASE_SPAN = 2;

export const FEATURE_DIMENSIONS =
  HUMAN_SPAN + AI_SPAN + OUTCOME_SPAN + STREAK_SPAN + BIGRAM_SPAN + FREQ_SPAN + PHASE_SPAN;

const HUMAN_AT = 0;
const AI_AT = HUMAN_AT + HUMAN_SPAN;
const OUTCOME_AT = AI_AT + AI_SPAN;
const STREAK_AT = OUTCOME_AT + OUTCOME_SPAN;
const BIGRAM_AT = STREAK_AT + STREAK_SPAN;
const FREQ_AT = BIGRAM_AT + BIGRAM_SPAN;
const PHASE_AT = FREQ_AT + FREQ_SPAN;

/**
 * Recency weight for the nth-most-recent move.
 *
 * Without this every position in the window counts equally, and a player who
 * has just switched looks identical to one who switched five rounds ago. The
 * decay is what makes "what you did last" dominate "what you did a while ago".
 */
function recency(stepsBack: number): number {
  return Math.pow(0.72, stepsBack);
}

/** Pull one `key:value` field out of the coded context string. */
function field(context: string, key: string): string {
  const match = new RegExp(`${key}:(\\S+)`).exec(context);
  const value = match?.[1] ?? "-";
  return value === "-" ? "" : value;
}

export function embedContext(context: string): Float32Array {
  const vector = new Float32Array(FEATURE_DIMENSIONS);

  // Human moves, most recent first so the decay lines up with position.
  const human = field(context, "H").split(">").filter(Boolean);
  for (let i = 0; i < human.length && i < CONTEXT_WINDOW; i++) {
    const code = human[human.length - 1 - i];
    const index = MOVE_INDEX[code];
    if (index === undefined) continue;
    vector[HUMAN_AT + i * 3 + index] = recency(i);
  }

  const ai = field(context, "A").split(">").filter(Boolean);
  for (let i = 0; i < ai.length && i < AI_CONTEXT_WINDOW; i++) {
    const code = ai[ai.length - 1 - i];
    const index = MOVE_INDEX[code];
    if (index === undefined) continue;
    vector[AI_AT + i * 3 + index] = recency(i);
  }

  const outcomes = field(context, "out").split(",").filter(Boolean);
  for (let i = 0; i < outcomes.length && i < OUTCOME_SLOTS; i++) {
    const index = OUTCOME_INDEX[outcomes[outcomes.length - 1 - i]];
    if (index === undefined) continue;
    vector[OUTCOME_AT + i * 3 + index] = recency(i);
  }

  // Streak, e.g. "S3". Length is squashed rather than raw so a run of nine does
  // not dominate every other coordinate in the vector.
  const streak = field(context, "st");
  if (streak) {
    const index = MOVE_INDEX[streak[0]];
    const length = Number.parseInt(streak.slice(1), 10);
    if (index !== undefined) vector[STREAK_AT + index] = 1;
    if (Number.isFinite(length)) vector[STREAK_AT + 3] = Math.min(length, 6) / 6;
  }

  // Transitions, e.g. "RP,PP,PS" — this is the block that carries order, which
  // the frequency histogram below throws away.
  for (const pair of field(context, "bg").split(",").filter(Boolean)) {
    const from = MOVE_INDEX[pair[0]];
    const to = MOVE_INDEX[pair[1]];
    if (from === undefined || to === undefined) continue;
    vector[BIGRAM_AT + from * 3 + to] += 1;
  }

  // Frequencies, e.g. "R2P1S0", normalised so the block describes a mix rather
  // than a round count.
  const freq = field(context, "fq");
  const counts = MOVES.map((_, i) => {
    const letter = ["R", "P", "S"][i];
    const found = new RegExp(`${letter}(\\d+)`).exec(freq);
    return found ? Number.parseInt(found[1], 10) : 0;
  });
  const total = counts.reduce((sum, n) => sum + n, 0) || 1;
  for (let i = 0; i < 3; i++) vector[FREQ_AT + i] = counts[i] / total;

  // Where in the visit this is. Weighted so it identifies an opening without
  // swamping the move blocks once real history exists.
  vector[PHASE_AT] = human.length === 0 ? 1 : 0;
  vector[PHASE_AT + 1] = Math.min(human.length, CONTEXT_WINDOW) / CONTEXT_WINDOW;

  // L2 normalise, so cosine distance is 1 - dot and every consumer downstream
  // behaves exactly as it did with the transformer's normalised output.
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;

  return vector;
}

/** Exported for tests and for the "what is running" panel. */
export const FEATURE_MODEL_ID = "structured-rps-v1";

export type { Move, Outcome };
