import { NextResponse } from "next/server";

import { commitRound, sanitizeHistory, warmup } from "@/lib/engine";
import type { Mode } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

warmup();

const MODES: Mode[] = ["dominate", "level", "yield"];

function parseMode(value: unknown): Mode {
  return MODES.includes(value as Mode) ? (value as Mode) : "dominate";
}

/**
 * Lock in the AI's next move and hand back only its hash.
 *
 * Called on load and after every round, so a commitment is always waiting
 * before the player throws.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const history = sanitizeHistory(payload.history);
  const round = Number.isFinite(Number(payload.round))
    ? Math.max(1, Math.floor(Number(payload.round)))
    : history.length + 1;

  try {
    const result = await commitRound({
      sessionId,
      mode: parseMode(payload.mode),
      revealed: payload.revealed === true,
      history,
      round,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
