import { NextResponse } from "next/server";

import { CommitmentError, peekRound, warmup } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

warmup();

/**
 * Disclose the move the AI has already sealed for this round.
 *
 * Read-only by design. It does not consume the commitment and does not mint a
 * new one, so looking at the answer cannot change the answer — the hash already
 * on screen is still the one that gets verified after the throw.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const commitId = typeof payload.commitId === "string" ? payload.commitId : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";

  if (!commitId || !sessionId) {
    return NextResponse.json(
      { error: "commitId and sessionId are required" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await peekRound({ sessionId, commitId }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof CommitmentError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
