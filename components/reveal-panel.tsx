"use client";

import { MOVE_HEX, MOVE_LABEL, MoveGlyph } from "./move-glyph";
import { MOVES } from "@/lib/rps";
import type { CommitResponse, Intent, Move } from "@/lib/types";

const INTENT_COPY: Record<Intent, { label: string; line: string; hex: string }> = {
  win: {
    label: "Playing to win",
    line: "It picked the move that beats what it expects from you.",
    hex: "#ff4f6d",
  },
  draw: {
    label: "Playing to draw",
    line: "It mirrored what it expects, which holds the score steady.",
    hex: "#7b8ea3",
  },
  lose: {
    label: "Throwing the round",
    line: "It picked the move your expected throw beats.",
    hex: "#3ddc97",
  },
};

/**
 * The AI's pending commitment, shown before the player throws.
 *
 * Opening this makes the game trivially winnable, which is the point — it turns
 * the opponent into something you can inspect instead of something you have to
 * trust. Hidden by default so ordinary play is not spoiled.
 */
export function RevealPanel({
  open,
  onToggle,
  commit,
  committing,
}: {
  open: boolean;
  onToggle: () => void;
  commit: CommitResponse | null;
  committing: boolean;
}) {
  const reveal = commit?.reveal ?? null;
  const round = commit?.round ?? null;

  return (
    <section className="panel overflow-hidden" aria-label="The AI's committed move">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-raised/60"
      >
        <span className="flex items-center gap-3">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background: open ? "#ffb454" : "#2b3a4d",
              boxShadow: open ? "0 0 10px #ffb454" : "none",
            }}
          />
          <span>
            <span className="eyebrow block">The AI&apos;s hand</span>
            <span className="mt-0.5 block text-sm text-dim">
              {open
                ? "You can see its move. You should win every round."
                : "Reveal the move it has already locked in."}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {/* Names the round explicitly. This panel is always one ahead of the
              memory panel, which describes the round already played. */}
          {round !== null && (
            <span className="readout hidden text-[10px] text-faint sm:inline">
              round {round} · not thrown yet
            </span>
          )}
          <span className="readout text-[11px] tracking-wide text-faint uppercase">
            {open ? "Hide" : "Show"}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-5 py-5">
          {committing || !reveal ? (
            <p className="readout text-xs text-faint">
              {committing ? "Locking in the next move…" : "No move committed yet."}
            </p>
          ) : (
            <RevealBody move={reveal.aiMove} reveal={reveal} />
          )}
        </div>
      )}
    </section>
  );
}

function RevealBody({
  move,
  reveal,
}: {
  move: Move;
  reveal: NonNullable<CommitResponse["reveal"]>;
}) {
  const { reasoning } = reveal;
  const intent = INTENT_COPY[reasoning.intent];

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
      <div className="flex shrink-0 flex-col items-center gap-2">
        <div
          className="flex aspect-square w-[110px] items-center justify-center rounded-2xl border"
          style={{
            borderColor: `${MOVE_HEX[move]}66`,
            background: `${MOVE_HEX[move]}12`,
            color: MOVE_HEX[move],
          }}
        >
          <MoveGlyph move={move} size={52} />
        </div>
        <p className="readout text-sm font-semibold" style={{ color: MOVE_HEX[move] }}>
          {MOVE_LABEL[move]}
        </p>
        <p className="eyebrow">Locked in</p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div>
          <p className="readout text-[11px] tracking-wide uppercase" style={{ color: intent.hex }}>
            {intent.label}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-dim">{intent.line}</p>
          {reasoning.control?.note && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
              {reasoning.control.note}
            </p>
          )}
        </div>

        {reasoning.mode === "bootstrap" ? (
          <p className="text-[11px] leading-relaxed text-warn">
            Still bootstrapping — this throw is random and carries no read.
          </p>
        ) : (
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h3 className="eyebrow">It expects you to play</h3>
              <span className="readout text-[10px] text-faint">
                confidence {Math.round(reasoning.confidence * 100)}%
              </span>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-faint">
              Its read for the round you are about to throw.
            </p>
            <div className="flex flex-col gap-1.5">
              {MOVES.map((candidate) => {
                const share = reasoning.distribution[candidate];
                const leading = reasoning.predictedHuman === candidate;
                return (
                  <div key={candidate} className="flex items-center gap-3">
                    <span
                      className="readout w-16 shrink-0 text-[11px]"
                      style={{ color: leading ? MOVE_HEX[candidate] : undefined }}
                    >
                      {MOVE_LABEL[candidate]}
                    </span>
                    <div className="bar-track flex-1">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.max(Math.round(share * 100), 1.5)}%`,
                          background: MOVE_HEX[candidate],
                          opacity: leading ? 1 : 0.45,
                        }}
                      />
                    </div>
                    <span className="readout w-9 shrink-0 text-right text-[11px] text-dim">
                      {Math.round(share * 100)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <h3 className="eyebrow mb-1.5">Pattern it matched</h3>
          <p className="readout rounded-lg border border-line bg-void/60 p-2.5 text-[11px] leading-relaxed break-words text-dim">
            {reasoning.context}
          </p>
        </div>
      </div>
    </div>
  );
}
