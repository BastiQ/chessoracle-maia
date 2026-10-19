import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The first test to touch the model pays the ~5 s wasm + session load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
