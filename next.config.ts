import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Pin the workspace root. A stray lockfile in a parent directory otherwise
   * makes Turbopack infer the wrong root, which changes how the native ruvector
   * packages resolve.
   */
  turbopack: { root: path.resolve(".") },

  /**
   * `ruvector` loads a platform-specific native `.node` addon and a WASM ONNX
   * runtime off disk at require time. Bundling either one breaks the load, so
   * they must stay external and resolved by Node at runtime.
   */
  serverExternalPackages: ["ruvector", "@ruvector/core"],
};

export default nextConfig;
