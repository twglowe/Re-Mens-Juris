/* v5.77: tighten pass. */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import {
  splitBlocks, parseTightenReply, authorityFound, normalise, rewriteXrefs,
  tightenDraft, appendPoint, tightenEnabled, MAX_CUT_SHARE,
} from "../lib/tighten.js";

const HEADING = "IN THE GRAND COURT\nFSD 1 of 2026\n\nBETWEEN:\n\nA          Plaintiff\n\u2014 and \u2014\nB          Defendant";
const DOC = [
  HEADING,
  "## Introduction",
  "1. The Plaintiff applies to strike out.",
  "2. The claim is time-barred: see *Smith v Jones* [2009] UKPC 34.",
  "## Limitation",
  "3. Time ran from 1 May 2015 [B/1].",
  "4. As paragraph 2 says, the claim is time-barred.",
  "5. The court should strike out; see paragraphs 3 and 4.",
  "6. Alternatively it may be that the court has some wider discretion.",
  "7. Order sought.",
  "## Points to check",
  "*Not for filing.*",
  "- para 3: [REF NEEDED] for the date",
].join("\n\n");

const ok = (obj) => ({ text: JSON.stringify(obj), inputTokens: 10, outputTokens: 5, cost: 0.01 });

describe("splitBlocks", () => {
  it("labels only body paragraphs after the first heading", () => {
    const b = splitBlocks(DOC);
    const labelled = b.filter((x) => x.label).map((x) => x.text.slice(0, 2));
    expect(labelled).toEqual(["1.", "2.", "3.", "4.", "5.", "6.", "7."]);
    expect(b.find((x) => x.text.startsWith("IN THE GRAND")).eligible).toBe(false);
    expect(b.find((x) => x.text.startsWith("- para 3")).eligible).toBe(false);
  });
  it("never labels label lines or tables", () => {
    const b = splitBlocks("## Briefing Note\n\n**Date:** 1 May\n\n| a | b |\n\nBody.");
    expect(b.filter((x) => x.label).map((x) => x.text)).toEqual(["Body."]);
  });
});

describe("parseTightenReply", () => {
  it("accepts fenced JSON and drops bad labels", () => {
    const r = parseTightenReply("```json\n{\"cuts\":[{\"block\":\"b4\",\"reason\":\"x\"},{\"block\":\"para 2\"}],\"authorities\":[{\"name\":\"A v B\"}]}\n```");
    expect(r.cuts).toEqual([{ block: "B4", reason: "x" }]);
    expect(r.authorities.length).toBe(1);
  });
  it("reads JSON wrapped in a sentence", () => {
    const r = parseTightenReply("Here is the result: {\"cuts\":[],\"authorities\":[]} Done.");
    expect(r).toEqual({ cuts: [], authorities: [] });
  });
  it("returns null on prose", () => {
    expect(parseTightenReply("I would cut paragraph 4")).toBeNull();
  });
});

describe("authorityFound", () => {
  const hay = normalise("See Smith v Jones [2009] UKPC 34 at [12]. Also Re Thalassa Holdings Ltd.");
  it("matches by citation, name, or both parties", () => {
    expect(authorityFound({ name: "", citation: "[2009] UKPC 34" }, hay)).toBe(true);
    expect(authorityFound({ name: "Smith v Jones", citation: "" }, hay)).toBe(true);
    expect(authorityFound({ name: "Re Thalassa Holdings Ltd", citation: "" }, hay)).toBe(true);
  });
  it("does not match an invented authority", () => {
    expect(authorityFound({ name: "Brown v Green", citation: "[2011] UKSC 9" }, hay)).toBe(false);
  });
});

describe("rewriteXrefs", () => {
  it("rewrites paragraph references and reports cut ones", () => {
    const map = new Map([[3, 3], [5, 4], [6, 5]]);
    const broken = [];
    const out = rewriteXrefs("see paragraphs 3 and 5; para 6.1; paragraph 4; at [5]", map, new Set([4]), broken);
    expect(out).toBe("see paragraphs 3 and 4; para 5.1; paragraph 4; at [5]");
    expect(broken).toEqual([4]);
  });
});

describe("tightenDraft", () => {
  it("cuts only named blocks, renumbers, fixes cross-references and rebuilds Points to check", async () => {
    const runTool = vi.fn().mockResolvedValue(ok({
      cuts: [{ block: "B4", reason: "repeats B2" }],
      authorities: [{ name: "Smith v Jones", citation: "[2009] UKPC 34", block: "B2" }],
    }));
    const out = await tightenDraft(runTool, "sys", "draft", DOC, "nothing relevant", {});
    expect(out.text.startsWith(HEADING)).toBe(true);
    const body = out.text.split("## Points to check")[0];
    expect(body).not.toContain("As paragraph 2 says");
    expect(out.text).toContain("4. The court should strike out; see paragraphs 3 and 4.");
    expect(out.text).toContain("5. Alternatively");
    expect(out.text).toContain("6. Order sought.");
    expect(out.text.match(/## Points to check/g).length).toBe(1);
    expect(out.text).toContain("- para 3: [REF NEEDED] for the date");
    expect(out.text).toContain("para 2: Smith v Jones [2009] UKPC 34 (not in supplied material)");
    expect(out.text).toContain("### Cut by the tighten pass");
    expect(out.text).toContain("was para 4 (repeats B2)");
    expect(out.text).toContain("> 4. As paragraph 2 says, the claim is time-barred.");
    expect(out.cut).toBe(1);
  });

  it("takes a cut paragraph's sub-paragraphs with it", async () => {
    const doc = "## A\n\n1. One.\n\n2. Two:\n\n2.1 first;\n\n2.2 second.\n\n3. Three, see paragraph 3.";
    const runTool = vi.fn().mockResolvedValue(ok({ cuts: [{ block: "B2", reason: "r" }], authorities: [] }));
    const out = await tightenDraft(runTool, "sys", "draft", doc, "", {});
    const body = out.text.split("## Points to check")[0];
    expect(body).not.toContain("2.1 first");
    expect(body).not.toContain("2.2 second");
    expect(body).toContain("2. Three, see paragraph 2.");
    expect(out.cut).toBe(3);
  });

  it("flags a cross-reference to a cut paragraph", async () => {
    const runTool = vi.fn().mockResolvedValue(ok({ cuts: [{ block: "B3", reason: "r" }], authorities: [] }));
    const out = await tightenDraft(runTool, "sys", "draft", DOC, "", {});
    expect(out.text).toContain("A cross-reference points to paragraph 3, which the tighten pass cut.");
  });

  it("does not flag an authority found in the supplied material", async () => {
    const runTool = vi.fn().mockResolvedValue(ok({ cuts: [], authorities: [{ name: "Smith v Jones", citation: "[2009] UKPC 34", block: "B2" }] }));
    const out = await tightenDraft(runTool, "sys", "draft", DOC, "Smith v Jones [2009] UKPC 34", {});
    expect(out.text).not.toContain("not in supplied material");
    expect(out.text).toContain("1. The Plaintiff applies");
  });

  it("refuses to cut more than the allowed share", async () => {
    const cuts = ["B1", "B2", "B3", "B4"].map((b) => ({ block: b, reason: "r" }));
    expect(cuts.length).toBeGreaterThan(Math.floor(7 * MAX_CUT_SHARE));
    const runTool = vi.fn().mockResolvedValue(ok({ cuts, authorities: [] }));
    const out = await tightenDraft(runTool, "sys", "draft", DOC, "", {});
    expect(out.cut).toBe(0);
    expect(out.text).toContain("1. The Plaintiff applies");
    expect(out.text).toContain("none were cut");
  });

  it("leaves numbering alone when it was not continuous", async () => {
    const doc = "## A\n\n1. One.\n\n2. Two.\n\n## B\n\n1. Again.\n\n2. More.\n\n3. Last.";
    const runTool = vi.fn().mockResolvedValue(ok({ cuts: [{ block: "B2", reason: "r" }], authorities: [] }));
    const out = await tightenDraft(runTool, "sys", "briefing", doc, "", {});
    expect(out.text).toContain("## B\n\n1. Again.");
    expect(out.text).toContain("numbering was not adjusted");
  });

  it("throws on a reply that is not JSON, so the caller keeps the draft", async () => {
    const runTool = vi.fn().mockResolvedValue({ text: "no", inputTokens: 1, outputTokens: 1, cost: 0 });
    await expect(tightenDraft(runTool, "sys", "draft", DOC, "", {})).rejects.toThrow(/not valid JSON/);
  });

  it("sends the cached system prompt and a prompt that forbids rewriting", async () => {
    const runTool = vi.fn().mockResolvedValue(ok({ cuts: [], authorities: [] }));
    await tightenDraft(runTool, "SYSTEM BASE", "draft", DOC, "", { instructions: "Skeleton for strike out" });
    const [sys, prompt] = runTool.mock.calls[0];
    expect(sys).toBe("SYSTEM BASE");
    expect(prompt).toContain("You cannot edit wording, only cut whole blocks.");
    expect(prompt).toContain("you have not seen the source documents");
    expect(prompt).toContain("[B1] 1. The Plaintiff applies");
    expect(prompt).toContain("Skeleton for strike out");
  });
});

describe("appendPoint and flags", () => {
  it("adds one line to an existing list", () => {
    const out = appendPoint(DOC, "The tighten pass did not run.");
    expect(out.match(/## Points to check/g).length).toBe(1);
    expect(out).toContain("- para 3: [REF NEEDED] for the date\n- The tighten pass did not run.");
  });
  it("is off with either flag", () => {
    expect(tightenEnabled({})).toBe(true);
    expect(tightenEnabled({ ELJ_TIGHTEN: "off" })).toBe(false);
    expect(tightenEnabled({ ELJ_STYLE_GUIDE: "off" })).toBe(false);
  });
});

describe("worker.js wiring", () => {
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  it("runs the pass before the heading is prepended, and never fatally", () => {
    const at = src.indexOf("tightenDraft(runTool, systemBase, tool, result");
    const heading = src.indexOf("result = headingText + \"\\n\" + result;");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(heading);
    expect(src).toContain("catch (tErr)");
    expect(src).toContain("var handlerStart = Date.now();");
  });
});
