import { Game } from "@/components/game";

/**
 * A shell, and nothing else.
 *
 * This was `force-dynamic` and called `warmup()` during render, both because
 * the opponent lived on the server and wanted its model loading before the
 * first throw arrived. Neither applies now: the page prerenders to static HTML,
 * and the store it needs is IndexedDB, which does not exist until the browser
 * has the page. The game warms itself on mount instead.
 */
export default function Home() {
  return <Game />;
}
