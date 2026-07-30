"use client";

import { MOVE_HEX, MoveGlyph } from "./move-glyph";
import type { Outcome, RoundRecord } from "@/lib/types";

const OUTCOME_HEX: Record<Outcome, string> = {
  win: "#3ddc97",
  loss: "#ff4f6d",
  draw: "#7b8ea3",
};

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
      <header className="mb-4 flex items-baseline justify-between">
        <h2 className="eyebrow">Telemetry</h2>
        <span className="readout text-[10px] text-faint">
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
            <span className="readout text-[10px] text-faint">33% = chance</span>
          </div>
          <AccuracySparkline history={scored} />
        </div>
      )}

      {rounds > 0 && (
        <div className="mt-5">
          <h3 className="eyebrow mb-2">Recent rounds</h3>
          <ol className="flex flex-wrap gap-1.5">
            {history.slice(-14).map((round) => (
              <li
                key={round.round}
                title={`Round ${round.round}: you played ${round.humanMove}, AI played ${round.aiMove} — ${round.outcome}`}
                className="flex h-9 w-9 items-center justify-center rounded-md border"
                style={{
                  borderColor: `${OUTCOME_HEX[round.outcome]}55`,
                  background: `${OUTCOME_HEX[round.outcome]}12`,
                  color: MOVE_HEX[round.humanMove],
                }}
              >
                <MoveGlyph move={round.humanMove} size={18} />
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
    <div className="rounded-lg border border-line bg-void/50 px-3 py-2.5">
      <dt className="eyebrow text-[9px]">{label}</dt>
      <dd className="readout mt-1 text-xl leading-none text-ink">{value}</dd>
      {hint && <p className="readout mt-1 text-[10px] text-faint">{hint}</p>}
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
      aria-label="AI read rate over the session"
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
