import { NextResponse } from "next/server";

import { CommitmentError, resolveRound, warmup } from "@/lib/engine";
import { isMove } from "@/lib/rps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

warmup();

/**
 * Open the AI's commitment against the human's throw.
 *
 * No history and no move prediction happen here — the AI already decided. This
 * endpoint only resolves the outcome, records the episode, and reveals the
 * nonce so the client can verify the hash it was shown before it threw.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const humanMove = payload.humanMove;
  const commitId = typeof payload.commitId === "string" ? payload.commitId : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";

  if (!isMove(humanMove)) {
    return NextResponse.json(
      { error: "humanMove must be one of rock, paper, scissors" },
      { status: 400 },
    );
  }
  if (!commitId || !sessionId) {
    return NextResponse.json(
      { error: "commitId and sessionId are required" },
      { status: 400 },
    );
  }

  try {
    const result = await resolveRound({ sessionId, commitId, humanMove });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CommitmentError) {
      // Recoverable: the client just asks for a fresh commitment and retries.
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
