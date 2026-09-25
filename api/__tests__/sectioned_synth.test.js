/* Unit tests for api/lib/sectioned_synth.js
   Run with: npm test
   Mocks the Anthropic SDK entirely — no real API calls.

   Tests cover:
   1. parsePlan — valid JSON array
   2. parsePlan — JSON wrapped in ```json fence
   3. parsePlan — object with "sections" field
   4. parsePlan — empty / bad / null input
   5. parsePlan — enforces min/max section count and word bounds
   6. planSections — succeeds on first attempt with good JSON
   7. planSections — retries once on bad JSON, then succeeds
   8. planSections — fails after 2 bad JSON attempts
   9. planSections — propagates runTool throws (not retryable by plan layer)
   10. synthesiseSections — happy path, all sections succeed
   11. synthesiseSections — one section fails, banner prepended
   12. synthesiseSections — all sections fail, returns empty-completed state
   13. synthesiseSections — persists via updateJob after every section
   14. synthesiseSections — resumes from prior section_results array
*/

import { describe, it, expect, vi } from "vitest";
import {
  parsePlan,
  planSections,
  synthesiseSections,
  MAX_SECTIONS,
  MIN_SECTION_WORDS,
  MAX_SECTION_WORDS,
} from "../lib/sectioned_synth.js";

/* ────────────────────────────────────────────────────────────────────
   parsePlan — pure parser
   ──────────────────────────────────────────────────────────────────── */

describe("parsePlan", () => {
  it("parses a bare JSON array", () => {
    const input = '[{"title":"Intro","description":"Overview","target_words":400}]';
    const out = parsePlan(input);
    expect(out).toEqual([
      { index: 1, title: "Intro", description: "Overview", target_words: 400 },
    ]);
  });

  it("strips ```json fences", () => {
    const input = '```json\n[{"title":"A","target_words":300}]\n```';
    const out = parsePlan(input);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("A");
    expect(out[0].target_words).toBe(300);
  });

  it("accepts {sections: [...]} wrapper", () => {
    const input = '{"sections":[{"title":"B","target_words":500}]}';
    const out = parsePlan(input);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("B");
  });

  it("returns null on empty input", () => {
    expect(parsePlan("")).toBeNull();
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan(undefined)).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    expect(parsePlan("not json at all")).toBeNull();
    expect(parsePlan("[unclosed")).toBeNull();
  });

  it("returns null on empty array", () => {
    expect(parsePlan("[]")).toBeNull();
  });

  it("caps at MAX_SECTIONS", () => {
    const big = Array.from({ length: MAX_SECTIONS + 5 }, (_, i) => ({
      title: `S${i}`,
      target_words: 500,
    }));
    const out = parsePlan(JSON.stringify(big));
    expect(out).toHaveLength(MAX_SECTIONS);
  });

  it("clamps target_words to min/max", () => {
    const input = JSON.stringify([
      { title: "Too small", target_words: 10 },
      { title: "Too big", target_words: 9999 },
      { title: "Just right", target_words: 500 },
    ]);
    const out = parsePlan(input);
    expect(out[0].target_words).toBe(MIN_SECTION_WORDS);
    expect(out[1].target_words).toBe(MAX_SECTION_WORDS);
    expect(out[2].target_words).toBe(500);
  });

  it("defaults missing target_words to 500", () => {
    const out = parsePlan('[{"title":"X"}]');
    expect(out[0].target_words).toBe(500);
  });

  it("synthesises a title when missing", () => {
    const out = parsePlan('[{"target_words":500}]');
    expect(out[0].title).toBe("Section 1");
  });

  it("assigns sequential indices", () => {
    const out = parsePlan('[{"title":"A"},{"title":"B"},{"title":"C"}]');
    expect(out.map((s) => s.index)).toEqual([1, 2, 3]);
  });
});

/* ────────────────────────────────────────────────────────────────────
   planSections — uses injected runTool
   ──────────────────────────────────────────────────────────────────── */

function mockRunToolResponse(text, opts = {}) {
  return {
    text,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
    cost: opts.cost ?? 0.001,
  };
}

describe("planSections", () => {
  it("returns sections on first successful call", async () => {
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse('[{"title":"Intro","target_words":400}]')
    );
    const out = await planSections(runTool, "sys", "briefing", "inst", "input", "Plaintiff", "M1");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].title).toBe("Intro");
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
  });

  it("retries once on unparseable output, then succeeds", async () => {
    const runTool = vi.fn()
      .mockResolvedValueOnce(mockRunToolResponse("this is not json"))
      .mockResolvedValueOnce(
        mockRunToolResponse('[{"title":"A","target_words":400}]')
      );
    const out = await planSections(runTool, "sys", "briefing", "", "input", "", "M1");
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(out.sections).toHaveLength(1);
  });

  it("throws after 2 unparseable attempts", async () => {
    const runTool = vi.fn().mockResolvedValue(mockRunToolResponse("still not json"));
    await expect(
      planSections(runTool, "sys", "briefing", "", "input", "", "M1")
    ).rejects.toThrow(/Plan phase failed/);
    expect(runTool).toHaveBeenCalledTimes(2);
  });

  it("propagates runTool errors immediately (no JSON-retry)", async () => {
    const runTool = vi.fn().mockRejectedValue(new Error("Anthropic overload final"));
    await expect(
      planSections(runTool, "sys", "briefing", "", "input", "", "M1")
    ).rejects.toThrow(/Plan phase failed at attempt 1/);
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it("passes tool-specific description to the prompt", async () => {
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse('[{"title":"A","target_words":400}]')
    );
    await planSections(runTool, "sys", "draft", "", "input", "", "M1");
    const callArgs = runTool.mock.calls[0];
    /* callArgs = [system, prompt, maxTokens] */
    expect(callArgs[0]).toContain("drafting document");
    expect(callArgs[1]).toContain("drafting document");
    expect(callArgs[2]).toBe(2048);
  });
});

/* ────────────────────────────────────────────────────────────────────
   synthesiseSections — uses injected runTool + updateJob
   ──────────────────────────────────────────────────────────────────── */

function makeSections(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    title: `Section ${i + 1}`,
    description: `desc ${i + 1}`,
    target_words: 500,
  }));
}

describe("synthesiseSections", () => {
  it("happy path — all sections succeed, no banner", async () => {
    const sections = makeSections(3);
    const runTool = vi.fn().mockImplementation((sys, prompt, budget) => {
      /* Return stubbed section text based on how many times called */
      const n = runTool.mock.calls.length;
      return Promise.resolve(
        mockRunToolResponse(`## Section ${n}\n\nBody of section ${n}.`)
      );
    });
    const updateJob = vi.fn().mockResolvedValue(undefined);

    const out = await synthesiseSections(
      runTool,
      updateJob,
      "job-123",
      { section_results: null },
      "sys",
      "briefing",
      "",
      "input",
      sections,
      "",
      "M1",
      ""
    );

    expect(runTool).toHaveBeenCalledTimes(3);
    expect(out.failedSections).toEqual([]);
    expect(out.sectionsCompleted).toBe(3);
    expect(out.text).toContain("Section 1");
    expect(out.text).toContain("Section 2");
    expect(out.text).toContain("Section 3");
    expect(out.text).not.toContain("Note:");
    expect(out.text).not.toContain("failed");
  });

  it("prepends banner when one section fails", async () => {
    const sections = makeSections(3);
    const runTool = vi.fn()
      .mockResolvedValueOnce(mockRunToolResponse("## Section 1\n\nBody 1."))
      .mockRejectedValueOnce(new Error("Anthropic overload final"))
      .mockResolvedValueOnce(mockRunToolResponse("## Section 3\n\nBody 3."));
    const updateJob = vi.fn().mockResolvedValue(undefined);

    const out = await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: null },
      "sys", "briefing", "", "input", sections, "", "M1", ""
    );

    expect(out.failedSections).toEqual([2]);
    expect(out.sectionsCompleted).toBe(2);
    expect(out.text).toMatch(/\*\*Note:\*\*.*1 section.*failed/);
    expect(out.text).toContain("section 2");
    expect(out.text).toContain("Body 1.");
    expect(out.text).toContain("Body 3.");
  });

  it("handles all sections failing — returns sectionsCompleted 0", async () => {
    const sections = makeSections(2);
    const runTool = vi.fn().mockRejectedValue(new Error("Persistent failure"));
    const updateJob = vi.fn().mockResolvedValue(undefined);

    const out = await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: null },
      "sys", "briefing", "", "input", sections, "", "M1", ""
    );

    expect(out.failedSections).toEqual([1, 2]);
    expect(out.sectionsCompleted).toBe(0);
  });

  it("persists via updateJob after every section", async () => {
    const sections = makeSections(3);
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse("## Section\n\nBody.")
    );
    const updateJob = vi.fn().mockResolvedValue(undefined);

    await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: null },
      "sys", "briefing", "", "input", sections, "", "M1", ""
    );

    expect(updateJob).toHaveBeenCalledTimes(3);
    /* Every call should be for the same job with section_results set */
    for (const call of updateJob.mock.calls) {
      expect(call[0]).toBe("job-123");
      expect(call[1]).toHaveProperty("section_results");
    }
  });

  it("resumes from existing section_results, skipping done sections", async () => {
    const sections = makeSections(3);
    const prior = [
      { index: 1, title: "Section 1", text: "## Section 1\n\nAlready done.", inputTokens: 0, outputTokens: 0, cost: 0 },
      null,
      null,
    ];
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse("## Section\n\nNew body.")
    );
    const updateJob = vi.fn().mockResolvedValue(undefined);

    const out = await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: prior },
      "sys", "briefing", "", "input", sections, "", "M1", ""
    );

    /* Section 1 was already done — should NOT be called */
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(out.text).toContain("Already done.");
    expect(out.sectionsCompleted).toBe(3);
  });

  it("prepends headerText when provided", async () => {
    const sections = makeSections(1);
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse("## Section 1\n\nBody.")
    );
    const updateJob = vi.fn().mockResolvedValue(undefined);

    const out = await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: null },
      "sys", "briefing", "", "input", sections, "", "M1",
      "## Briefing Note — Test Matter\n"
    );

    expect(out.text.startsWith("## Briefing Note — Test Matter")).toBe(true);
  });

  it("continues even if updateJob throws (defensive persist)", async () => {
    const sections = makeSections(2);
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse("## Section\n\nBody.")
    );
    const updateJob = vi.fn().mockRejectedValue(new Error("DB transient"));

    const out = await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: null },
      "sys", "briefing", "", "input", sections, "", "M1", ""
    );

    /* Synthesis should have completed despite the persist failures */
    expect(out.sectionsCompleted).toBe(2);
    expect(runTool).toHaveBeenCalledTimes(2);
  });

  it("scales max_tokens budget to section target_words", async () => {
    const sections = [
      { index: 1, title: "Short", description: "", target_words: 300 },
      { index: 2, title: "Long", description: "", target_words: 2000 },
    ];
    const runTool = vi.fn().mockResolvedValue(
      mockRunToolResponse("## X\n\nBody.")
    );
    const updateJob = vi.fn().mockResolvedValue(undefined);

    await synthesiseSections(
      runTool, updateJob, "job-123", { section_results: null },
      "sys", "briefing", "", "input", sections, "", "M1", ""
    );

    /* runTool called with (system, prompt, budget). budget scales with target_words. */
    const budget1 = runTool.mock.calls[0][2];
    const budget2 = runTool.mock.calls[1][2];
    expect(budget2).toBeGreaterThan(budget1);
    expect(budget1).toBeGreaterThanOrEqual(1024); /* min budget */
  });
});
