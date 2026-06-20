import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Explicit imports from "vitest" (no globals) keep tsconfig `types` empty.
    globals: false,
    include: ["tests/**/*.test.ts"],
  },
});
