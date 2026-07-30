import { NextResponse } from "next/server";

import { getStatus, resetMemory } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wipe every learned episode. Destructive and deliberately not a GET. */
export async function POST() {
  try {
    await resetMemory();
    const status = await getStatus();
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
