/* v5.75: ELJ Drafting Style Guide wiring. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { styleGuideFor, STYLE_GUIDE_FULL, STYLE_GUIDE_ANALYSIS, FULL_GUIDE_TOOLS } from "../lib/style_guide.js";

describe("styleGuideFor", () => {
  it("gives the full guide to the drafting tools", () => {
    for (const t of FULL_GUIDE_TOOLS) {
      expect(styleGuideFor(t, {})).toBe("\n\n" + STYLE_GUIDE_FULL);
    }
  });

  it("gives accuracy and restraint only to the analysis tools", () => {
    for (const t of ["chronology", "persons", "issues", "inconsistency", "proposition", "citations"]) {
      const g = styleGuideFor(t, {});
      expect(g).toBe("\n\n" + STYLE_GUIDE_ANALYSIS);
      expect(g).toContain("## 4. Accuracy");
      expect(g).toContain("## 7. Focus and restraint");
      expect(g).not.toContain("## 1. Voice");
      expect(g).not.toContain("## 6. Flag list");
    }
  });

  it("returns nothing when the flag is off", () => {
    expect(styleGuideFor("draft", { ELJ_STYLE_GUIDE: "off" })).toBe("");
    expect(styleGuideFor("chronology", { ELJ_STYLE_GUIDE: " OFF " })).toBe("");
  });

  it("stays on for any other flag value", () => {
    expect(styleGuideFor("draft", { ELJ_STYLE_GUIDE: "on" })).toBe("\n\n" + STYLE_GUIDE_FULL);
  });

  it("is identical between calls, so the prompt cache holds", () => {
    expect(styleGuideFor("draft", {})).toBe(styleGuideFor("draft", {}));
  });

  it("keeps the agreed amendments", () => {
    expect(STYLE_GUIDE_FULL).toContain("Section 4 (Accuracy) always applies");
    expect(STYLE_GUIDE_FULL).toContain("follow its structure and language style");
    expect(STYLE_GUIDE_FULL).toContain("not in supplied material");
    expect(STYLE_GUIDE_FULL).toContain("A length given to you is a ceiling, not a target.");
    expect(STYLE_GUIDE_FULL).toContain("In a briefing note, an issue briefing");
  });
});

describe("worker.js wiring", () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");

  it("imports the guide and builds guideBlock once", () => {
    expect(src).toContain('import { styleGuideFor, styleGuideEnabled, FULL_GUIDE_TOOLS } from "./lib/style_guide.js";');
    expect(src.match(/var guideBlock = styleGuideFor\(tool, process\.env\);/g).length).toBe(1);
  });

  it("appends guideBlock to all nine tool system prompts", () => {
    expect(src.match(/\+ guideBlock/g).length).toBe(9);
  });

  it("no longer asks the briefing to fill every section", () => {
    expect(src).not.toContain("every section must have at least a short paragraph");
    expect(src).not.toContain("Aim for 2-4 paragraphs per section");
  });
});
