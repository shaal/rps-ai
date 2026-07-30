"use client";

import { MOVE_HEX, MOVE_LABEL } from "./move-glyph";
import { ProximityScope } from "./proximity-scope";
import { MOVES } from "@/lib/rps";
import type { Move, Reasoning } from "@/lib/types";

export function MemoryPanel({
  reasoning,
  scanning,
}: {
  reasoning: Reasoning | null;
  scanning: boolean;
}) {
  const neighbors = reasoning?.topNeighbors ?? [];
  const bootstrapping = !reasoning || reasoning.mode === "bootstrap";

  return (
    <section className="panel flex flex-col gap-5 p-5" aria-label="AI memory">
      <header className="flex items-baseline justify-between">
        <h2 className="eyebrow">Memory recall</h2>
        <span className="readout text-[10px] text-faint">
          {scanning ? "searching…" : `${neighbors.length} retrieved`}
        </span>
      </header>

      <ProximityScope neighbors={neighbors} scanning={scanning} />

      <div className="hairline" />

      <div>
        <h3 className="eyebrow mb-2">Query context</h3>
        <p className="readout rounded-lg border border-line bg-void/60 p-3 text-[11px] leading-relaxed break-words text-dim">
          {reasoning?.context ?? "—"}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          This exact string is embedded and matched against every past situation.
        </p>
      </div>

      <div className="hairline" />

      <Prediction reasoning={reasoning} bootstrapping={bootstrapping} />

      {neighbors.length > 0 && !scanning && (
        <>
          <div className="hairline" />
          <NeighborList neighbors={neighbors.slice(0, 3)} />
        </>
      )}
    </section>
  );
}

function Prediction({
  reasoning,
  bootstrapping,
}: {
  reasoning: Reasoning | null;
  bootstrapping: boolean;
}) {
  if (bootstrapping || !reasoning) {
    return (
      <div>
        <h3 className="eyebrow mb-2">Prediction</h3>
        <p className="text-[11px] leading-relaxed text-faint">
          The AI is still bootstrapping — it throws blind until it has enough
          episodes to search.
        </p>
      </div>
    );
  }

  const confidence = Math.round(reasoning.confidence * 100);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="eyebrow">Predicted next throw</h3>
        <span className="readout text-[10px] text-faint">confidence {confidence}%</span>
      </div>

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
        <p className="mt-3 text-[11px] leading-relaxed text-warn">
          Ignored its read this round and threw at random.
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
        className="readout w-16 shrink-0 text-[11px]"
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
      <span className="readout w-9 shrink-0 text-right text-[11px] text-dim">{percent}%</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-void/50 py-2">
      <dt className="eyebrow text-[9px]">{label}</dt>
      <dd className="readout mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

function NeighborList({ neighbors }: { neighbors: Reasoning["topNeighbors"] }) {
  return (
    <div>
      <h3 className="eyebrow mb-2">Strongest memories</h3>
      <ul className="flex flex-col gap-2">
        {neighbors.map((neighbor) => (
          <li
            key={neighbor.id}
            className="rounded-lg border border-line bg-void/40 p-2.5"
          >
            <div className="readout flex items-center justify-between text-[10px] text-faint">
              <span>episode {neighbor.meta.seq + 1}</span>
              <span>d {neighbor.distance.toFixed(3)}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span className="text-[11px] text-dim">
                you then played{" "}
                <span
                  className="font-semibold"
                  style={{ color: MOVE_HEX[neighbor.meta.nextHumanMove] }}
                >
                  {MOVE_LABEL[neighbor.meta.nextHumanMove]}
                </span>
              </span>
              <span className="readout text-[10px] text-faint">
                {Math.round(neighbor.influence * 100)}% weight
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
