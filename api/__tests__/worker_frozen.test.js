/* v5.79: api/worker.js is frozen at its 19 Sep 2026 version (commit 8b75b52)
   by Tom's instruction of 25 Sep 2026: it has a history of regressions, and
   must not change without a written risk assessment he has approved. This
   test fails if the file differs by a single byte. Changing the expected
   hash below is itself a change to worker.js and needs that approval. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const FROZEN_GIT_BLOB = "4e6628fac92d177e65b35a20e9a6c58eec50ae8c";

describe("api/worker.js", () => {
  it("is unchanged from the frozen version", () => {
    const data = readFileSync(new URL("../worker.js", import.meta.url));
    const sha = createHash("sha1").update("blob " + data.length + "\0").update(data).digest("hex");
    expect(sha).toBe(FROZEN_GIT_BLOB);
  });

  it("does not import the style guide or the tighten pass", () => {
    const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
    expect(src).not.toContain("style_guide.js");
    expect(src).not.toContain("tighten.js");
  });
});
