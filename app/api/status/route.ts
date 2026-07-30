import { NextResponse } from "next/server";

import { getStatus, warmup } from "@/lib/engine";

// The native vector engine and ONNX runtime need a real Node process.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start loading the model as soon as this route module is first evaluated, so
// the embedder is usually warm by the time the player throws their first move.
warmup();

export async function GET() {
  const status = await getStatus();
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
