import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { DB_FILENAME, memoryFilePath, warmup } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download the raw vector database file. */
export async function GET() {
  // Make sure the store has been opened at least once, otherwise the file may
  // not exist yet on a completely fresh checkout.
  await warmup();

  const source = memoryFilePath();
  if (!source) {
    return NextResponse.json({ error: "This memory store is not file-backed." }, { status: 404 });
  }

  try {
    const data = await fs.readFile(source);
    const body = new Uint8Array(data);
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
        // Always download under the canonical name, even when the live file is
        // a post-reset generation.
        "Content-Disposition": `attachment; filename="${DB_FILENAME}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "No memory database on disk yet — play a round first." },
      { status: 404 },
    );
  }
}
