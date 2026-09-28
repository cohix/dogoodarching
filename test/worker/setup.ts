// Per-file setup for the `worker` project.
//
// - `beforeAll`: apply every migration in `migrations/*.sql` to this file's
//   isolated D1 database (later `0002_*.sql` etc. are picked up automatically).
// - `beforeEach`: wipe every table and every R2 object, so each test starts
//   from an empty, migrated database. vitest-pool-workers isolates storage per
//   test *file*, not per test, so without this a user bootstrapped in one test
//   would still exist in the next.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import { resetStorage } from "./helpers";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetStorage();
});
