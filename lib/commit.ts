/**
 * Pending move commitments.
 *
 * The AI picks its move before the human throws and publishes only
 * `sha256(move + ":" + nonce)`. After the throw it reveals the move and the
 * nonce, and the client recomputes the hash for itself.
 *
 * What that proves, and it is now weaker than it was: the move revealed is the
 * one already chosen when the hash was handed over, so it cannot have been
 * swapped after seeing the throw. But the seal and the check both happen in
 * the same browser since this stopped being a server game, which makes it a
 * demonstration of commit-reveal rather than a guarantee against anyone —
 * whoever can edit the page can edit both halves. The explainer panel says so
 * in as many words; presenting it as proof would be dishonest.
 *
 * The sequencing it enforces is real regardless, and that is what the game
 * actually needs: the move exists before the throw, and looking at it through
 * Foresight does not re-roll it.
 */

import type { Intent, Move, Reasoning } from "./types";

/** How long an unopened commitment stays valid. Generous — this is one player. */
const TTL_MS = 30 * 60 * 1000;

/** Hard cap on retained commitments, so an abandoned tab cannot grow the map. */
const MAX_PENDING = 500;

export interface PendingCommit {
  commitId: string;
  sessionId: string;
  nonce: string;
  hash: string;
  /** The move the AI has locked in. Not disclosed unless the player asks. */
  aiMove: Move;
  intent: Intent;
  reasoning: Reasoning;
  /** Everything needed to record the episode once the human throws. */
  context: string;
  tail: string;
  seq: number;
  round: number;
  /**
   * Identifies the database generation this commitment was made against, so a
   * memory reset between commit and throw invalidates it instead of recording
   * an episode whose `seq` refers to a store that no longer exists.
   */
  memoryGen: string;
  /** Controller integral to carry forward if this commitment is opened. */
  integral: number;
  createdAt: number;
  expiresAt: number;
}

interface SessionState {
  /** Accumulated score error for the Level controller. */
  integral: number;
}

const globalForCommits = globalThis as unknown as {
  __rpsPending?: Map<string, PendingCommit>;
  __rpsLatest?: Map<string, string>;
  __rpsSessions?: Map<string, SessionState>;
};

function pending(): Map<string, PendingCommit> {
  globalForCommits.__rpsPending ??= new Map();
  return globalForCommits.__rpsPending;
}

function latestBySession(): Map<string, string> {
  globalForCommits.__rpsLatest ??= new Map();
  return globalForCommits.__rpsLatest;
}

function sessions(): Map<string, SessionState> {
  globalForCommits.__rpsSessions ??= new Map();
  return globalForCommits.__rpsSessions;
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Async because Web Crypto is. The Node build hashed synchronously, but
 * `crypto.subtle` is the only SHA-256 a browser offers without shipping an
 * implementation, and the one caller was already in an async function.
 */
export async function commitmentHash(move: Move, nonce: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${move}:${nonce}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function newNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function newId(): string {
  return crypto.randomUUID();
}

export function getSessionState(sessionId: string): SessionState {
  const existing = sessions().get(sessionId);
  if (existing) return existing;
  const fresh: SessionState = { integral: 0 };
  sessions().set(sessionId, fresh);
  return fresh;
}

export function setSessionIntegral(sessionId: string, integral: number): void {
  getSessionState(sessionId).integral = integral;
}

/**
 * Store a commitment, superseding any earlier one for the same session.
 *
 * Only the newest commitment per session is valid. Without that, a client could
 * request several and then throw against whichever hash happened to suit it.
 */
export function putCommit(commit: PendingCommit): void {
  sweep();

  const previousId = latestBySession().get(commit.sessionId);
  if (previousId) pending().delete(previousId);

  pending().set(commit.commitId, commit);
  latestBySession().set(commit.sessionId, commit.commitId);
}

export type TakeResult =
  | { ok: true; commit: PendingCommit }
  | { ok: false; reason: "unknown" | "expired" | "superseded" };

/**
 * Consume a commitment. One shot: a commitId cannot be opened twice, so a
 * known move can never be replayed into a second round.
 */
export function takeCommit(commitId: string, sessionId: string): TakeResult {
  sweep();

  const commit = pending().get(commitId);
  if (!commit) return { ok: false, reason: "unknown" };

  if (commit.sessionId !== sessionId) return { ok: false, reason: "superseded" };
  if (latestBySession().get(sessionId) !== commitId) {
    pending().delete(commitId);
    return { ok: false, reason: "superseded" };
  }
  if (Date.now() > commit.expiresAt) {
    pending().delete(commitId);
    latestBySession().delete(sessionId);
    return { ok: false, reason: "expired" };
  }

  pending().delete(commitId);
  latestBySession().delete(sessionId);
  return { ok: true, commit };
}

/**
 * Look at a commitment without consuming it.
 *
 * This is how the Foresight view discloses the AI's move. Crucially it does not
 * mint a new commitment: peeking leaves the sealed move and its published hash
 * exactly as they were, so looking cannot re-roll what the AI is about to play.
 */
export function peekCommit(commitId: string, sessionId: string): TakeResult {
  sweep();

  const commit = pending().get(commitId);
  if (!commit) return { ok: false, reason: "unknown" };
  if (commit.sessionId !== sessionId) return { ok: false, reason: "superseded" };
  if (latestBySession().get(sessionId) !== commitId) {
    return { ok: false, reason: "superseded" };
  }
  if (Date.now() > commit.expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, commit };
}

/** Drop expired entries, and the oldest ones if the map is over its cap. */
function sweep(): void {
  const now = Date.now();
  const map = pending();

  for (const [id, commit] of map) {
    if (now > commit.expiresAt) {
      map.delete(id);
      if (latestBySession().get(commit.sessionId) === id) {
        latestBySession().delete(commit.sessionId);
      }
    }
  }

  if (map.size <= MAX_PENDING) return;

  const byAge = [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const commit of byAge.slice(0, map.size - MAX_PENDING)) {
    map.delete(commit.commitId);
    if (latestBySession().get(commit.sessionId) === commit.commitId) {
      latestBySession().delete(commit.sessionId);
    }
  }
}

export function expiryFrom(now: number): number {
  return now + TTL_MS;
}
