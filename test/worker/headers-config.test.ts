import { expect, it } from "vitest";
import config from "../../wrangler.toml?raw";
import sourcePolicy from "../../frontend/public/_headers?raw";

it("the static security policy covers SPA paths and approved embed hosts", () => {
  // The existing build-project test in scripts/service-worker-cache.test.mjs
  // builds into a fresh temp directory and verifies the emitted _headers.
  // Worker tests must not depend on an earlier build or stale dist artifacts.
  expect(sourcePolicy).toMatch(/^\/\*\n/);
  for (const header of ["Content-Security-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "Permissions-Policy"]) expect(sourcePolicy).toContain(`${header}:`);
  expect(sourcePolicy).toContain("frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com");
  expect(sourcePolicy).not.toContain("unsafe-eval");
});

it("production and preview configure separate namespaces with 5/min and 10/min bindings", () => {
  const sections = [...config.matchAll(/^\[\[(ratelimits|previews\.ratelimits)\]\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm)];
  expect(sections).toHaveLength(4);
  const namespaces: string[] = [];
  for (const scope of ["ratelimits", "previews.ratelimits"]) {
    const entries = sections.filter(match => match[1] === scope);
    expect(entries).toHaveLength(2);
    for (const allowance of [5,10]) {
      const entry = entries.find(match => match[2]!.includes(`name = "RATE_LIMIT_${allowance}_PER_MIN"`))?.[2];
      expect(entry).toBeDefined();
      expect(entry).toMatch(new RegExp(`simple\\s*=\\s*\\{\\s*limit\\s*=\\s*${allowance},\\s*period\\s*=\\s*60\\s*\\}`));
      const namespace = /namespace_id\s*=\s*"(\d+)"/.exec(entry!)?.[1];
      expect(namespace).toBeDefined();
      namespaces.push(namespace!);
    }
  }
  expect(new Set(namespaces).size).toBe(4);
  expect(config).not.toMatch(/^\s*RATE_LIMIT_MODE\s*=/m);
});
