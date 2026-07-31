import { NextResponse } from "next/server";

import { exportEpisodes, warmup } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download the AI's memory as newline-delimited JSON.
 *
 * Not the raw database file. That file is a redb arena which pre-allocates
 * 1.6MB before a single episode is stored and stays exactly that size until
 * roughly 200 episodes — so it says nothing about how much you have played.
 * The episodes themselves are about 194 bytes each.
 *
 * Vectors are omitted deliberately: they are deterministic re-embeddings of
 * `context`, so this file is enough to rebuild the memory on any backend.
 */
export async function GET() {
  await warmup();

  try {
    const { jsonl, count, storeSize, partial } = await exportEpisodes();

    return new Response(jsonl, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="rps-memory.jsonl"',
        "Cache-Control": "no-store",
        "X-Episode-Count": String(count),
        "X-Store-Size": String(storeSize),
        // Episodes recorded before the log existed cannot be recovered, since
        // this index cannot be reliably enumerated. Say so rather than quietly
        // handing over a short file.
        "X-Export-Partial": String(partial),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
