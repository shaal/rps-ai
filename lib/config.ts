/**
 * Tuning constants shared by the server engine and the client UI.
 *
 * Deliberately free of any server-only import so the client can display the
 * same thresholds the AI actually uses, instead of hard-coding its own copy
 * that could drift out of sync.
 */

/** Rounds played with no memory lookup at all, so the store can bootstrap. */
export const BOOTSTRAP_ROUNDS = 5;

/** Episodes required before prediction is meaningful rather than noise. */
export const MIN_MEMORY_FOR_ADAPTIVE = 6;

/** Upper bound on neighbours retrieved per prediction. */
export const RECALL_K = 12;

/** Neighbours handed back to the UI: the scope plots all of them. */
export const NEIGHBORS_RETURNED = RECALL_K;
