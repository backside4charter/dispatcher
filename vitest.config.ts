import { defineConfig } from "vitest/config"

/**
 * Vitest config for the `dispatcher` package.
 *
 * The listener is exercised as an integration test: a real HTTP server on an
 * ephemeral loopback port receiving GitHub-shaped webhook deliveries via
 * fetch - the exact surface `gh webhook forward` posts to at runtime. Only
 * the forward child process itself is substituted (tests inject a fake
 * command), because spawning the real `gh` extension needs GitHub auth.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      include: ["src/**/*.ts"],
    },
  },
})
