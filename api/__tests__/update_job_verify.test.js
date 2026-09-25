/* v5.78: updateJob's saved-field check must ignore object key order, as
   Postgres jsonb does. The v5.76 section plan failed here in production. */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-key";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";

import { describe, it, expect } from "vitest";
const { canonicalJson } = await import("../worker.js");
import { parsePlan } from "../lib/sectioned_synth.js";

/* What a jsonb round trip does to key order: shorter keys first, then bytewise. */
function jsonbRoundTrip(v) {
  if (Array.isArray(v)) return v.map(jsonbRoundTrip);
  if (v && typeof v === "object") {
    const out = {};
    Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .forEach((k) => { out[k] = jsonbRoundTrip(v[k]); });
    return out;
  }
  return v;
}

describe("canonicalJson", () => {
  it("treats a jsonb round trip of the v5.76 plan as unchanged", () => {
    const plan = parsePlan(JSON.stringify([
      { title: "Summary of the Proceedings", point: "P", basis: "B", description: "D", target_words: 300 },
    ]));
    const back = jsonbRoundTrip(plan);
    expect(JSON.stringify(back)).not.toBe(JSON.stringify(plan)); /* the old check failed here */
    expect(canonicalJson(back)).toBe(canonicalJson(plan));
  });

  it("treats a jsonb round trip of section_results as unchanged", () => {
    const results = [{ index: 1, title: "T", text: "x", points: ["a"], inputTokens: 1, outputTokens: 2, cost: 0.5, elapsed_s: 3 }, null];
    expect(canonicalJson(jsonbRoundTrip(results))).toBe(canonicalJson(results));
  });

  it("still catches a real difference", () => {
    expect(canonicalJson([{ a: 1 }])).not.toBe(canonicalJson([{ a: 2 }]));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson("running")).not.toBe(canonicalJson("paused"));
    expect(canonicalJson(null)).not.toBe(canonicalJson([]));
  });
});
