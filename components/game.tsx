"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  CommitmentError,
  commitRound,
  exportEpisodes,
  getStatus,
  peekRound,
  resetMemory as resetStore,
  resolveRound,
  warmup,
} from "@/lib/engine";
import { Explainer } from "./explainer";
import { InstrumentPanel, type View } from "./instrument-panel";
import { MOVE_HEX, MOVE_LABEL, MoveGlyph } from "./move-glyph";
import { Telemetry } from "./telemetry";
import { MIN_MEMORY_FOR_ADAPTIVE, RECALL_K } from "@/lib/config";
import { MODE_PROFILES } from "@/lib/predict";
import { MOVES } from "@/lib/rps";
import type {
  CommitResponse,
  Mode,
  Move,
  Outcome,
  PeekResponse,
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

const SHORTCUTS_KEY = "rps-shortcuts";

/** How long the throw row waits before introducing itself, once it is usable. */
const INTRO_SWEEP_MS = 3000;

/**
 * The shortcut preference kept outside React, so it can be read during render
 * rather than patched in by an effect after the first paint.
 *
 * `useSyncExternalStore` is built for exactly this: it renders the server
 * snapshot (on), then reconciles against the real stored value once hydrated,
 * without the mismatch a bare localStorage read during render would cause.
 */
const shortcutStore = {
  listeners: new Set<() => void>(),
  subscribe(listener: () => void) {
    shortcutStore.listeners.add(listener);
    return () => {
      shortcutStore.listeners.delete(listener);
    };
  },
  /** Anything but an explicit "off" means on, so a fresh browser gets keys. */
  get: () => window.localStorage.getItem(SHORTCUTS_KEY) !== "off",
  set(on: boolean) {
    window.localStorage.setItem(SHORTCUTS_KEY, on ? "on" : "off");
    for (const listener of shortcutStore.listeners) listener();
  },
};

const MODES: Mode[] = ["dominate", "level", "yield"];

/**
 * One colour per side of the table, used by the scoreline and by the ring
 * around whichever hand took the round. Tied to the side rather than to the
 * outcome, so green always means you and red always means the machine.
 */
const SIDE_HEX = { you: "#3ddc97", ai: "#ff4f6d" } as const;

const VERDICT: Record<Outcome, { label: string; hex: string }> = {
  win: { label: "You win", hex: SIDE_HEX.you },
  loss: { label: "AI wins", hex: SIDE_HEX.ai },
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
  const [view, setView] = useState<View>("hindsight");
  const [peek, setPeek] = useState<PeekResponse | null>(null);
  const [verification, setVerification] = useState<Verification>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  /**
   * R/P/S are single-character shortcuts with no modifier, so WCAG 2.1.4 wants
   * them switchable off — otherwise anyone driving the page by voice control
   * fires a throw every time they say a word starting with those letters.
   * Defaults on, and the choice sticks.
   */
  const shortcuts = useSyncExternalStore(shortcutStore.subscribe, shortcutStore.get, () => true);
  /** Bumped to force a new commitment when history alone has not changed. */
  const [commitNonce, setCommitNonce] = useState(0);

  const ready = Boolean(status?.ready);

  /** No commitment in hand means one is on its way. */
  const committing = ready && commit === null;

  /** The sealed move for the pending round is still being fetched. */
  const peeking = view === "foresight" && commit !== null && peek?.commitId !== commit.commitId;

  /** Synchronous latch — React state updates are async and two clicks can race. */
  const inFlight = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  /**
   * The current view, readable without making it a commit dependency.
   *
   * The server only uses it as a hint for the Level controller (which stops
   * steering against a player who can see its hand). Making it a dependency
   * would re-commit on every flip, and re-committing would mint a new move and
   * a new hash — so looking at the answer would change the answer.
   */
  const viewRef = useRef<View>("hindsight");
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

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
        warmup();
        const data = await getStatus();
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
        const data = await commitRound({
          sessionId: getSessionId(),
          mode,
          revealed: viewRef.current === "foresight",
          round: history.length + 1,
          history: history.map((round) => ({
            humanMove: round.humanMove,
            aiMove: round.aiMove,
            outcome: round.outcome,
          })),
        });
        if (cancelled) return;
        setCommit(data);
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
  }, [ready, mode, history, commitNonce, getSessionId]);

  /**
   * Open the sealed move when the instrument is pointed at Foresight.
   *
   * Read-only on the server: it does not consume or replace the commitment, so
   * flipping back and forth never changes what the AI is about to play, and the
   * hash already on screen stays the one that gets verified.
   */
  useEffect(() => {
    if (view !== "foresight" || !commit) return;
    if (peek?.commitId === commit.commitId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const data = await peekRound({
          sessionId: getSessionId(),
          commitId: commit.commitId,
        });
        if (cancelled) return;
        setPeek(data);
      } catch {
        // A stale commitment resolves itself: the commit effect fetches a new
        // one and this runs again against it.
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [view, commit, peek?.commitId, getSessionId]);

  const play = useCallback(
    async (move: Move) => {
      if (inFlight.current || !ready || resetting || !commit) return;

      inFlight.current = true;
      setResolving(true);
      setError(null);
      setNotice(null);

      try {
        let result: RoundResponse;
        try {
          [result] = await Promise.all([
            resolveRound({
              sessionId: getSessionId(),
              commitId: commit.commitId,
              humanMove: move,
            }),
            wait(REVEAL_BEAT_MS),
          ]);
        } catch (caught) {
          if (caught instanceof CommitmentError) {
            // The commitment went stale (expired, superseded, or the memory was
            // reset underneath it). Recoverable — take a fresh one and let the
            // player throw again. This used to arrive as an HTTP 409.
            setNotice(`${caught.message} A new one is locking in — throw again.`);
            setCommit(null);
            setCommitNonce((n) => n + 1);
            return;
          }
          throw caught;
        }

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

  const toggleShortcuts = useCallback(() => {
    shortcutStore.set(!shortcutStore.get());
  }, []);

  useEffect(() => {
    if (!shortcuts) return;

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
  }, [play, shortcuts]);

  const resetMemory = useCallback(async () => {
    setResetting(true);
    setError(null);
    try {
      await resetStore();
      setStatus(await getStatus());
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

  /**
   * Before the first throw of a visit there is no round to describe, so fall
   * back to the gate itself. Reading it purely from the last round meant a
   * returning player with a full memory was labelled as still learning, right
   * up until the throw that proved otherwise.
   */
  const adaptive = last
    ? last.reasoning.mode === "adaptive"
    : (status?.memorySize ?? 0) >= MIN_MEMORY_FOR_ADAPTIVE;
  /** The other half of the gate in `think()`, which the badge used to ignore. */
  const memoriesNeeded = Math.max(0, MIN_MEMORY_FOR_ADAPTIVE - (status?.memorySize ?? 0));

  /**
   * One sentence per round, for anyone who is not watching the cards.
   *
   * The stage used to be the live region itself, which failed twice over: it
   * is keyed on the round number, so it was torn down and rebuilt at the exact
   * moment its contents changed — and a live region inserted alongside its own
   * update is usually not announced at all — and being the whole panel, it
   * re-read the score, both hands and the commitment hash every time. A small
   * stable region that never unmounts says the result once, in order.
   */
  const announcement = useMemo(() => {
    if (status?.warming) return "Loading the memory model.";
    if (!ready) return "Waiting for the memory engine.";
    if (!last) return "Ready. Throw to begin.";
    return (
      `Round ${last.round}. You played ${MOVE_LABEL[last.humanMove]}, ` +
      `the AI played ${MOVE_LABEL[last.aiMove]}. ${VERDICT[last.outcome].label}. ` +
      `Score: you ${score.you}, AI ${score.ai}.`
    );
  }, [status?.warming, ready, last, score]);

  return (
    <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-6 lg:py-10">
      <a href="#game" className="skip-link">
        Skip to the game
      </a>

      <Header />

      <p className="sr-only" role="status">
        {announcement}
      </p>

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

      {/* tabIndex -1 so the skip link can land here. Programmatic focus does
          not satisfy :focus-visible, so this never draws a stray ring. */}
      <main
        id="game"
        tabIndex={-1}
        className="grid flex-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_370px]"
      >
        <div className="flex flex-col gap-4 sm:gap-5">
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

          <ThrowRow
            onPlay={play}
            disabled={!ready || resolving || resetting || !commit}
            shortcuts={shortcuts}
          />

          {/* Below the throws on purpose. These are once-a-session controls,
              and on a small phone every row above the buttons is a row of the
              actual game pushed off the bottom of the screen. Moved in the
              DOM rather than reordered in CSS, so the keyboard walks them in
              the order they appear. */}
          <Controls
            status={status}
            adaptive={adaptive}
            memoriesNeeded={memoriesNeeded}
            mode={mode}
            onMode={setMode}
            confirmingReset={confirmingReset}
            onRequestReset={() => setConfirmingReset(true)}
            onCancelReset={() => setConfirmingReset(false)}
            onConfirmReset={resetMemory}
            resetting={resetting}
            busy={resolving}
            shortcuts={shortcuts}
            onToggleShortcuts={toggleShortcuts}
          />

          <Telemetry history={history} memorySize={status?.memorySize ?? 0} />
        </div>

        <InstrumentPanel
          view={view}
          onView={setView}
          hindsight={last?.reasoning ?? null}
          hindsightRound={last?.round ?? null}
          foresight={peek}
          scanning={resolving}
          peeking={peeking}
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

/**
 * Nothing but the title now.
 *
 * The blurb, the status badge and every control used to live here, which cost
 * 234px above the fold — on a 667px-tall phone that is the difference between
 * seeing the buttons you throw with and not. They moved below the throws; what
 * is left is the one line that says what you are looking at.
 */
function Header() {
  return (
    <header className="animate-rise">
      <h1 className="text-2xl leading-none font-extrabold tracking-[-0.02em] uppercase sm:text-3xl">
        Adaptive <span className="text-scissors">RPS</span>
      </h1>
    </header>
  );
}

function Controls({
  status,
  adaptive,
  memoriesNeeded,
  mode,
  onMode,
  confirmingReset,
  onRequestReset,
  onCancelReset,
  onConfirmReset,
  resetting,
  busy,
  shortcuts,
  onToggleShortcuts,
}: {
  status: StatusResponse | null;
  adaptive: boolean;
  memoriesNeeded: number;
  mode: Mode;
  onMode: (value: Mode) => void;
  confirmingReset: boolean;
  onRequestReset: () => void;
  onCancelReset: () => void;
  onConfirmReset: () => void;
  resetting: boolean;
  busy: boolean;
  shortcuts: boolean;
  onToggleShortcuts: () => void;
}) {
  /**
   * Reset swaps one button for two and back again, which leaves focus on a
   * node that no longer exists — the keyboard lands back at the top of the
   * document. Follow the control instead: into the confirmation, then back out
   * to where the trip started.
   */
  const resetRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirmingReset) confirmRef.current?.focus();
    else if (wasConfirming.current) resetRef.current?.focus();
    wasConfirming.current = confirmingReset;
  }, [confirmingReset]);

  return (
    <section className="flex flex-col gap-4" aria-label="Game settings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-dim">
          It locks in its move before you throw, then stores the round. The longer
          you play, the better it reads you.
        </p>
        <ModeBadge
          status={status}
          adaptive={adaptive}
          memoriesNeeded={memoriesNeeded}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* The modes are the one place the game can act against its own read —
            Level and Yield throw rounds on purpose. Nothing on screen said so,
            which is the sort of thing that feels like a cheat once you find it
            out for yourself. */}
        <Explainer
          label="What the three modes change about the AI's play"
          title="What the modes do"
        >
          <p>
            These change what the AI <strong>does with a read</strong>, not how hard it tries
            to read you. The prediction runs at full strength in all three.
          </p>
          <p>
            <strong>Dominate</strong> — plays the move that beats what it expects. No
            handicap.
          </p>
          <p>
            <strong>Level</strong> — steers toward a tied score. When it is ahead it will
            draw or <strong>lose rounds on purpose</strong> to let you back in. Open Foresight
            and it stops steering rather than escalate against someone who can see its hand.
          </p>
          <p>
            <strong>Yield</strong> — once its read is strong enough, it deliberately plays the
            move yours beats. The better it knows you, the more easily you win. On a weak read
            it holds instead, rather than throwing at random into a loss.
          </p>
          <p>
            So Dominate is a match, Level is a sparring partner, and Yield is an opponent
            that folds as soon as it is sure.
          </p>
        </Explainer>

        <div
          className="flex rounded-lg border border-line-control p-1"
          role="group"
          aria-label="What the AI plays for"
        >
          {MODES.map((level) => {
            const active = mode === level;
            return (
              <button
                key={level}
                type="button"
                onClick={() => onMode(level)}
                title={MODE_PROFILES[level].blurb}
                aria-pressed={active}
                className={`readout rounded-md px-3 py-1.5 text-[0.75rem] tracking-wide uppercase transition-colors ${
                  active ? "bg-scissors/15 text-scissors" : "text-faint hover:text-dim"
                }`}
              >
                {MODE_PROFILES[level].label}
              </button>
            );
          })}
        </div>

        <p className="hidden text-[0.75rem] text-faint sm:block">{MODE_PROFILES[mode].blurb}</p>

        <div className="flex-1" />

        <button
          type="button"
          onClick={onToggleShortcuts}
          aria-pressed={shortcuts}
          className="readout rounded-lg border border-line-control px-3 py-2 text-[0.75rem] tracking-wide text-faint uppercase transition-colors hover:border-line-lit hover:text-dim"
        >
          Keys {shortcuts ? "on" : "off"}
          {/* `aria-pressed` already carries the state, so this only has to say
              what the shortcuts are — otherwise it reads "keys off, R P and S
              throw", which is the opposite of the truth. */}
          <span className="sr-only"> — single-key throw shortcuts R, P and S</span>
        </button>

        {/* No server to download from any more — the file is built from the
            store and handed to the browser as a blob. */}
        <button
          type="button"
          onClick={async () => {
            const { jsonl, count } = await exportEpisodes();
            const url = URL.createObjectURL(
              new Blob([jsonl], { type: "application/x-ndjson" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = `rps-memory-${count}-episodes.jsonl`;
            link.click();
            URL.revokeObjectURL(url);
          }}
          title="Download every episode as newline-delimited JSON — about 200 bytes each"
          className="readout rounded-lg border border-line-control px-3 py-2 text-[0.75rem] tracking-wide text-faint uppercase transition-colors hover:border-line-lit hover:text-dim"
        >
          Export memory
        </button>

        {confirmingReset ? (
          <div className="flex items-center gap-2">
            <span className="readout text-[0.75rem] text-warn">
              Erase {status?.memorySize ?? 0} episodes?
            </span>
            <button
              ref={confirmRef}
              type="button"
              onClick={resetting ? undefined : onConfirmReset}
              aria-disabled={resetting}
              className="readout rounded-lg border border-loss/50 bg-loss/10 px-3 py-2 text-[0.75rem] tracking-wide text-loss uppercase transition-colors hover:bg-loss/20"
            >
              {resetting ? "Erasing…" : "Erase"}
            </button>
            <button
              type="button"
              onClick={resetting ? undefined : onCancelReset}
              aria-disabled={resetting}
              className="readout rounded-lg border border-line-control px-3 py-2 text-[0.75rem] tracking-wide text-faint uppercase transition-colors hover:text-dim"
            >
              Keep
            </button>
          </div>
        ) : (
          <button
            ref={resetRef}
            type="button"
            onClick={busy || resetting ? undefined : onRequestReset}
            aria-disabled={busy || resetting}
            className="readout rounded-lg border border-line-control px-3 py-2 text-[0.75rem] tracking-wide text-faint uppercase transition-colors hover:border-loss/50 hover:text-loss aria-disabled:cursor-not-allowed"
          >
            Reset AI memory
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Reports the one gate that remains: how full this browser's memory is.
 *
 * It used to also count down rounds in the current visit, which is why a
 * returning player with a full memory was told they were "bootstrapping" — the
 * countdown was real, the implication that nothing had been learned was not.
 * That gate is gone; see the note in `think()`.
 */
function ModeBadge({
  status,
  adaptive,
  memoriesNeeded,
}: {
  status: StatusResponse | null;
  adaptive: boolean;
  memoriesNeeded: number;
}) {
  if (!status || status.warming) {
    return (
      <Badge hex="#ffb454" pulsing>
        <span>Starting up</span>
        <span className="text-faint">opening this browser&apos;s memory</span>
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
        <span>Learning you</span>
        <span className="text-faint">
          {memoriesNeeded > 0
            ? `throwing blind for ${memoriesNeeded} more round${memoriesNeeded === 1 ? "" : "s"}`
            : "ready — it reads you from the next throw"}
        </span>
      </Badge>
    );
  }

  return (
    <Badge hex="#2fe0cf">
      <span>Adaptive</span>
      <span className="text-faint">
        {status.memorySize} memor{status.memorySize === 1 ? "y" : "ies"} in this browser
      </span>
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
      <div className="readout flex flex-col text-[0.6875rem] leading-tight tracking-wide uppercase">
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
  /** The outcome of a round that is actually over, or null mid-reveal. */
  const settled = last && !resolving ? last.outcome : null;

  return (
    <section
      key={last?.round ?? "empty"}
      className={`panel overflow-hidden p-5 sm:p-8 ${
        last?.outcome === "loss" && !resolving ? "animate-shake" : ""
      }`}
    >
      <div className="flex items-center justify-center gap-6 sm:gap-10">
        <ScoreColumn label="You" value={score.you} hex={SIDE_HEX.you} />
        <span className="readout text-xs text-faint">vs</span>
        <ScoreColumn label="AI" value={score.ai} hex={SIDE_HEX.ai} align="right" />
      </div>

      {/* The verdict calls the round before you look down at the hands, and
          moving it out of the middle gives both cards the width to be read at
          a glance. `settled` gates the ring on a finished round: during the
          reveal beat `last` still holds the previous round, and a ring drawn
          from it would crown the wrong hand for a moment. */}
      <div className="mt-6 flex flex-col items-center gap-4 sm:mt-7 sm:gap-5">
        <p
          className="readout text-center text-[0.75rem] tracking-[0.2em] uppercase"
          style={{ color: verdict?.hex ?? "var(--color-faint)" }}
        >
          {resolving ? "…" : verdict ? verdict.label : "—"}
        </p>

        <div className="grid w-full grid-cols-2 items-start gap-4 sm:gap-8">
          <HandCard
            move={last?.humanMove ?? null}
            caption="Your throw"
            wonHex={settled === "win" ? SIDE_HEX.you : null}
          />
          <HandCard
            move={resolving ? null : (last?.aiMove ?? null)}
            caption="AI throw"
            wonHex={settled === "loss" ? SIDE_HEX.ai : null}
          />
        </div>
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

      <div className="mt-6 flex items-center justify-center gap-2 border-t border-line pt-4">
        <span className="eyebrow">Sealed before you threw</span>
        <SealExplainer
          commit={commit}
          committing={committing}
          last={last}
          verification={verification}
        />
      </div>
    </section>
  );
}

/**
 * The commitment mechanism, explained — with its live state folded in.
 *
 * The fingerprint and the pass/fail mark used to sit on the stage as a line of
 * hex nobody could act on. They are still computed and still checked; they
 * just live behind the question mark now, next to the explanation of what they
 * are for. Dropping them outright was the other option, but then the claim
 * that your browser verifies the move would have nothing standing behind it.
 */
function SealExplainer({
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
    <Explainer label="What the locked move means, and what it does not" title="Why the move is locked">
      <p>
        Before you throw, the AI has already picked its move. It turns that pick into a
        fingerprint — the string of letters and numbers below — and shows it to you first.
      </p>
      <p>
        After the round, this page opens the move, rebuilds the fingerprint from scratch and
        checks the two match. Changing the move by a single letter would scramble the
        fingerprint completely. The ✓ or ✗ below is that check, run just now.
      </p>
      <p>
        <strong>What this shows:</strong> the sealed choice did not change after you threw.
      </p>
      <p>
        <strong>What it does not show:</strong> that the choice was a fair one. There is no
        referee — since this game stopped using a server, the opponent and the checker are
        both this browser, and anyone who can edit the page can edit both. Treat it as a
        working demonstration of commit-and-reveal, not as a guarantee.
      </p>

      <p className="readout mt-3 border-t border-line pt-3">
        {committing || !pendingHash
          ? "Sealing the next move…"
          : `Next move · sha256 ${pendingHash.slice(0, 12)}…${pendingHash.slice(-6)}`}
      </p>

      {last && verification !== "idle" && (
        <p
          className="readout"
          style={{
            color:
              verification === "ok"
                ? SIDE_HEX.you
                : verification === "failed"
                  ? SIDE_HEX.ai
                  : "var(--color-faint)",
          }}
        >
          {verification === "ok"
            ? "✓ Last round: the revealed move matched its fingerprint."
            : verification === "failed"
              ? "✗ Last round: mismatch — the move changed."
              : "· This browser cannot run the check."}
        </p>
      )}
    </Explainer>
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

function HandCard({
  move,
  caption,
  wonHex,
}: {
  move: Move | null;
  caption: string;
  /** This side's colour when it took the round, otherwise null. */
  wonHex?: string | null;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5">
      <div
        className="flex aspect-square w-full max-w-[176px] items-center justify-center rounded-2xl border transition-colors"
        style={{
          borderColor: move ? `${MOVE_HEX[move]}55` : "var(--color-line)",
          background: move ? `${MOVE_HEX[move]}0f` : "rgba(5,7,12,0.5)",
          color: move ? MOVE_HEX[move] : "#2b3a4d",
          // `outline` rather than a wider border: it is drawn outside the box,
          // so the winning card does not shrink its own contents or shift the
          // pair out of alignment.
          ...(wonHex
            ? { outline: `4px solid ${wonHex}`, outlineOffset: "4px" }
            : null),
        }}
      >
        {move ? (
          <span className="animate-pop">
            <MoveGlyph move={move} size={76} />
          </span>
        ) : (
          <span className="readout text-3xl text-faint" aria-hidden>
            ?
          </span>
        )}
        {/* The glyph is decorative — the mark alone carries the move for the
            eye, but there is nothing here to read otherwise. The ring is pure
            reinforcement of the verdict sitting directly above, so it needs no
            text of its own. */}
        <span className="sr-only">{move ? MOVE_LABEL[move] : "Nothing thrown yet"}</span>
      </div>
      <p className="eyebrow">{caption}</p>
    </div>
  );
}

/* -------------------------------------------------------------- throw row */

/**
 * `aria-disabled` rather than `disabled`, deliberately.
 *
 * These buttons switch off for the beat it takes to resolve a round, and a
 * genuinely disabled button leaves the tab order — so the button you just
 * pressed vanished from under the keyboard and focus fell back to <body>.
 * Every round meant tabbing in from the top of the page again. Marked this
 * way the button stays put and stays focusable, still announces as
 * unavailable, and the guard below is what actually blocks the throw.
 */
function ThrowRow({
  onPlay,
  disabled,
  shortcuts,
}: {
  onPlay: (move: Move) => void;
  disabled: boolean;
  shortcuts: boolean;
}) {
  /** The move whose one-shot glow is currently playing, if any. */
  const [lit, setLit] = useState<Move | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const introShown = useRef(false);

  /**
   * One pass across the row shortly after arriving, so the buttons introduce
   * themselves instead of waiting to be discovered.
   *
   * Timed from the moment they become usable rather than from page load. The
   * sweep skips disabled buttons by design, and on a first ever run the engine
   * is still fetching its model well past the three second mark — counting
   * from load would spend the introduction on a row that cannot light up.
   *
   * The guard is set when the timer fires, not when it is scheduled: React
   * mounts effects twice in development, and claiming the slot up front would
   * mean the second mount skips it and the intro never appears.
   */
  useEffect(() => {
    if (introShown.current || disabled) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const timer = setTimeout(() => {
      introShown.current = true;
      setSweeping(true);
    }, INTRO_SWEEP_MS);

    return () => clearTimeout(timer);
  }, [disabled]);

  /**
   * The idle sweep, scheduled one hop at a time rather than on an interval so
   * the gap between runs can be re-rolled each time \u2014 a fixed cadence starts
   * reading as a metronome after the second or third pass.
   *
   * Nothing is scheduled at all when the reader has asked for less motion;
   * suppressing it in CSS alone would leave a pointless timer running and
   * re-rendering forever.
   */
  useEffect(() => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      timer = setTimeout(
        () => {
          setSweeping(true);
          schedule();
        },
        // 7-14s. Long enough to stay ambient rather than chatty.
        7000 + Math.random() * 7000,
      );
    };

    const sync = () => {
      clearTimeout(timer);
      if (!calm.matches) schedule();
    };

    sync();
    calm.addEventListener("change", sync);
    return () => {
      clearTimeout(timer);
      calm.removeEventListener("change", sync);
    };
  }, []);

  return (
    <div
      className={`throw-row grid grid-cols-3 gap-3 ${sweeping ? "is-sweeping" : ""}`}
      // Animation events bubble, so one handler serves the whole row. The
      // sweep is only over once its last, most-delayed button has finished.
      onAnimationEnd={(event) => {
        const el = event.target as HTMLElement;
        if (el.dataset.sweepLast === "true") setSweeping(false);
        if (el.dataset.move === lit) setLit(null);
      }}
    >
      {MOVES.map((move, index) => (
        <button
          key={move}
          type="button"
          data-move={move}
          data-sweep-last={index === MOVES.length - 1}
          onClick={
            disabled
              ? undefined
              : () => {
                  setLit(move);
                  onPlay(move);
                }
          }
          aria-disabled={disabled}
          className={`throw ${lit === move ? "is-lit" : ""}`}
          style={
            {
              "--throw-hue": MOVE_HEX[move],
              "--sweep-delay": `${index * 150}ms`,
            } as React.CSSProperties
          }
        >
          <MoveGlyph move={move} size={40} />
          <span className="text-sm font-semibold tracking-wide uppercase">
            {MOVE_LABEL[move]}
          </span>
          {/* Held open when shortcuts are off so the row does not resize. */}
          <span className="throw-key" aria-hidden>
            {shortcuts ? `press ${move[0].toUpperCase()}` : "\u00a0"}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ footer */

/**
 * What used to be a dump of the model name, vector width, engine and absolute
 * database path. All of it is still here — one question mark down, where it
 * can be read as prose instead of decoded.
 */
function Footer({ status }: { status: StatusResponse | null }) {
  if (!status) return null;
  return (
    <footer className="flex items-center justify-center gap-2">
      <span className="eyebrow">Runs entirely on this machine</span>
      <Explainer label="What is running behind the game" title="What's running">
        <p>
          Everything runs in this browser. No account, no server opponent, no round leaves
          the machine — the AI, its memory and the fingerprint check all happen here.
        </p>
        <p>
          <strong>Memory persists.</strong> Episodes are kept in this browser&apos;s own
          storage and are still here when you come back, until you press{" "}
          <strong>Reset AI memory</strong> or clear site data. It is per browser, so a
          different browser, or someone else on this machine, meets a blank opponent.{" "}
          <strong>Export memory</strong> downloads every round as plain text.
        </p>
        <p>
          <strong>The read is not a language model.</strong> A small hand-written encoder
          turns each situation code into {status.dimensions} numbers, and the search is an
          exact comparison against every stored episode — up to {RECALL_K} nearest, then a
          weighted vote on what you played next.
        </p>
        <p>
          <strong>The throw is not always the read.</strong> On a brand-new browser it is
          random until the memory fills. After that it usually counters its top read, but it
          deliberately samples a runner-up now and then so it cannot be reverse-engineered —
          and the mode can override the whole thing and aim for a draw or a loss.
        </p>
      </Explainer>
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
