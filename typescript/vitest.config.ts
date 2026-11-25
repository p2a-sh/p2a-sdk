import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "p2a-sdk": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
});
