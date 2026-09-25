/* v5.79 Push A: the ELJ Drafting Style Guide module. */
import { describe, it, expect } from "vitest";
import { styleGuideFor, styleGuideEnabled, STYLE_GUIDE_FULL, STYLE_GUIDE_ANALYSIS, FULL_GUIDE_TOOLS } from "../lib/style_guide.js";

describe("styleGuideFor", () => {
  it("gives the full guide to the drafting tools", () => {
    for (const t of FULL_GUIDE_TOOLS) expect(styleGuideFor(t, {})).toBe("\n\n" + STYLE_GUIDE_FULL);
  });

  it("gives accuracy and restraint only to other tools", () => {
    for (const t of ["proposition", "chronology", "persons", "issues", "inconsistency", "citations"]) {
      const g = styleGuideFor(t, {});
      expect(g).toBe("\n\n" + STYLE_GUIDE_ANALYSIS);
      expect(g).toContain("## 4. Accuracy");
      expect(g).toContain("## 7. Focus and restraint");
      expect(g).not.toContain("## 1. Voice");
      expect(g).not.toContain("## 6. Flag list");
    }
  });

  it("returns nothing when the flag is off, whatever the spacing or case", () => {
    expect(styleGuideFor("draft", { ELJ_STYLE_GUIDE: "off" })).toBe("");
    expect(styleGuideFor("chronology", { ELJ_STYLE_GUIDE: " OFF " })).toBe("");
    expect(styleGuideEnabled({ ELJ_STYLE_GUIDE: "off" })).toBe(false);
    expect(styleGuideEnabled({})).toBe(true);
    expect(styleGuideEnabled(undefined)).toBe(true);
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
    expect(STYLE_GUIDE_FULL).toContain('Never use "leverage" as a verb.');
  });
});
