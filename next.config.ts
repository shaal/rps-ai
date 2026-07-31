import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Static export. There is no server left to run: the opponent, its memory
   * and its maths all execute in the browser, so the whole game ships as
   * files and can be hosted anywhere — including Cloudflare's free tier.
   */
  output: "export",

  /** Pin the workspace root, so a stray lockfile in a parent directory cannot
   *  make the bundler infer the wrong one. */
  turbopack: { root: path.resolve(".") },

};

export default nextConfig;
