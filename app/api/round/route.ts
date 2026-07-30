import { NextResponse } from "next/server";

import { playRound, sanitizeHistory, warmup } from "@/lib/engine";
import { isMove } from "@/lib/rps";
import type { Difficulty } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

warmup();

const DIFFICULTIES: Difficulty[] = ["casual", "rival", "ruthless"];

function parseDifficulty(value: unknown): Difficulty {
  return DIFFICULTIES.includes(value as Difficulty) ? (value as Difficulty) : "rival";
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const humanMove = payload.humanMove;

  if (!isMove(humanMove)) {
    return NextResponse.json(
      { error: "humanMove must be one of rock, paper, scissors" },
      { status: 400 },
    );
  }

  const history = sanitizeHistory(payload.history);
  const round = Number.isFinite(Number(payload.round))
    ? Math.max(1, Math.floor(Number(payload.round)))
    : history.length + 1;

  try {
    const result = await playRound({
      humanMove,
      difficulty: parseDifficulty(payload.difficulty),
      history,
      round,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
