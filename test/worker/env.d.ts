/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as WorkerEnv } from "../../src/db";
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    // `env` from "cloudflare:test" carries the real Worker bindings
    // (DB, ATTACHMENTS) plus the migrations injected by vitest.config.ts.
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
