import { MOVE_HEX } from "./move-glyph";
import type { Recalled } from "@/lib/types";

const CENTER = 100;
const INNER_RADIUS = 20;
const OUTER_RADIUS = 86;

/**
 * The signature readout: a radial plot of the embedding neighbourhood the AI
 * just queried.
 *
 * Centre is the current situation. Every node is one recalled episode, placed
 * at a radius proportional to its real cosine distance, coloured by what the
 * human went on to play, and sized by the share of the vote it carried. The
 * three most influential memories are wired back to the centre.
 *
 * The ring labels carry the actual distance values, because the radial scale is
 * normalised to the retrieved set — without the numbers a tight cluster and a
 * wide spread would look identical.
 */
export function ProximityScope({
  neighbors,
  scanning,
}: {
  neighbors: Recalled[];
  scanning: boolean;
}) {
  const distances = neighbors.map((n) => n.distance);
  const dMin = distances.length ? Math.min(...distances) : 0;
  const dMax = distances.length ? Math.max(...distances) : 1;
  const spread = dMax - dMin;

  const placed = neighbors.map((neighbor, index) => {
    // Even angular distribution keeps nodes legible, with a stable per-episode
    // jitter so the same memory doesn't jump around between rounds.
    const step = 360 / Math.max(neighbors.length, 1);
    const jitter = (hash(neighbor.id) % 24) - 12;
    const angle = index * step + jitter;
    const t = spread > 1e-9 ? (neighbor.distance - dMin) / spread : 0.5;
    const radius = INNER_RADIUS + t * (OUTER_RADIUS - INNER_RADIUS);
    const radians = (angle * Math.PI) / 180;
    return {
      ...neighbor,
      x: CENTER + Math.cos(radians) * radius,
      y: CENTER + Math.sin(radians) * radius,
      size: 2.4 + Math.min(neighbor.influence, 0.5) * 12,
      index,
    };
  });

  const leaders = [...placed].sort((a, b) => b.influence - a.influence).slice(0, 3);

  return (
    <div className="relative">
      <svg
        viewBox="0 0 200 200"
        className="w-full"
        role="img"
        // The plot is the only place the size and tightness of the recalled
        // cluster appears; the label has to carry both or it carries nothing.
        aria-label={
          neighbors.length === 0
            ? "Memory neighbourhood: nothing recalled yet."
            : `Memory neighbourhood: ${neighbors.length} episode${
                neighbors.length === 1 ? "" : "s"
              } recalled, at cosine distances from ${dMin.toFixed(3)} to ${dMax.toFixed(3)}.`
        }
      >
        <defs>
          <radialGradient id="scope-core">
            <stop offset="0%" stopColor="#2fe0cf" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#2fe0cf" stopOpacity={0} />
          </radialGradient>
          <linearGradient id="sweep-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2fe0cf" stopOpacity={0} />
            <stop offset="100%" stopColor="#2fe0cf" stopOpacity={0.7} />
          </linearGradient>
        </defs>

        {/* Measurement rings */}
        {[INNER_RADIUS, (INNER_RADIUS + OUTER_RADIUS) / 2, OUTER_RADIUS].map((r) => (
          <circle key={r} cx={CENTER} cy={CENTER} r={r} fill="none" stroke="#1a2534" strokeWidth={1} />
        ))}

        {/* Crosshair ticks */}
        {[0, 90, 180, 270].map((angle) => {
          const rad = (angle * Math.PI) / 180;
          return (
            <line
              key={angle}
              x1={CENTER + Math.cos(rad) * (OUTER_RADIUS - 6)}
              y1={CENTER + Math.sin(rad) * (OUTER_RADIUS - 6)}
              x2={CENTER + Math.cos(rad) * (OUTER_RADIUS + 6)}
              y2={CENTER + Math.sin(rad) * (OUTER_RADIUS + 6)}
              stroke="#24354a"
              strokeWidth={1}
            />
          );
        })}

        <circle cx={CENTER} cy={CENTER} r={26} fill="url(#scope-core)" />

        {scanning && (
          <g className="scope-sweep">
            <line
              x1={CENTER}
              y1={CENTER}
              x2={CENTER + OUTER_RADIUS}
              y2={CENTER}
              stroke="url(#sweep-fade)"
              strokeWidth={2}
            />
          </g>
        )}

        {/* Influence wires from the strongest memories back to the present. */}
        {!scanning &&
          leaders.map((node) => (
            <line
              key={`wire-${node.id}`}
              x1={CENTER}
              y1={CENTER}
              x2={node.x}
              y2={node.y}
              stroke={MOVE_HEX[node.meta.nextHumanMove]}
              strokeOpacity={0.28}
              strokeWidth={1}
            />
          ))}

        {!scanning &&
          placed.map((node) => (
            <g
              key={node.id}
              className="animate-pop"
              style={{ animationDelay: `${node.index * 34}ms` }}
            >
              <circle
                cx={node.x}
                cy={node.y}
                r={node.size + 3}
                fill={MOVE_HEX[node.meta.nextHumanMove]}
                fillOpacity={0.14}
              />
              <circle cx={node.x} cy={node.y} r={node.size} fill={MOVE_HEX[node.meta.nextHumanMove]} />
            </g>
          ))}

        {/* The present moment. */}
        <circle cx={CENTER} cy={CENTER} r={4} fill="#e6f0f7" />
        <circle cx={CENTER} cy={CENTER} r={8} fill="none" stroke="#e6f0f7" strokeOpacity={0.3} strokeWidth={1} />
      </svg>

      {neighbors.length > 0 && !scanning && (
        <div className="readout mt-1 flex justify-between text-[0.6875rem] text-faint">
          <span>nearest {dMin.toFixed(3)}</span>
          <span>furthest {dMax.toFixed(3)}</span>
        </div>
      )}

      {neighbors.length === 0 && !scanning && (
        <p className="mt-2 text-center text-xs leading-relaxed text-faint">
          Nothing recalled yet. The scope fills in once the AI has memories to search.
        </p>
      )}
    </div>
  );
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}
