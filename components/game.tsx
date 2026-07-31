"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MemoryPanel } from "./memory-panel";
import { MOVE_HEX, MOVE_LABEL, MoveGlyph } from "./move-glyph";
import { RevealPanel } from "./reveal-panel";
import { Telemetry } from "./telemetry";
import { BOOTSTRAP_ROUNDS } from "@/lib/config";
import { MODE_PROFILES } from "@/lib/predict";
import { MOVES } from "@/lib/rps";
import type {
  CommitResponse,
  Mode,
  Move,
  Outcome,
  RoundRecord,
  RoundResponse,
  StatusResponse,
} from "@/lib/types";

/**
 * Short beat so the reveal reads as an event rather than a flicker. The AI is
 * not thinking here — it committed before the throw — so this is presentation
 * only and deliberately brief.
 */
const REVEAL_BEAT_MS = 220;

const KEY_TO_MOVE: Record<string, Move> = { r: "rock", p: "paper", s: "scissors" };

const MODES: Mode[] = ["dominate", "level", "yield"];

const VERDICT: Record<Outcome, { label: string; hex: string }> = {
  win: { label: "You win", hex: "#3ddc97" },
  loss: { label: "AI wins", hex: "#ff4f6d" },
  draw: { label: "Draw", hex: "#7b8ea3" },
};

type Verification = "idle" | "ok" | "failed" | "unavailable";

export function Game() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [history, setHistory] = useState<RoundRecord[]>([]);
  const [last, setLast] = useState<RoundResponse | null>(null);
  const [commit, setCommit] = useState<CommitResponse | null>(null);
  const [resolving, setResolving] = useState(false);
  const [mode, setMode] = useState<Mode>("dominate");
  const [reveal, setReveal] = useState(false);
  const [verification, setVerification] = useState<Verification>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** Bumped to force a new commitment when history alone has not changed. */
  const [commitNonce, setCommitNonce] = useState(0);

  const ready = Boolean(status?.ready);

  /** No commitment in hand means one is on its way. */
  const committing = ready && commit === null;

  /** Synchronous latch — React state updates are async and two clicks can race. */
  const inFlight = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  /**
   * One stable session id per browser, so the server can supersede stale
   * commitments and keep controller state per player.
   *
   * Read lazily from inside callbacks rather than in an effect: it never needs
   * to trigger a render, and touching localStorage during render would break
   * server rendering.
   */
  const getSessionId = useCallback((): string => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const KEY = "rps-session-id";
    let existing = window.localStorage.getItem(KEY);
    if (!existing) {
      existing =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      window.localStorage.setItem(KEY, existing);
    }
    sessionIdRef.current = existing;
    return existing;
  }, []);

  // Poll until the embedder is up. The first ever run downloads the model, so
  // this can take a while and the UI says so rather than looking hung.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        const data = (await response.json()) as StatusResponse;
        if (cancelled) return;
        setStatus(data);
        if (!data.ready && !data.error) timer = setTimeout(poll, 900);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 1500);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  /**
   * Fetch a fresh commitment whenever anything it depends on changes: the
   * engine coming up, a completed round, a mode switch, or the reveal panel
   * opening (which changes whether the plaintext move is sent at all).
   *
   * The cancellation guard matters: toggling mode and reveal quickly fires
   * overlapping requests, and without it a slower earlier response could land
   * last and leave a commitment that does not match the current settings.
   */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: getSessionId(),
            mode,
            revealed: reveal,
            round: history.length + 1,
            history: history.map((round) => ({
              humanMove: round.humanMove,
              aiMove: round.aiMove,
              outcome: round.outcome,
            })),
          }),
        });
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(data?.error ?? "The AI could not lock in a move.");
        setCommit(data as CommitResponse);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Could not reach the AI.");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [ready, mode, reveal, history, commitNonce, getSessionId]);

  const play = useCallback(
    async (move: Move) => {
      if (inFlight.current || !ready || resetting || !commit) return;

      inFlight.current = true;
      setResolving(true);
      setError(null);
      setNotice(null);

      try {
        const [response] = await Promise.all([
          fetch("/api/round", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
            sessionId: getSessionId(),
            commitId: commit.commitId,
            humanMove: move,
          }),
          }),
          wait(REVEAL_BEAT_MS),
        ]);

        const data = await response.json();

        if (response.status === 409) {
          // The commitment went stale (expired, superseded, or the memory was
          // reset underneath it). Recoverable — take a fresh one and let the
          // player throw again.
          setNotice(
            `${data?.error ?? "That move expired."} A new one is locking in — throw again.`,
          );
          setCommit(null);
          setCommitNonce((n) => n + 1);
          return;
        }
        if (!response.ok) throw new Error(data?.error ?? "The round could not be played.");

        const result = data as RoundResponse;
        const { reasoning } = result;

        setVerification(await verifyCommitment(result));
        setLast(result);
        setHistory((previous) => [
          ...previous,
          {
            round: result.round,
            humanMove: result.humanMove,
            aiMove: result.aiMove,
            outcome: result.outcome,
            predictedHuman: reasoning.predictedHuman,
            predictionCorrect:
              reasoning.mode === "adaptive" && reasoning.predictedHuman
                ? reasoning.predictedHuman === result.humanMove
                : null,
            confidence: reasoning.confidence,
            neighbors: reasoning.neighbors,
            mode: reasoning.mode,
            intent: reasoning.intent,
            verified: true,
            ts: Date.now(),
          },
        ]);
        setStatus((previous) =>
          previous ? { ...previous, memorySize: result.memorySize } : previous,
        );
        // Drop the spent commitment. The history change re-runs the commit
        // effect, which locks in the next move straight away.
        setCommit(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
      } finally {
        inFlight.current = false;
        setResolving(false);
      }
    },
    [ready, resetting, commit, getSessionId],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      const move = KEY_TO_MOVE[event.key.toLowerCase()];
      if (!move) return;
      event.preventDefault();
      void play(move);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [play]);

  const resetMemory = useCallback(async () => {
    setResetting(true);
    setError(null);
    try {
      const response = await fetch("/api/reset", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "The memory could not be erased.");
      setStatus(data as StatusResponse);
      setHistory([]);
      setLast(null);
      setCommit(null);
      setVerification("idle");
      setCommitNonce((n) => n + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reset failed.");
    } finally {
      setResetting(false);
      setConfirmingReset(false);
    }
  }, []);

  const score = useMemo(() => {
    let you = 0;
    let ai = 0;
    for (const round of history) {
      if (round.outcome === "win") you++;
      else if (round.outcome === "loss") ai++;
    }
    return { you, ai };
  }, [history]);

  const adaptive = (last?.reasoning.mode ?? "bootstrap") === "adaptive";
  const roundsToAdaptive = Math.max(0, BOOTSTRAP_ROUNDS - history.length);

  return (
    <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 lg:py-10">
      <Header
        status={status}
        adaptive={adaptive}
        roundsToAdaptive={roundsToAdaptive}
        mode={mode}
        onMode={setMode}
        confirmingReset={confirmingReset}
        onRequestReset={() => setConfirmingReset(true)}
        onCancelReset={() => setConfirmingReset(false)}
        onConfirmReset={resetMemory}
        resetting={resetting}
        busy={resolving}
      />

      {error && (
        <p role="alert" className="panel border-loss/40 bg-loss/5 px-4 py-3 text-sm text-loss">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="panel border-warn/40 bg-warn/5 px-4 py-3 text-sm text-warn">
          {notice}
        </p>
      )}

      <main className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_370px]">
        <div className="flex flex-col gap-5">
          <Stage
            last={last}
            resolving={resolving}
            score={score}
            ready={ready}
            warming={Boolean(status?.warming)}
            commit={commit}
            committing={committing}
            verification={verification}
          />

          <RevealPanel
            open={reveal}
            onToggle={() => setReveal((open) => !open)}
            commit={commit}
            committing={committing}
          />

          <ThrowRow
            onPlay={play}
            disabled={!ready || resolving || resetting || !commit}
          />

          <Telemetry history={history} memorySize={status?.memorySize ?? 0} />
        </div>

        <MemoryPanel
          reasoning={last?.reasoning ?? null}
          scanning={resolving}
          round={last?.round ?? null}
        />
      </main>

      <Footer status={status} />

      {last?.outcome === "win" && <Confetti key={`win-${last.round}`} seed={last.round} />}
    </div>
  );
}

/** Recompute the commitment hash in the browser and compare. */
async function verifyCommitment(result: RoundResponse): Promise<Verification> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "unavailable";
  try {
    const bytes = new TextEncoder().encode(`${result.aiMove}:${result.nonce}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hex === result.hash ? "ok" : "failed";
  } catch {
    return "unavailable";
  }
}

/* ------------------------------------------------------------------ header */

function Header({
  status,
  adaptive,
  roundsToAdaptive,
  mode,
  onMode,
  confirmingReset,
  onRequestReset,
  onCancelReset,
  onConfirmReset,
  resetting,
  busy,
}: {
  status: StatusResponse | null;
  adaptive: boolean;
  roundsToAdaptive: number;
  mode: Mode;
  onMode: (value: Mode) => void;
  confirmingReset: boolean;
  onRequestReset: () => void;
  onCancelReset: () => void;
  onConfirmReset: () => void;
  resetting: boolean;
  busy: boolean;
}) {
  return (
    <header className="animate-rise flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl leading-none font-extrabold tracking-[-0.02em] uppercase sm:text-3xl">
            Adaptive <span className="text-scissors">RPS</span>
          </h1>
          <p className="mt-1.5 text-sm text-dim">
            It locks in its move before you throw, then stores the round. The longer
            you play, the better it reads you.
          </p>
        </div>
        <ModeBadge status={status} adaptive={adaptive} roundsToAdaptive={roundsToAdaptive} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line p-1" role="group" aria-label="What the AI plays for">
          {MODES.map((level) => {
            const active = mode === level;
            return (
              <button
                key={level}
                type="button"
                onClick={() => onMode(level)}
                title={MODE_PROFILES[level].blurb}
                aria-pressed={active}
                className={`readout rounded-md px-3 py-1.5 text-[11px] tracking-wide uppercase transition-colors ${
                  active ? "bg-scissors/15 text-scissors" : "text-faint hover:text-dim"
                }`}
              >
                {MODE_PROFILES[level].label}
              </button>
            );
          })}
        </div>

        <p className="hidden text-[11px] text-faint sm:block">{MODE_PROFILES[mode].blurb}</p>

        <div className="flex-1" />

        <a
          href="/api/export"
          download
          className="readout rounded-lg border border-line px-3 py-2 text-[11px] tracking-wide text-faint uppercase transition-colors hover:border-line-lit hover:text-dim"
        >
          Export memory
        </a>

        {confirmingReset ? (
          <div className="flex items-center gap-2">
            <span className="readout text-[11px] text-warn">
              Erase {status?.memorySize ?? 0} episodes?
            </span>
            <button
              type="button"
              onClick={onConfirmReset}
              disabled={resetting}
              className="readout rounded-lg border border-loss/50 bg-loss/10 px-3 py-2 text-[11px] tracking-wide text-loss uppercase transition-colors hover:bg-loss/20 disabled:opacity-50"
            >
              {resetting ? "Erasing…" : "Erase"}
            </button>
            <button
              type="button"
              onClick={onCancelReset}
              disabled={resetting}
              className="readout rounded-lg border border-line px-3 py-2 text-[11px] tracking-wide text-faint uppercase transition-colors hover:text-dim"
            >
              Keep
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onRequestReset}
            disabled={busy || resetting}
            className="readout rounded-lg border border-line px-3 py-2 text-[11px] tracking-wide text-faint uppercase transition-colors hover:border-loss/50 hover:text-loss disabled:opacity-40"
          >
            Reset AI memory
          </button>
        )}
      </div>
    </header>
  );
}

function ModeBadge({
  status,
  adaptive,
  roundsToAdaptive,
}: {
  status: StatusResponse | null;
  adaptive: boolean;
  roundsToAdaptive: number;
}) {
  if (!status || status.warming) {
    return (
      <Badge hex="#ffb454" pulsing>
        <span>Loading model</span>
        <span className="text-faint">first run downloads ~23MB</span>
      </Badge>
    );
  }

  if (status.error) {
    return (
      <Badge hex="#ff4f6d">
        <span>Memory offline</span>
        <span className="text-faint">see the message below</span>
      </Badge>
    );
  }

  if (!adaptive) {
    return (
      <Badge hex="#ffb454">
        <span>Bootstrapping</span>
        <span className="text-faint">
          {roundsToAdaptive > 0
            ? `${roundsToAdaptive} more round${roundsToAdaptive === 1 ? "" : "s"} of blind play`
            : "building its first memories"}
        </span>
      </Badge>
    );
  }

  return (
    <Badge hex="#2fe0cf">
      <span>Adaptive</span>
      <span className="text-faint">{status.memorySize} memories in play</span>
    </Badge>
  );
}

function Badge({
  hex,
  pulsing = false,
  children,
}: {
  hex: string;
  pulsing?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-full border px-3.5 py-2"
      style={{ borderColor: `${hex}55`, background: `${hex}0f` }}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${pulsing ? "animate-blink" : ""}`}
        style={{ background: hex, boxShadow: `0 0 10px ${hex}` }}
      />
      <div className="readout flex flex-col text-[10px] leading-tight tracking-wide uppercase">
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- stage */

function Stage({
  last,
  resolving,
  score,
  ready,
  warming,
  commit,
  committing,
  verification,
}: {
  last: RoundResponse | null;
  resolving: boolean;
  score: { you: number; ai: number };
  ready: boolean;
  warming: boolean;
  commit: CommitResponse | null;
  committing: boolean;
  verification: Verification;
}) {
  const verdict = last ? VERDICT[last.outcome] : null;

  return (
    <section
      key={last?.round ?? "empty"}
      className={`panel overflow-hidden p-6 sm:p-8 ${
        last?.outcome === "loss" && !resolving ? "animate-shake" : ""
      }`}
      aria-live="polite"
    >
      <div className="flex items-center justify-center gap-6 sm:gap-10">
        <ScoreColumn label="You" value={score.you} hex="#3ddc97" />
        <span className="readout text-xs text-faint">vs</span>
        <ScoreColumn label="AI" value={score.ai} hex="#ff4f6d" align="right" />
      </div>

      <div className="mt-7 grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
        <HandCard move={last?.humanMove ?? null} caption="Your throw" />
        <div
          className="readout text-center text-[11px] tracking-[0.2em] uppercase"
          style={{ color: verdict?.hex ?? "#4d6076" }}
        >
          {resolving ? "…" : verdict ? verdict.label : "—"}
        </div>
        <HandCard move={resolving ? null : (last?.aiMove ?? null)} caption="AI throw" />
      </div>

      <p className="mt-6 text-center text-sm text-dim">
        {warming
          ? "Warming up the embedding model. This only takes a moment after the first run."
          : !ready
            ? "Waiting for the memory engine."
            : last
              ? <ReadLine last={last} />
              : "Throw to begin. The AI plays blind until it has something to remember."}
      </p>

      <CommitmentStrip commit={commit} committing={committing} last={last} verification={verification} />
    </section>
  );
}

/**
 * The commitment status line: the hash the AI published before the throw, and
 * whether the revealed move actually matched it.
 */
function CommitmentStrip({
  commit,
  committing,
  last,
  verification,
}: {
  commit: CommitResponse | null;
  committing: boolean;
  last: RoundResponse | null;
  verification: Verification;
}) {
  const pendingHash = commit?.hash;

  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-line pt-4">
      {committing || !pendingHash ? (
        <span className="readout text-[10px] text-faint">Locking in the next move…</span>
      ) : (
        <span className="readout text-[10px] text-faint">
          next move locked · sha256 {pendingHash.slice(0, 8)}…{pendingHash.slice(-4)}
        </span>
      )}

      {last && verification !== "idle" && (
        <span
          className="readout text-[10px]"
          style={{
            color:
              verification === "ok"
                ? "#3ddc97"
                : verification === "failed"
                  ? "#ff4f6d"
                  : "#4d6076",
          }}
        >
          {verification === "ok"
            ? "✓ last move matched its hash"
            : verification === "failed"
              ? "✗ hash mismatch — the move changed"
              : "· hash check unavailable"}
        </span>
      )}
    </div>
  );
}

/** One honest sentence about what the AI did and why. */
function ReadLine({ last }: { last: RoundResponse }) {
  const { reasoning } = last;

  if (reasoning.mode === "bootstrap") {
    return <>Still bootstrapping — that throw was random, but it was recorded.</>;
  }

  const read = reasoning.predictedHuman;
  if (!read) return <>Nothing similar in memory yet, so it threw blind.</>;

  const readMark = <strong style={{ color: MOVE_HEX[read] }}>{MOVE_LABEL[read]}</strong>;

  if (reasoning.explored) {
    return <>It read {readMark} but threw at random anyway.</>;
  }

  const verb =
    reasoning.intent === "lose"
      ? "and dropped the round on purpose"
      : reasoning.intent === "draw"
        ? "and played for a draw"
        : "and countered";

  const target = reasoning.playedAgainst;
  if (target && target !== read) {
    return (
      <>
        It read {readMark} at {Math.round(reasoning.distribution[read] * 100)}%, took the
        odds on <strong style={{ color: MOVE_HEX[target] }}>{MOVE_LABEL[target]}</strong>,{" "}
        {verb}.
      </>
    );
  }

  return (
    <>
      It read {readMark} from {reasoning.neighbors} similar memor
      {reasoning.neighbors === 1 ? "y" : "ies"} {verb}.
    </>
  );
}

function ScoreColumn({
  label,
  value,
  hex,
  align = "left",
}: {
  label: string;
  value: number;
  hex: string;
  align?: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : "text-left"}>
      <p className="eyebrow">{label}</p>
      <p className="readout mt-1 text-4xl leading-none font-bold sm:text-5xl" style={{ color: hex }}>
        {String(value).padStart(2, "0")}
      </p>
    </div>
  );
}

function HandCard({ move, caption }: { move: Move | null; caption: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5">
      <div
        className="flex aspect-square w-full max-w-[132px] items-center justify-center rounded-2xl border transition-colors"
        style={{
          borderColor: move ? `${MOVE_HEX[move]}55` : "#1a2534",
          background: move ? `${MOVE_HEX[move]}0f` : "rgba(5,7,12,0.5)",
          color: move ? MOVE_HEX[move] : "#2b3a4d",
        }}
      >
        {move ? (
          <span className="animate-pop">
            <MoveGlyph move={move} size={56} />
          </span>
        ) : (
          <span className="readout text-2xl text-faint">?</span>
        )}
      </div>
      <p className="eyebrow">{caption}</p>
    </div>
  );
}

/* -------------------------------------------------------------- throw row */

function ThrowRow({ onPlay, disabled }: { onPlay: (move: Move) => void; disabled: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {MOVES.map((move) => (
        <button
          key={move}
          type="button"
          onClick={() => onPlay(move)}
          disabled={disabled}
          className="throw"
          style={{ "--throw-hue": MOVE_HEX[move] } as React.CSSProperties}
        >
          <MoveGlyph move={move} size={40} />
          <span className="text-sm font-semibold tracking-wide uppercase">
            {MOVE_LABEL[move]}
          </span>
          <span className="throw-key">press {move[0].toUpperCase()}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ footer */

function Footer({ status }: { status: StatusResponse | null }) {
  if (!status) return null;
  return (
    <footer className="flex flex-col gap-2">
      <p className="readout flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-faint">
        <span>{status.model}</span>
        <span>{status.dimensions}d · cosine</span>
        <span>engine: {status.implementation}</span>
        {status.initMs !== null && <span>init {status.initMs}ms</span>}
        <span className="truncate">{status.storagePath}</span>
      </p>
      <p className="text-[10px] leading-relaxed text-faint">
        The hash check proves the AI&apos;s move did not change after you threw. It is not
        a guarantee that the server is honest in general — it could always have committed
        to a bad move in the first place.
      </p>
    </footer>
  );
}

/* ---------------------------------------------------------------- confetti */

const CONFETTI_HEXES = ["#3ddc97", "#2fe0cf", "#9d8cff", "#ff9f45"];

/**
 * Seeded so render stays pure — React 19 rightly rejects `Math.random()` during
 * render. Seeding on the round number keeps each burst different anyway.
 */
function Confetti({ seed }: { seed: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 26 }, (_, index) => {
        const at = (salt: number) => noise(seed * 97 + index * 7 + salt);
        return {
          id: index,
          left: 12 + at(1) * 76,
          dx: `${(at(2) - 0.5) * 220}px`,
          spin: `${at(3) * 900 - 450}deg`,
          dur: `${1000 + at(4) * 700}ms`,
          delay: `${at(5) * 160}ms`,
          hex: CONFETTI_HEXES[index % CONFETTI_HEXES.length],
        };
      }),
    [seed],
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0" aria-hidden>
      {bits.map((bit) => (
        <span
          key={bit.id}
          className="confetti-bit"
          style={
            {
              left: `${bit.left}%`,
              top: "18vh",
              background: bit.hex,
              "--dx": bit.dx,
              "--spin": bit.spin,
              "--dur": bit.dur,
              animationDelay: bit.delay,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic 0..1 from an integer seed. */
function noise(seed: number): number {
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
