/* v5.83 — Word exports are US Letter, the one page size Tom's courts use. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("api/export.js page size", () => {
  const src = fs.readFileSync(new URL("../export.js", import.meta.url), "utf8");
  it("sets US Letter (12240 x 15840 twips) with 1in margins", () => {
    expect(src).toMatch(/<w:pgSz w:w="12240" w:h="15840"\/>/);
    expect(src).not.toMatch(/w:w="11906" w:h="16838"/);
    expect(src).toMatch(/<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  });
  it("places the front-sheet title for the shorter page", () => {
    expect(src).toMatch(/Math\.max\(240, 8640 - used\)/);
  });
});
