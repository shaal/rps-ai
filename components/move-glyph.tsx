import type { Move } from "@/lib/types";

/**
 * Geometric move marks drawn to match the instrument aesthetic.
 *
 * Deliberately not emoji: emoji render differently on every platform and read
 * as clip art next to the rest of the console.
 */
export function MoveGlyph({
  move,
  size = 32,
  className = "",
}: {
  move: Move;
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 32 32",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };

  if (move === "rock") {
    return (
      <svg {...common}>
        {/* A faceted mineral chunk — mass and weight. */}
        <path d="M16 3.5 L26.5 9.5 L28 21 L19.5 28.5 L8.5 27 L3.5 16.5 Z" fill="currentColor" fillOpacity={0.12} />
        <path d="M16 3.5 L12.5 14.5 L3.5 16.5" />
        <path d="M12.5 14.5 L19.5 28.5" />
        <path d="M12.5 14.5 L28 21" />
      </svg>
    );
  }

  if (move === "paper") {
    return (
      <svg {...common}>
        {/* A sheet with a turned corner. */}
        <path d="M7.5 3.5 H19 L25 9.5 V28.5 H7.5 Z" fill="currentColor" fillOpacity={0.1} />
        <path d="M19 3.5 V9.5 H25" />
        <path d="M12 17.5 H20.5" />
        <path d="M12 22 H18" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      {/* Open shears: two blades crossing above two handles. */}
      <path d="M10 4 L21 20.5" />
      <path d="M22 4 L11 20.5" />
      <circle cx={9.6} cy={24.4} r={3.1} fill="currentColor" fillOpacity={0.1} />
      <circle cx={22.4} cy={24.4} r={3.1} fill="currentColor" fillOpacity={0.1} />
    </svg>
  );
}

/** Tailwind text-colour class for a move. One hue per move, used everywhere. */
export const MOVE_TEXT: Record<Move, string> = {
  rock: "text-rock",
  paper: "text-paper",
  scissors: "text-scissors",
};

/** Raw hex for a move, for SVG fills and inline custom properties. */
export const MOVE_HEX: Record<Move, string> = {
  rock: "#ff9f45",
  paper: "#9d8cff",
  scissors: "#2fe0cf",
};

export const MOVE_LABEL: Record<Move, string> = {
  rock: "Rock",
  paper: "Paper",
  scissors: "Scissors",
};
