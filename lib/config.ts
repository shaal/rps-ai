/**
 * Tuning constants shared by the server engine and the client UI.
 *
 * Deliberately free of any server-only import so the client can display the
 * same thresholds the AI actually uses, instead of hard-coding its own copy
 * that could drift out of sync.
 */

/**
 * Episodes required before prediction is meaningful rather than noise.
 *
 * The only cold-start gate there is. A `BOOTSTRAP_ROUNDS` constant used to sit
 * beside this and force a few blind rounds at the start of every visit; it was
 * removed when memory became persistent, because by then it was discarding a
 * returning player's opening habit rather than protecting against noise.
 */
export const MIN_MEMORY_FOR_ADAPTIVE = 6;

/** Upper bound on neighbours retrieved per prediction. */
export const RECALL_K = 12;

/** Neighbours handed back to the UI: the scope plots all of them. */
export const NEIGHBORS_RETURNED = RECALL_K;
