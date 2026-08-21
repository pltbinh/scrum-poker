import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      environment: "node",
      include: ["test/**/*.test.ts"],
      pool: "threads",
      poolOptions: {
        threads: {
          singleThread: true,
        },
      },
    },
  },
  "apps/web/vite.config.ts",
  "packages/protocol/vitest.config.mjs",
]);
