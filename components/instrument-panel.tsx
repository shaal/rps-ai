"use client";

import { useState } from "react";

import { Explainer } from "./explainer";
import { MOVE_HEX, MOVE_LABEL, MoveGlyph } from "./move-glyph";
import { ProximityScope } from "./proximity-scope";
import { MOVES } from "@/lib/rps";
import type { Intent, Move, PeekResponse, Reasoning } from "@/lib/types";

/** Which round the instrument is pointed at. */
export type View = "hindsight" | "foresight";

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
 * One instrument, two faces.
 *
 * Hindsight reads the round just played; Foresight reads the round already
 * sealed but not yet thrown. They were separate panels once, which put two
 * different rounds on screen at the same time and made their confidence
 * figures look contradictory. Showing exactly one round at a time removes that
 * by construction, and the flip makes the shared machinery obvious.
 */
export function InstrumentPanel({
  view,
  onView,
  hindsight,
  hindsightRound,
  foresight,
  scanning,
  peeking,
}: {
  view: View;
  onView: (next: View) => void;
  hindsight: Reasoning | null;
  hindsightRound: number | null;
  foresight: PeekResponse | null;
  scanning: boolean;
  peeking: boolean;
}) {
  const flipped = view === "foresight";

  /** True only while a turn is in flight, to gate the depth animation. */
  const [flipping, setFlipping] = useState(false);

  const turnTo = (next: View) => {
    if (next !== view) setFlipping(true);
    onView(next);
  };

  return (
    <section className="panel flex flex-col p-5" aria-label="AI instrument">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="eyebrow">Instrument</h2>
            <Explainer label="How the AI predicts your next throw" title="How it reads you">
              <p>
                After every round the AI writes itself a short note about the situation: what
                you both just played, who is ahead, how the last few rounds went. That note is
                then turned into a long list of numbers — think of it as a position on a map,
                where notes describing similar situations end up near each other.
              </p>
              <p>
                Before your next throw it writes a note about <strong>right now</strong>, finds
                its nearest notes from the past, and reads what you did next in each of them.
                The answer that keeps coming up is its prediction, and closer memories count
                for more than distant ones.
              </p>
              <p>
                That is the whole trick. It is not reasoning about rock, paper and scissors —
                it is asking <strong>“when things looked like this before, what did this person
                do?”</strong> Which is why it knows nothing until you have given it a handful
                of rounds to remember.
              </p>
              <p>
                The dial below is that lookup, drawn. Every dot is one memory, coloured by what
                you played next. The nearer the centre, the more similar it was — and the
                bigger the dot, the more it counted toward the guess.
              </p>
            </Explainer>
          </div>
          <span className="readout text-[0.6875rem] text-faint">
            {flipped
              ? foresight
                ? `round ${foresight.round} · sealed`
                : "sealing…"
              : hindsightRound !== null
                ? `round ${hindsightRound} · played`
                : "nothing played yet"}
          </span>
        </div>

        <div
          className="grid grid-cols-2 gap-1 rounded-lg border border-line-control p-1"
          role="group"
          aria-label="Which round to inspect"
        >
          <FaceTab active={!flipped} onClick={() => turnTo("hindsight")} label="Hindsight" />
          <FaceTab active={flipped} onClick={() => turnTo("foresight")} label="Foresight" />
        </div>

        <p className="text-[0.75rem] leading-relaxed text-faint">
          {flipped
            ? "Showing the move it has already sealed. You can win every round from here."
            : "Showing how it read the round you just played."}
        </p>
      </header>

      <div className="flip-scene mt-5">
        {/* The depth dip runs here rather than on the rotating element: it is
            out-and-back within a single flip, so it has to be a keyframe
            animation, and animation and transition cannot both own `transform`
            on one element. Driven from the click and cleared on animationend —
            no effect, no timer. */}
        <div
          className={`flip-depth ${flipping ? "is-flipping" : ""}`}
          onAnimationEnd={() => setFlipping(false)}
        >
          <div className={`flip-inner ${flipped ? "is-flipped" : ""}`}>
            {/* Both faces stay mounted so the flip has something to reveal. The
                inactive one is inert, so it is not focusable and screen readers
                do not announce the round you are not looking at. */}
            <div className="flip-face" data-active={!flipped} inert={flipped}>
              <HindsightFace reasoning={hindsight} scanning={scanning} />
            </div>
            <div className="flip-face flip-face--back" data-active={flipped} inert={!flipped}>
              <ForesightFace peek={foresight} peeking={peeking} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FaceTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`readout rounded-md px-3 py-1.5 text-[0.75rem] tracking-wide uppercase transition-colors ${
        active ? "bg-scissors/15 text-scissors" : "text-faint hover:text-dim"
      }`}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------- hindsight */

function HindsightFace({
  reasoning,
  scanning,
}: {
  reasoning: Reasoning | null;
  scanning: boolean;
}) {
  const neighbors = reasoning?.topNeighbors ?? [];

  return (
    <div className="flex flex-col gap-5">
      <ProximityScope neighbors={neighbors} scanning={scanning} />
      <div className="hairline" />

      <Section title="Context it matched">
        <CodeBlock>{reasoning?.context ?? "—"}</CodeBlock>
        <Caption>
          This exact string is embedded and matched against every past situation.
        </Caption>
      </Section>

      <div className="hairline" />

      {!reasoning || reasoning.mode === "bootstrap" ? (
        <Section title="What it expected from you">
          <Caption>
            The AI is still bootstrapping — it throws blind until it has enough
            episodes to search.
          </Caption>
        </Section>
      ) : (
        <>
          <ReadBlock
            title="What it expected from you"
            caption="Its read going into the round you just played."
            reasoning={reasoning}
          />
          {neighbors.length > 0 && !scanning && (
            <>
              <div className="hairline" />
              <NeighborList neighbors={neighbors.slice(0, 3)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- foresight */

function ForesightFace({ peek, peeking }: { peek: PeekResponse | null; peeking: boolean }) {
  if (!peek) {
    return (
      <p className="readout text-xs text-faint">
        {peeking ? "Opening the sealed move…" : "No move sealed yet."}
      </p>
    );
  }

  const { reasoning } = peek;
  const intent = INTENT_COPY[reasoning.intent];
  const neighbors = reasoning.topNeighbors ?? [];

  return (
    <div className="flex flex-col gap-5">
      <SealedMove move={peek.aiMove} intent={intent} reasoning={reasoning} />

      <div className="hairline" />

      <ProximityScope neighbors={neighbors} scanning={false} />

      {reasoning.mode === "bootstrap" ? (
        <>
          <div className="hairline" />
          <p className="text-[0.75rem] leading-relaxed text-warn">
            Still bootstrapping — this throw is random and carries no read.
          </p>
        </>
      ) : (
        <>
          <div className="hairline" />
          <ReadBlock
            title="It expects you to play"
            caption="Its read for the round you are about to throw."
            reasoning={reasoning}
          />
          <div className="hairline" />
          <Section title="Pattern it matched">
            <CodeBlock>{reasoning.context}</CodeBlock>
          </Section>
          {neighbors.length > 0 && (
            <>
              <div className="hairline" />
              <NeighborList neighbors={neighbors.slice(0, 3)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SealedMove({
  move,
  intent,
  reasoning,
}: {
  move: Move;
  intent: (typeof INTENT_COPY)[Intent];
  reasoning: Reasoning;
}) {
  const { predictedHuman, playedAgainst, explored, control } = reasoning;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div
          className="flex aspect-square w-[86px] shrink-0 items-center justify-center rounded-2xl border"
          style={{
            borderColor: `${MOVE_HEX[move]}66`,
            background: `${MOVE_HEX[move]}12`,
            color: MOVE_HEX[move],
          }}
        >
          <MoveGlyph move={move} size={42} />
        </div>
        <div className="min-w-0">
          <p className="eyebrow">Sealed move</p>
          <p
            className="readout mt-0.5 text-lg leading-none font-semibold"
            style={{ color: MOVE_HEX[move] }}
          >
            {MOVE_LABEL[move]}
          </p>
          <p
            className="readout mt-2 text-[0.6875rem] tracking-wide uppercase"
            style={{ color: intent.hex }}
          >
            {intent.label}
          </p>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-dim">{intent.line}</p>
        </div>
      </div>

      {/* Without this the face contradicts itself: it can show a 67% read on
          Scissors, say "playing to win", and then seal Scissors — which only
          makes sense once you know it sampled an underdog to play against. */}
      {explored ? (
        <p className="text-[0.75rem] leading-relaxed text-warn">
          It is ignoring its read this round and throwing at random.
        </p>
      ) : playedAgainst && predictedHuman && playedAgainst !== predictedHuman ? (
        <p className="text-[0.75rem] leading-relaxed text-faint">
          It sampled{" "}
          <strong style={{ color: MOVE_HEX[playedAgainst] }}>
            {MOVE_LABEL[playedAgainst]}
          </strong>{" "}
          to play against rather than its top read (
          <strong style={{ color: MOVE_HEX[predictedHuman] }}>
            {MOVE_LABEL[predictedHuman]}
          </strong>
          ), so it does not become a fixed function of your history.
        </p>
      ) : null}

      {control?.note && (
        <p className="text-[0.75rem] leading-relaxed text-faint">{control.note}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- shared */

function ReadBlock({
  title,
  caption,
  reasoning,
}: {
  title: string;
  caption: string;
  reasoning: Reasoning;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        <span className="readout text-[0.6875rem] text-faint">
          confidence {Math.round(reasoning.confidence * 100)}%
        </span>
      </div>
      <p className="mb-3 text-[0.75rem] leading-relaxed text-faint">{caption}</p>

      <div className="flex flex-col gap-2">
        {MOVES.map((move) => (
          <DistributionRow
            key={move}
            move={move}
            share={reasoning.distribution[move]}
            leading={reasoning.predictedHuman === move}
          />
        ))}
      </div>

      {/* The raw inputs behind the confidence number, so it can be checked
          rather than taken on faith. */}
      <dl className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <Metric label="neighbors" value={String(reasoning.neighbors)} />
        <Metric label="margin" value={`${Math.round(reasoning.margin * 100)}%`} />
        <Metric label="eff. N" value={reasoning.effectiveN.toFixed(1)} />
        <Metric label="mean dist" value={reasoning.meanDistance.toFixed(3)} />
      </dl>

      {reasoning.explored && (
        <p className="mt-3 text-[0.75rem] leading-relaxed text-warn">
          Ignoring its read this round and throwing at random.
        </p>
      )}
    </div>
  );
}

function DistributionRow({
  move,
  share,
  leading,
}: {
  move: Move;
  share: number;
  leading: boolean;
}) {
  const percent = Math.round(share * 100);
  return (
    <div className="flex items-center gap-3">
      <span
        className="readout w-16 shrink-0 text-[0.75rem]"
        style={{ color: leading ? MOVE_HEX[move] : undefined }}
      >
        {MOVE_LABEL[move]}
      </span>
      <div className="bar-track flex-1">
        <div
          className="bar-fill"
          style={{
            width: `${Math.max(percent, 1.5)}%`,
            background: MOVE_HEX[move],
            opacity: leading ? 1 : 0.45,
          }}
        />
      </div>
      <span className="readout w-9 shrink-0 text-right text-[0.75rem] text-dim">{percent}%</span>
    </div>
  );
}

function NeighborList({ neighbors }: { neighbors: Reasoning["topNeighbors"] }) {
  return (
    <div>
      <h3 className="eyebrow mb-2">Strongest memories</h3>
      <ul className="flex flex-col gap-2">
        {neighbors.map((neighbor) => (
          <li key={neighbor.id} className="rounded-lg border border-line bg-void/40 p-2.5">
            <div className="readout flex items-center justify-between text-[0.6875rem] text-faint">
              <span>episode {neighbor.meta.seq + 1}</span>
              <span>d {neighbor.distance.toFixed(3)}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className="text-[0.75rem] text-dim">
                you then played{" "}
                <span
                  className="font-semibold"
                  style={{ color: MOVE_HEX[neighbor.meta.nextHumanMove] }}
                >
                  {MOVE_LABEL[neighbor.meta.nextHumanMove]}
                </span>
              </span>
              <span className="readout text-[0.6875rem] text-faint">
                {Math.round(neighbor.influence * 100)}% weight
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <p className="readout rounded-lg border border-line bg-void/60 p-3 text-[0.75rem] leading-relaxed break-words text-dim">
      {children}
    </p>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[0.75rem] leading-relaxed text-faint">{children}</p>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-void/50 py-2">
      <dt className="eyebrow">{label}</dt>
      <dd className="readout mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}
