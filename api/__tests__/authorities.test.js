/* v5.81 Push 2 — List of Authorities: the pure half (api/lib/authorities.js)
   and the wiring in api/tools.js, api/cron-resume.js and vercel.json. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import * as A from "../lib/authorities.js";

/* ── Jurisdictions ─────────────────────────────────────────────────── */

describe("jurisdictions", () => {
  it("normalises the names the model may use", () => {
    expect(A.normaliseJurisdiction("England and Wales")).toBe("United Kingdom");
    expect(A.normaliseJurisdiction("UK")).toBe("United Kingdom");
    expect(A.normaliseJurisdiction("Privy Council")).toBe("United Kingdom");
    expect(A.normaliseJurisdiction("BVI")).toBe("British Virgin Islands");
    expect(A.normaliseJurisdiction("cayman")).toBe("Cayman Islands");
    expect(A.normaliseJurisdiction("Isle of Man")).toBe("Isle of Man");
    expect(A.normaliseJurisdiction("New South Wales")).toBe("Australia");
    expect(A.normaliseJurisdiction("Delaware")).toBe("United States");
    expect(A.normaliseJurisdiction("new zealand")).toBe("New Zealand");
    expect(A.normaliseJurisdiction("Unknown")).toBe(A.UNKNOWN_JURISDICTION);
    expect(A.normaliseJurisdiction("")).toBe(A.UNKNOWN_JURISDICTION);
  });

  it("orders them as Tom set: Cayman, UK, BVI, Bermuda, IoM; then Australia, HK, Canada, US, then others A–Z", () => {
    const list = ["Singapore", "United States", "Bermuda", "Jersey", "Canada", "Cayman Islands", "Hong Kong", "New Zealand", "United Kingdom", "Isle of Man", "Australia", "British Virgin Islands", A.UNKNOWN_JURISDICTION];
    expect(list.sort(A.compareJurisdictions)).toEqual([
      "Cayman Islands", "United Kingdom", "British Virgin Islands", "Bermuda", "Isle of Man",
      "Australia", "Hong Kong", "Canada", "United States", "Jersey", "New Zealand", "Singapore", A.UNKNOWN_JURISDICTION,
    ]);
    expect(A.jurisdictionRank("Bermuda").section).toBe("home");
    expect(A.jurisdictionRank("Jersey").section).toBe("foreign");
  });
});

/* ── Citations and years ───────────────────────────────────────────── */

describe("report year", () => {
  it("is the year of the first law report, not a neutral citation", () => {
    expect(A.reportYear(["[2001] UKHL 16", "[2003] 2 AC 1"])).toBe(2003);
    expect(A.reportYear(["[2016] B.C.C. 79", "[2015] UKSC 71"])).toBe(2016);
    expect(A.reportYear(["[1970] 1 WLR 352", "[1971] 1 All ER 653"])).toBe(1970);
  });
  it("falls back to a neutral citation, a round-bracket year, or a date", () => {
    expect(A.reportYear(["[2009] EWHC 339 (Ch)"])).toBe(2009);
    expect(A.reportYear(["(1938) 61 CLR 457"])).toBe(1938);
    expect(A.reportYear(["2014 (2) CILR 191"])).toBe(2014);
    expect(A.reportYear(["FSD 24 of 2021 (RPJ), judgment dated 10 December 2021"])).toBe(2021);
    expect(A.reportYear(["unreported, 1 March 2016"])).toBe(2016);
    expect(A.reportYear([])).toBe(null);
  });
  it("knows [1970] Ch 212 is a report and [2020] UKSC 33 is not", () => {
    expect(A.isNeutralCitation("[1970] Ch 212")).toBe(false);
    expect(A.isNeutralCitation("[2020] UKSC 33")).toBe(true);
    expect(A.isNeutralCitation("[2026] CIGC (FSD) 10")).toBe(true);
    expect(A.isNeutralCitation("[2020] (1) CILR 417")).toBe(false);
  });
});

/* ── Rebuilding text from chunks ───────────────────────────────────── */

describe("rebuildText", () => {
  const para = (n) => n + ". The court considered the submissions of counsel at some length and concluded that the trustee had acted within the scope of the power conferred by the trust instrument.";
  it("strips the chunker's 150-character repeat, whitespace apart", () => {
    const a = para(1) + "\n\n" + para(2);
    const tail = a.slice(-150);
    const b = tail + "\n\n" + para(3);
    const t = A.rebuildText([{ content: a, chunk_index: 0, page_number: 1 }, { content: b, chunk_index: 1, page_number: 1 }]);
    expect(t).toBe("[Page 1]\n" + a + "\n\n" + para(3));
  });
  it("reaches back past a short chunk, and keeps a word break at the join", () => {
    const a = "x".repeat(40) + " alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega and then some more words here to fill";
    const short = "Footer 12";
    const repeat = (a + "\n" + short).slice(-150);
    const c = repeat + " continues on the next page.";
    const t = A.rebuildText([
      { content: a, chunk_index: 0, page_number: 1 },
      { content: short, chunk_index: 1, page_number: 1 },
      { content: c, chunk_index: 2, page_number: 2 },
    ]);
    expect(t).toContain(short + "\n\n[Page 2]\ncontinues on the next page.");
    expect(t).not.toContain("fillcontinues");
  });
  it("marks page changes and sorts by chunk index", () => {
    const t = A.rebuildText([{ content: "Second page text that is long enough.", chunk_index: 1, page_number: 2 }, { content: "First page text that is long enough.", chunk_index: 0, page_number: 1 }]);
    expect(t).toBe("[Page 1]\nFirst page text that is long enough.\n\n[Page 2]\nSecond page text that is long enough.");
  });
});

describe("batchText", () => {
  it("cuts at page breaks, carries context, and reports the page range", () => {
    let text = "";
    for (let p = 1; p <= 6; p++) text += (p > 1 ? "\n\n" : "") + "[Page " + p + "]\n" + ("Line of page " + p + ". ").repeat(300);
    const b = A.batchText(text, 8000);
    expect(b.length).toBeGreaterThan(1);
    expect(b[0].pages).toBe("1");
    expect(b[1].context.length).toBeLessThanOrEqual(2500);
    expect(b[1].text.startsWith("[Page 2]")).toBe(true);
    expect(b.map(x => x.text).join("")).toBe(text);
  });
});

describe("skeletonLabel", () => {
  it("drops the extension, a leading date and underscores", () => {
    expect(A.skeletonLabel("2026.10.05_-_Skeleton_Argument_on_behalf_of_ACC_-_FSD_161_of_2018_NSJ.pdf")).toBe("Skeleton Argument on behalf of ACC - FSD 161 of 2018 NSJ");
    expect(A.skeletonLabel("Reply skeleton.docx")).toBe("Reply skeleton");
  });
});

/* ── Model output ──────────────────────────────────────────────────── */

describe("parseJsonBlock", () => {
  it("reads JSON inside the tags, with prose around it and a trailing comma", () => {
    expect(A.parseJsonBlock("Here you are:\n<json>{\"citations\":[{\"name\":\"X\",},]}</json>\nDone.")).toEqual({ citations: [{ name: "X" }] });
  });
  it("throws on nothing usable", () => {
    expect(() => A.parseJsonBlock("no json here")).toThrow();
  });
});

describe("cleanInstances", () => {
  it("keeps document order, normalises kinds and strips 'fn'/'para' prefixes", () => {
    const out = A.cleanInstances({ citations: [
      { kind: "CASE", name: "Swain v Hillman", citation: "[2001] 1 All ER 91", para: "para 12", fn: "fn 3", proposition: "p" },
      { kind: "textbook", author: "Snell", title: "Equity", edition: "34th", year: "2019" },
      { kind: "related", name: "Judgment of Coleman J", para: "¶ 4" },
      { name: "" },
    ] }, 1, 2, 0);
    expect(out.map(x => x.kind)).toEqual(["case", "textbook", "related"]);
    expect(out[0].para).toBe("12");
    expect(out[0].fn).toBe("3");
    expect(out[1].name).toBe("Snell, Equity");
    expect(out[2].para).toBe("4");
    expect(out[0].order).toBeLessThan(out[1].order);
    expect(out[0].order).toBeGreaterThan(1e6);
  });
});

/* ── Merging ───────────────────────────────────────────────────────── */

function inst(id, doc, name, citation, para, fn, kind, prop) {
  return { id, doc, order: doc * 1e6 + parseInt(id.slice(1), 10), kind: kind || "case", name, citation: citation || "", pinpoint: "", para: para || "", fn: fn || "", proposition: prop || "", author: "", title: "", edition: "", year: "" };
}

describe("merging", () => {
  const instances = [
    inst("i1", 0, "Three Rivers DC v Bank of England (No 3)", "[2001] UKHL 16; [2003] 2 AC 1", "3", "", "case", "No mini-trial."),
    inst("i2", 0, "Three Rivers", "", "9", "", "case", "No mini-trial on a strike-out."),
    inst("i3", 1, "Three Rivers DC v Bank of England (No 3)", "[2003] 2 AC 1", "", "4", "case", "Real prospect of success."),
    inst("i4", 1, "Snell's Equity", "", "7", "", "textbook", "Equitable principles."),
  ];
  const entries = A.mergeEntries(instances);

  it("dedupes the same authority at the same place only", () => {
    const d = A.dedupeInstances(instances.concat([inst("i5", 1, "Three Rivers DC v Bank of England (No 3)", "[2003] 2 AC 1", "", "4")]));
    expect(d.length).toBe(4);
  });

  it("offers distinct name+citation lines to the merge", () => {
    expect(entries.length).toBe(4);
    expect(entries[0].members).toEqual(["i1"]);
    expect(entries.map(e => e.id)).toEqual(["E1", "E2", "E3", "E4"]);
  });

  it("applies the model's groups, keeps only reports found in the skeletons, and takes the report year", () => {
    const auths = A.applyMerge({ authorities: [
      { members: ["E1", "E2", "E3"], kind: "case", name: "Three Rivers DC v Bank of England (No 3)", jurisdiction: "England and Wales", court: "House of Lords",
        reports: ["[2003] 2 AC 1", "[2001] UKHL 16", "[2001] 2 All ER 513"] },
    ] }, entries);
    expect(auths.length).toBe(2);
    expect(auths[0].reports).toEqual(["[2003] 2 AC 1", "[2001] UKHL 16"]);   /* All ER was never in the skeletons */
    expect(auths[0].year).toBe(2003);
    expect(auths[0].jurisdiction).toBe("United Kingdom");
    expect(auths[0].instanceIds).toEqual(["i1", "i2", "i3"]);
    expect(auths[1].kind).toBe("textbook");                                  /* left out by the model: its own entry */
    expect(auths[1].instanceIds).toEqual(["i4"]);
  });

  it("falls back to the citations as written when the model's reports all fail the check", () => {
    const auths = A.applyMerge({ authorities: [{ members: ["E1"], name: "Three Rivers", reports: ["[1999] 1 WLR 1"] }] }, entries);
    expect(auths[0].reports).toEqual(["[2001] UKHL 16", "[2003] 2 AC 1"]);
  });

  it("never lets one entry sit in two groups, and a law citation anywhere makes a related judgment a case", () => {
    const e2 = A.mergeEntries([inst("i1", 0, "Coleman J judgment", "", "1", "", "related"), inst("i2", 0, "Coleman J judgment", "", "2", "", "case")]);
    const auths = A.applyMerge({ authorities: [{ members: ["E1", "E2"], kind: "related", name: "Coleman J judgment" }, { members: ["E2"], name: "dup" }] }, e2);
    expect(auths.length).toBe(1);
    expect(auths[0].kind).toBe("case");
  });

  it("groups by name alone when the model gives nothing", () => {
    const auths = A.fallbackMerge(entries);
    expect(auths.map(a => a.name)).toEqual(["Three Rivers DC v Bank of England (No 3)", "Three Rivers", "Snell's Equity"]);
    expect(auths[0].reports).toEqual(["[2001] UKHL 16", "[2003] 2 AC 1"]);
  });
});

/* ── Verification ──────────────────────────────────────────────────── */

describe("verification", () => {
  it("builds a search from distinctive words on each side of the v", () => {
    expect(A.searchTerms({ kind: "case", name: "Three Rivers DC v Bank of England (No 3)" })).toEqual(["Three", "England"]);
    expect(A.searchTerms({ kind: "case", name: "Re Baosheng Media Group Holdings Ltd" })).toEqual(["Baosheng", "Media"]);
    expect(A.searchTerms({ kind: "case", name: "Re Abraaj" })).toEqual(["Abraaj"]);
    expect(A.searchTerms({ kind: "textbook", author: "Snell", title: "Snell's Equity" })).toEqual(["Snell", "Equity"]);
    expect(A.websearchQuery(["Three", "England"])).toBe('"Three" "England"');
  });

  it("recognises the decision itself by its report citation, not by the parties' names", () => {
    const a = { reports: ["[2003] 2 AC 1"] };
    expect(A.isSameDecision(a, "Three Rivers DC v Bank of England (No 3) [2003] 2 AC 1")).toBe(true);
    expect(A.isSameDecision(a, "Three Rivers DC v Bank of England (No 6) [2004] UKHL 48")).toBe(false);
  });

  it("applies a result, refusing a verdict that cites no supplied passage, and leaves unplaced citations as not found", () => {
    const byId = { i1: inst("i1", 0, "X v Y", "", "1", "", "case", "P one"), i2: inst("i2", 0, "X v Y", "", "2", "", "case", "P two"), i3: inst("i3", 1, "X v Y", "", "3", "", "case", "P three") };
    const a = { key: "A1", kind: "case", name: "X v Y", reports: [], instanceIds: ["i1", "i2", "i3"], propositions: [] };
    const passages = { A1: [{ pid: "P1", label: "Z v W (Library)", text: "..." }] };
    A.applyVerify({ results: [{ key: "A1", propositions: [
      { text: "One and two", instances: ["i1", "i2"], status: "supported", passage: "P1", pinpoint: "at [4]" },
      { text: "Ghost", instances: ["i9"], status: "supported", passage: "P1" },
      { text: "Three", instances: ["i3"], status: "supported", passage: "P7" },
    ] }] }, [a], passages, byId);
    expect(a.propositions.length).toBe(2);
    expect(a.propositions[0]).toMatchObject({ status: "supported", source: "Z v W (Library)", pinpoint: "at [4]", instanceIds: ["i1", "i2"] });
    expect(a.propositions[1]).toMatchObject({ status: "not_found", instanceIds: ["i3"], source: "" });
  });

  it("marks everything unchecked when the check itself failed", () => {
    const byId = { i1: inst("i1", 0, "X v Y", "", "1", "", "case", "P one") };
    const a = { key: "A1", kind: "case", name: "X v Y", reports: [], instanceIds: ["i1"], propositions: [] };
    A.applyVerify(null, [a], {}, byId);
    expect(a.propositions[0].status).toBe("unchecked");
  });

  it("gives a related judgment its propositions as facts, one per distinct wording", () => {
    const byId = { i1: inst("i1", 0, "J", "", "1", "", "related", "Found X"), i2: inst("i2", 1, "J", "", "2", "", "related", "found x"), i3: inst("i3", 1, "J", "", "3", "", "related", "Ordered Y") };
    const a = { key: "A1", kind: "related", instanceIds: ["i1", "i2", "i3"] };
    A.relatedPropositions(a, byId);
    expect(a.propositions.map(p => [p.status, p.instanceIds.length])).toEqual([["facts", 2], ["facts", 1]]);
  });
});

/* ── Views ─────────────────────────────────────────────────────────── */

describe("views", () => {
  const byId = {
    i1: inst("i1", 0, "Loch v John Blackwood Ltd", "[1924] AC 783", "12", "", "case", "Lack of confidence must rest on conduct."),
    i2: inst("i2", 1, "Loch v John Blackwood Ltd", "[1924] AC 783", "4", "7", "case", "Lack of confidence must rest on conduct."),
    i3: inst("i3", 0, "Re Baosheng", "[2024] GC 155", "3", "", "case", "A drastic remedy of last resort."),
    i4: inst("i4", 1, "Teck v Millar", "(1972) 33 DLR 3d 288", "9", "", "case", "Proper purpose."),
    i5: inst("i5", 1, "Snell's Equity", "", "10", "", "textbook", "Equitable principles."),
    i6: inst("i6", 0, "Judgment of Coleman J", "", "2", "1", "related", "Found the subscription was at arm's length."),
    i7: inst("i7", 0, "Abc v Def", "[2019] 1 NZLR 9", "20", "", "case", "A New Zealand point."),
  };
  const auths = [
    { key: "A1", kind: "case", name: "Loch v John Blackwood Ltd", jurisdiction: "United Kingdom", reports: ["[1924] AC 783"], year: 1924, instanceIds: ["i1", "i2"], propositions: [{ text: "Lack of confidence must rest on conduct.", instanceIds: ["i1", "i2"], status: "supported", source: "Re Z (Library)", pinpoint: "at [8]", note: "" }] },
    { key: "A2", kind: "case", name: "Re Baosheng", jurisdiction: "Cayman Islands", reports: ["[2024] GC 155"], year: 2024, instanceIds: ["i3"], propositions: [{ text: "A drastic remedy of last resort.", instanceIds: ["i3"], status: "not_found", source: "", pinpoint: "", note: "" }] },
    { key: "A3", kind: "case", name: "Teck v Millar", jurisdiction: "Canada", reports: ["(1972) 33 DLR 3d 288"], year: 1972, instanceIds: ["i4"], propositions: [{ text: "Proper purpose.", instanceIds: ["i4"], status: "partly", source: "Q (Library)", pinpoint: "", note: "narrower" }] },
    { key: "A4", kind: "textbook", name: "Snell's Equity", author: "McGhee", title: "Snell's Equity", edition: "34th", year: 2019, jurisdiction: "", reports: [], instanceIds: ["i5"], propositions: [{ text: "Equitable principles.", instanceIds: ["i5"], status: "unchecked", source: "", pinpoint: "", note: "" }] },
    { key: "A5", kind: "related", name: "Judgment of Coleman J", jurisdiction: "Hong Kong", reports: [], year: null, instanceIds: ["i6"], propositions: [{ text: "Found the subscription was at arm's length.", instanceIds: ["i6"], status: "facts", source: "", pinpoint: "", note: "" }] },
    { key: "A6", kind: "case", name: "Abc v Def", jurisdiction: "New Zealand", reports: ["[2019] 1 NZLR 9"], year: 2019, instanceIds: ["i7"], propositions: [{ text: "A New Zealand point.", instanceIds: ["i7"], status: "not_found", source: "", pinpoint: "", note: "" }] },
  ];
  const ctx = { matterName: "M", skeletons: [{ label: "ACC skeleton", date: "5 October 2026" }, { label: "CNBM submissions", date: "" }], authorities: auths, instances: byId, warnings: ["One page could not be read."] };
  const v = A.buildViews(ctx);

  it("alphabetical view: home jurisdictions, then foreign, then textbooks, then related judgments", () => {
    const i = (s) => v.alpha.indexOf(s);
    expect(i("## CASES")).toBeLessThan(i("### Cayman Islands"));
    expect(i("### Cayman Islands")).toBeLessThan(i("### United Kingdom"));
    expect(i("## FOREIGN AUTHORITIES")).toBeLessThan(i("### Canada"));
    expect(i("### Canada")).toBeLessThan(i("### New Zealand"));
    expect(i("### New Zealand")).toBeLessThan(i("## TEXTBOOKS"));
    expect(i("## TEXTBOOKS")).toBeLessThan(i("## JUDGMENTS IN THESE AND RELATED PROCEEDINGS"));
    expect(v.alpha).toContain("**1.** *Re Baosheng* [2024] GC 155");
    expect(v.alpha).toContain("- *Cited in:* ACC skeleton — ¶12 · CNBM submissions — fn 7 (¶4)");
    expect(v.alpha).toContain("✓ Supported: Re Z (Library) at [8]");
    expect(v.alpha).toContain("◐ Partly supported: Q (Library) — narrower");
    expect(v.alpha).toContain("? Not found in other judgments or textbooks");
    expect(v.alpha).toContain("McGhee, *Snell's Equity*, (34th ed, 2019)");
    expect(v.alpha).toContain("- *Cited for:* Found the subscription was at arm's length.");
    expect(v.alpha).toContain("⚠️ One page could not be read.");
    expect(v.alpha).toContain("- ACC skeleton (5 October 2026)");
  });

  it("year view orders by report year within each jurisdiction", () => {
    expect(v.year).toContain("*Order: by year of report*");
  });

  it("order-of-citation view lists each skeleton's authorities in the order first cited, with that skeleton's locations only", () => {
    const i = (s) => v.cited.indexOf(s);
    expect(i("## ACC skeleton")).toBeLessThan(i("## CNBM submissions"));
    const acc = v.cited.slice(i("## ACC skeleton"), i("## CNBM submissions"));
    expect(acc.indexOf("Loch v John Blackwood")).toBeLessThan(acc.indexOf("Re Baosheng"));
    expect(acc.indexOf("Re Baosheng")).toBeLessThan(acc.indexOf("Abc v Def"));
    expect(acc).toContain("- *Cited at:* ¶12");
    expect(acc).not.toContain("fn 7");
    expect(acc).not.toContain("Teck v Millar");
    expect(acc).toContain("### Judgments in these and related proceedings");
  });

  it("embeds the other two views after the alphabetical text and gets them back", () => {
    const r = A.embedViews(v);
    expect(r.startsWith(v.alpha)).toBe(true);
    expect(r).toContain(A.VIEW_MARKER);
    const back = A.splitViews(r);
    expect(back.alpha).toBe(v.alpha);
    expect(back.year).toBe(v.year);
    expect(back.cited).toBe(v.cited);
    expect(A.splitViews("plain text").year).toBe(null);
  });
});

/* ── Wiring ────────────────────────────────────────────────────────── */

describe("wiring", () => {
  const tools = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8");
  const cron = fs.readFileSync(new URL("../cron-resume.js", import.meta.url), "utf8");
  const vercel = JSON.parse(fs.readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const worker = fs.readFileSync(new URL("../authoritiesWorker.js", import.meta.url), "utf8");

  it("api/tools.js accepts the tool, whitelists authoritySkeletons, and fires the right worker", () => {
    expect(tools).toMatch(/validTools = \[[^\]]*"authorities"/);
    expect(tools).toMatch(/authoritySkeletons\s*\}\s*=\s*req\.body/);
    expect(tools).toMatch(/authoritySkeletons:\s*skeletonList/);
    expect(tools).toMatch(/tool === "authorities" \? "\/api\/authoritiesWorker" : "\/api\/worker"/);
  });

  it("cron-resume routes the tool to its own worker", () => {
    expect(cron).toMatch(/job\.tool_name === "authorities" \? "\/api\/authoritiesWorker"/);
  });

  it("vercel.json gives the worker the long duration", () => {
    expect(vercel.functions["api/authoritiesWorker.js"]).toEqual({ maxDuration: 800 });
  });

  it("the worker never touches worker.js and claims the job before working", () => {
    expect(worker).not.toMatch(/from "\.\/worker\.js"/);
    expect(worker).toMatch(/\.eq\("updated_at", job\.updated_at\)/);
    expect(worker).toMatch(/createClient\(process\.env\.SUPABASE_URL/);
    expect(worker.lastIndexOf("createClient(process.env")).toBeGreaterThan(worker.indexOf("export default async function handler"));
  });
});
