import { Game } from "@/components/game";
import { warmup } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default function Home() {
  // Kick the embedder off while the page is still streaming, so the model is
  // usually loaded by the time the first throw lands.
  warmup();
  return <Game />;
}
