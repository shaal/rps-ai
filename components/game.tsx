"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MemoryPanel } from "./memory-panel";
import { MOVE_HEX, MOVE_LABEL, MoveGlyph } from "./move-glyph";
import { Telemetry } from "./telemetry";
import { BOOTSTRAP_ROUNDS } from "@/lib/config";
import { DIFFICULTY_PROFILES } from "@/lib/predict";
import { MOVES } from "@/lib/rps";
import type {
  Difficulty,
  Move,
  Outcome,
  RoundRecord,
  RoundResponse,
  StatusResponse,
} from "@/lib/types";

/** Floor on the "thinking" beat so the search always reads as deliberate. */
const MIN_THINK_MS = 620;

const KEY_TO_MOVE: Record<string, Move> = {
  r: "rock",
  p: "paper",
  s: "scissors",
};

const DIFFICULTIES: Difficulty[] = ["casual", "rival", "ruthless"];

const VERDICT: Record<Outcome, { label: string; hex: string }> = {
  win: { label: "You win", hex: "#3ddc97" },
  loss: { label: "AI wins", hex: "#ff4f6d" },
  draw: { label: "Draw", hex: "#7b8ea3" },
};

export function Game() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [history, setHistory] = useState<RoundRecord[]>([]);
  const [last, setLast] = useState<RoundResponse | null>(null);
  const [thinking, setThinking] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>("rival");
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const ready = Boolean(status?.ready);

  /**
   * Synchronous in-flight latch. `thinking` drives the UI, but a state update
   * is async — two clicks landing in the same tick would both pass a state
   * check and play two rounds off one intent.
   */
  const inFlight = useRef(false);

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

  const play = useCallback(
    async (move: Move) => {
      if (inFlight.current || !ready || resetting) return;

      inFlight.current = true;
      setThinking(true);
      setError(null);

      const payload = {
        humanMove: move,
        difficulty,
        round: history.length + 1,
        history: history.map((round) => ({
          humanMove: round.humanMove,
          aiMove: round.aiMove,
          outcome: round.outcome,
        })),
      };

      try {
        const [response] = await Promise.all([
          fetch("/api/round", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
          wait(MIN_THINK_MS),
        ]);

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error ?? "The round could not be played.");
        }

        const result = data as RoundResponse;
        const { reasoning } = result;

        setLast(result);
        setHistory((previous) => [
          ...previous,
          {
            round: result.round,
            humanMove: result.humanMove,
            aiMove: result.aiMove,
            outcome: result.outcome,
            predictedHuman: reasoning.predictedHuman,
            // Only a real read can be scored. Bootstrap throws are not guesses.
            predictionCorrect:
              reasoning.mode === "adaptive" && reasoning.predictedHuman
                ? reasoning.predictedHuman === result.humanMove
                : null,
            confidence: reasoning.confidence,
            neighbors: reasoning.neighbors,
            mode: reasoning.mode,
            ts: Date.now(),
          },
        ]);
        setStatus((previous) =>
          previous ? { ...previous, memorySize: result.memorySize } : previous,
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
      } finally {
        inFlight.current = false;
        setThinking(false);
      }
    },
    [ready, resetting, difficulty, history],
  );

  // Keyboard throws.
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
        difficulty={difficulty}
        onDifficulty={setDifficulty}
        confirmingReset={confirmingReset}
        onRequestReset={() => setConfirmingReset(true)}
        onCancelReset={() => setConfirmingReset(false)}
        onConfirmReset={resetMemory}
        resetting={resetting}
        busy={thinking}
      />

      {error && (
        <p
          role="alert"
          className="panel border-loss/40 bg-loss/5 px-4 py-3 text-sm text-loss"
        >
          {error}
        </p>
      )}

      <main className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_370px]">
        <div className="flex flex-col gap-5">
          <Stage
            last={last}
            thinking={thinking}
            score={score}
            ready={ready}
            warming={Boolean(status?.warming)}
          />

          <ThrowRow onPlay={play} disabled={!ready || thinking || resetting} />

          <Telemetry history={history} memorySize={status?.memorySize ?? 0} />
        </div>

        <MemoryPanel reasoning={last?.reasoning ?? null} scanning={thinking} />
      </main>

      <Footer status={status} />

      {last?.outcome === "win" && <Confetti key={`win-${last.round}`} seed={last.round} />}
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({
  status,
  adaptive,
  roundsToAdaptive,
  difficulty,
  onDifficulty,
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
  difficulty: Difficulty;
  onDifficulty: (value: Difficulty) => void;
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
            Every round you play is embedded and stored. The longer you play, the
            better it reads you.
          </p>
        </div>
        <ModeBadge status={status} adaptive={adaptive} roundsToAdaptive={roundsToAdaptive} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex rounded-lg border border-line p-1"
          role="group"
          aria-label="Difficulty"
        >
          {DIFFICULTIES.map((level) => {
            const active = difficulty === level;
            return (
              <button
                key={level}
                type="button"
                onClick={() => onDifficulty(level)}
                title={DIFFICULTY_PROFILES[level].blurb}
                aria-pressed={active}
                className={`readout rounded-md px-3 py-1.5 text-[11px] tracking-wide uppercase transition-colors ${
                  active ? "bg-scissors/15 text-scissors" : "text-faint hover:text-dim"
                }`}
              >
                {DIFFICULTY_PROFILES[level].label}
              </button>
            );
          })}
        </div>

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
  thinking,
  score,
  ready,
  warming,
}: {
  last: RoundResponse | null;
  thinking: boolean;
  score: { you: number; ai: number };
  ready: boolean;
  warming: boolean;
}) {
  const verdict = last ? VERDICT[last.outcome] : null;

  return (
    <section
      key={last?.round ?? "empty"}
      className={`panel overflow-hidden p-6 sm:p-8 ${
        last?.outcome === "loss" && !thinking ? "animate-shake" : ""
      }`}
      aria-live="polite"
    >
      <div className="flex items-center justify-center gap-6 sm:gap-10">
        <ScoreColumn label="You" value={score.you} hex="#3ddc97" />
        <span className="readout text-xs text-faint">vs</span>
        <ScoreColumn label="AI" value={score.ai} hex="#ff4f6d" align="right" />
      </div>

      <div className="mt-7 grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
        <HandCard move={last?.humanMove ?? null} caption="Your throw" thinking={false} />

        <div
          className="readout text-center text-[11px] tracking-[0.2em] uppercase"
          style={{ color: verdict?.hex ?? "#4d6076" }}
        >
          {thinking ? "…" : verdict ? verdict.label : "—"}
        </div>

        <HandCard move={thinking ? null : (last?.aiMove ?? null)} caption="AI throw" thinking={thinking} />
      </div>

      <p className="mt-6 text-center text-sm text-dim">
        {warming
          ? "Warming up the embedding model. This only takes a moment after the first run."
          : !ready
            ? "Waiting for the memory engine."
            : thinking
              ? "Searching memory for situations like this one…"
              : last
                ? <ReadLine last={last} />
                : "Throw to begin. The AI plays blind until it has something to remember."}
      </p>
    </section>
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

  const readMark = (
    <strong style={{ color: MOVE_HEX[read] }}>{MOVE_LABEL[read]}</strong>
  );

  if (reasoning.explored) {
    return <>It read {readMark} but threw at random anyway.</>;
  }

  // Sampling can land on an underdog. Saying so keeps this line consistent with
  // the probability bars, which always highlight the argmax.
  const target = reasoning.playedAgainst;
  if (target && target !== read) {
    return (
      <>
        It read {readMark} at {Math.round(reasoning.distribution[read] * 100)}%, took
        the odds on{" "}
        <strong style={{ color: MOVE_HEX[target] }}>{MOVE_LABEL[target]}</strong>, and
        countered that.
      </>
    );
  }

  return (
    <>
      It read {readMark} from {reasoning.neighbors} similar memor
      {reasoning.neighbors === 1 ? "y" : "ies"} and countered.
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
      <p
        className="readout mt-1 text-4xl leading-none font-bold sm:text-5xl"
        style={{ color: hex }}
      >
        {String(value).padStart(2, "0")}
      </p>
    </div>
  );
}

function HandCard({
  move,
  caption,
  thinking,
}: {
  move: Move | null;
  caption: string;
  thinking: boolean;
}) {
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
        {thinking ? (
          <span className="animate-blink text-scissors">
            <MoveGlyph move="scissors" size={44} />
          </span>
        ) : move ? (
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

function ThrowRow({
  onPlay,
  disabled,
}: {
  onPlay: (move: Move) => void;
  disabled: boolean;
}) {
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
    <footer className="readout flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-faint">
      <span>{status.model}</span>
      <span>{status.dimensions}d · cosine</span>
      <span>engine: {status.implementation}</span>
      {status.initMs !== null && <span>init {status.initMs}ms</span>}
      <span className="truncate">{status.storagePath}</span>
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
