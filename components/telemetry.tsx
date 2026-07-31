"use client";

import { Explainer } from "./explainer";
import { MOVE_HEX, MoveGlyph } from "./move-glyph";
import type { Outcome, RoundRecord } from "@/lib/types";

const OUTCOME_HEX: Record<Outcome, string> = {
  win: "#3ddc97",
  loss: "#ff4f6d",
  draw: "#7b8ea3",
};

/** So the result of a round survives being read in greyscale. */
const OUTCOME_MARK: Record<Outcome, string> = { win: "W", loss: "L", draw: "D" };

export function Telemetry({
  history,
  memorySize,
}: {
  history: RoundRecord[];
  memorySize: number;
}) {
  const rounds = history.length;

  // Only rounds where the AI actually committed to a read can be scored. Its
  // bootstrap throws are not predictions and would dilute the number.
  const scored = history.filter((round) => round.predictionCorrect !== null);
  const hits = scored.filter((round) => round.predictionCorrect).length;
  const accuracy = scored.length > 0 ? hits / scored.length : 0;

  const streak = trailingWinStreak(history);
  const best = bestWinStreak(history);

  return (
    <section className="panel p-5" aria-label="Session telemetry">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="eyebrow">Telemetry</h2>
          <Explainer
            label="How to read these numbers, and what counts as the AI winning"
            title="Reading these numbers"
          >
            <p>
              <strong>AI read rate</strong> is how often it correctly guessed your next throw.
              The number to compare it against is <strong>33%</strong>, not 50% — with three
              moves, blind guessing is right one time in three.
            </p>
            <p>
              So above 33% means it has genuinely found a pattern in how you play. At or below
              it, you are being unpredictable enough that its memory is not buying it
              anything. That is the line drawn across the chart.
            </p>
            <p>
              Early rounds are left out of this. The AI throws at random until it has enough
              memories to search, and counting those as correct guesses would flatter the
              number.
            </p>
            <p>
              <strong>Read rate is not the score.</strong> In Dominate a good read usually
              becomes a win — but in Level or Yield the AI may draw or lose the round on
              purpose, so you can be well ahead on points while it still reads you accurately.
            </p>
            <p>
              Want an easy win? Flip the instrument to <strong>Foresight</strong>. It shows
              the sealed move before you throw, and looking does not change it.
            </p>
          </Explainer>
        </div>
        <span className="readout text-[0.6875rem] text-faint">
          {memorySize} episode{memorySize === 1 ? "" : "s"} stored
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="rounds" value={String(rounds)} />
        <Stat
          label="AI read rate"
          value={scored.length > 0 ? `${Math.round(accuracy * 100)}%` : "—"}
          hint={scored.length > 0 ? `${hits}/${scored.length}` : "no reads yet"}
        />
        <Stat label="win streak" value={String(streak)} />
        <Stat label="best streak" value={String(best)} />
      </dl>

      {scored.length >= 2 && (
        <div className="mt-5">
          <div className="mb-1.5 flex items-baseline justify-between">
            <h3 className="eyebrow">Read rate over time</h3>
            <span className="readout text-[0.6875rem] text-faint">33% = chance</span>
          </div>
          <AccuracySparkline history={scored} />
        </div>
      )}

      {rounds > 0 && (
        <div className="mt-5">
          <h3 className="eyebrow mb-2">Recent rounds</h3>
          {/* Outcome used to be a tint and nothing else, with the words parked
              in a `title` you had to find with a mouse. The W/L/D letter puts
              it back in the open, and the full sentence is there to be read
              aloud. */}
          <ol className="flex flex-wrap gap-1.5">
            {history.slice(-14).map((round) => (
              <li
                key={round.round}
                className="flex h-9 w-9 flex-col items-center justify-center gap-0.5 rounded-md border"
                style={{
                  borderColor: `${OUTCOME_HEX[round.outcome]}88`,
                  background: `${OUTCOME_HEX[round.outcome]}12`,
                  color: MOVE_HEX[round.humanMove],
                }}
              >
                <MoveGlyph move={round.humanMove} size={16} />
                <span
                  aria-hidden
                  className="readout text-[0.625rem] leading-none font-bold"
                  style={{ color: OUTCOME_HEX[round.outcome] }}
                >
                  {OUTCOME_MARK[round.outcome]}
                </span>
                <span className="sr-only">
                  Round {round.round}: you played {round.humanMove}, AI played {round.aiMove} —{" "}
                  {round.outcome}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    // The hint lives inside the <dd>, not beside it: a <div> inside a <dl> may
    // only hold <dt>/<dd> pairs, and a stray <p> there breaks the mapping
    // between every term and its definition.
    <div className="rounded-lg border border-line bg-void/50 px-3 py-2.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1">
        <span className="readout block text-xl leading-none text-ink">{value}</span>
        {hint && <span className="readout mt-1 block text-[0.6875rem] text-faint">{hint}</span>}
      </dd>
    </div>
  );
}

/** Running read rate, so you can watch the AI get better (or fail to). */
function AccuracySparkline({ history }: { history: RoundRecord[] }) {
  const width = 240;
  const height = 44;

  // Inset the plot so a 100% line sits just below the top edge instead of
  // flush against it, where the area fill reads as a solid block.
  const pad = 4;
  const plot = (rate: number) => pad + (1 - rate) * (height - pad * 2);

  let hits = 0;
  const points = history.map((round, index) => {
    if (round.predictionCorrect) hits++;
    const x = history.length > 1 ? (index / (history.length - 1)) * width : 0;
    return `${x.toFixed(1)},${plot(hits / (index + 1)).toFixed(1)}`;
  });

  const chanceY = plot(1 / 3);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      preserveAspectRatio="none"
      role="img"
      // A shape called "read rate over time" tells you nothing without the
      // numbers. Chance is the line that makes the figure mean something, so
      // it goes in the label too.
      aria-label={`AI read rate across ${history.length} scored rounds, now ${Math.round(
        (hits / history.length) * 100,
      )} percent against 33 percent for chance.`}
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2fe0cf" stopOpacity={0.16} />
          <stop offset="100%" stopColor="#2fe0cf" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Chance baseline — anything above this line is a real read. */}
      <line
        x1={0}
        y1={chanceY}
        x2={width}
        y2={chanceY}
        stroke="#24354a"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} fill="url(#spark-fill)" />
      <polyline points={points.join(" ")} fill="none" stroke="#2fe0cf" strokeWidth={1.75} />
    </svg>
  );
}

function trailingWinStreak(history: RoundRecord[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].outcome === "win"; i--) streak++;
  return streak;
}

function bestWinStreak(history: RoundRecord[]): number {
  let best = 0;
  let run = 0;
  for (const round of history) {
    run = round.outcome === "win" ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
