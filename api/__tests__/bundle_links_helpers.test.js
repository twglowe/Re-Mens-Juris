/* v5.84 Bundle Links Push 1 — reading references, reading stamps, checking
   the page sequence and finding the target page.

   public/js/bundle_links_helpers.js is a plain browser script; it also
   exports through module.exports when Node loads it, which is how this
   reaches the same source the app runs. */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bl = require("../../public/js/bundle_links_helpers.js");

const {
  blIsAuthoritiesLabel, blGuessLabel, blParseRefs,
  blStampForm, blReadStamp, blFindStamp,
  blCheckSequence, blResolveRef, blLinkRect, blSpanRuns, blRelativePath,
  blTabStartsFromOutline, blLabelsFromKey, blFilesForName,
  blJoinRuns, blSpanRunsAt, blMergeRects,
} = bl;

const pick = (refs) => refs.map((r) => ({ label: r.label, tab: r.tab, page: r.page }));

describe("labels", () => {
  it("treats AB, DAB, PAB, AAB and their volumes as authorities", () => {
    for (const l of ["AB", "DAB", "PAB", "AAB", "AB1", "dab2"]) expect(blIsAuthoritiesLabel(l)).toBe(true);
    for (const l of ["A", "B", "B1", "CORE", "HB1", "EB1", "CB"]) expect(blIsAuthoritiesLabel(l)).toBe(false);
  });

  it("guesses labels from Tom's usual filenames", () => {
    expect(blGuessLabel("Bundle B.pdf")).toBe("B");
    expect(blGuessLabel("Bundle B1 - Pleadings.pdf")).toBe("B1");
    expect(blGuessLabel("Core Bundle.pdf")).toBe("CORE");
    expect(blGuessLabel("HB1.pdf")).toBe("HB1");
    expect(blGuessLabel("EB1 Exhibits.pdf")).toBe("EB1");
    expect(blGuessLabel("DAB Vol 2.pdf")).toBe("DAB2");
    expect(blGuessLabel("Authorities Bundle.pdf")).toBe("AB");
    expect(blGuessLabel("Bundles/Bundle C.pdf")).toBe("C");
  });

  it("makes no guess rather than a wrong one", () => {
    expect(blGuessLabel("Skeleton of the Plaintiff.pdf")).toBe("");
    expect(blGuessLabel("Bundle of pleadings.pdf")).toBe("");
  });
});

describe("references in the skeleton", () => {
  it("reads the three-part form in brackets", () => {
    expect(pick(blParseRefs("as the letter shows [B/2/45]."))).toEqual([{ label: "B", tab: 2, page: 45 }]);
  });

  it("reads Tom's labels: Core, HB1, EB1, B1", () => {
    const refs = blParseRefs("[Core/3/12] [HB1/4/101] [EB1/2/7] [B1/1/3]");
    expect(pick(refs)).toEqual([
      { label: "CORE", tab: 3, page: 12 },
      { label: "HB1", tab: 4, page: 101 },
      { label: "EB1", tab: 2, page: 7 },
      { label: "B1", tab: 1, page: 3 },
    ]);
  });

  it("reads a two-part reference as a page, except in an authorities bundle", () => {
    expect(pick(blParseRefs("[B/45]"))).toEqual([{ label: "B", tab: null, page: 45 }]);
    expect(pick(blParseRefs("[AB/3]"))).toEqual([{ label: "AB", tab: 3, page: null }]);
    expect(pick(blParseRefs("[DAB/14]"))).toEqual([{ label: "DAB", tab: 14, page: null }]);
    expect(pick(blParseRefs("[PAB/2/31]"))).toEqual([{ label: "PAB", tab: 2, page: 31 }]);
  });

  it("links a range to its first page", () => {
    const [r] = blParseRefs("[B/2/45-47]");
    expect(r).toMatchObject({ label: "B", tab: 2, page: 45, pageEnd: 47 });
    const [r2] = blParseRefs("[B/2/45–B/2/47]");
    expect(r2).toMatchObject({ page: 45, pageEnd: 47 });
  });

  it("gives each item in a list its own link", () => {
    const refs = blParseRefs("[B/2/45; C/3/12]");
    expect(pick(refs)).toEqual([{ label: "B", tab: 2, page: 45 }, { label: "C", tab: 3, page: 12 }]);
  });

  it("carries the label and tab into a bare continuation", () => {
    expect(pick(blParseRefs("[B/2/45, 47]"))).toEqual([
      { label: "B", tab: 2, page: 45 }, { label: "B", tab: 2, page: 47 },
    ]);
    expect(pick(blParseRefs("[B/2/45, 3/12]"))).toEqual([
      { label: "B", tab: 2, page: 45 }, { label: "B", tab: 3, page: 12 },
    ]);
  });

  it("reads braces and an unbracketed three-part reference", () => {
    expect(pick(blParseRefs("{B/2/45}"))).toEqual([{ label: "B", tab: 2, page: 45 }]);
    expect(pick(blParseRefs("see B/2/45 and C/1/3"))).toEqual([
      { label: "B", tab: 2, page: 45 }, { label: "C", tab: 1, page: 3 },
    ]);
  });

  it("records exactly where each reference sits so the box covers it", () => {
    const text = "See [B/2/45; C/3/12] above.";
    const refs = blParseRefs(text);
    expect(refs.map((r) => text.slice(r.start, r.end))).toEqual(["B/2/45", "C/3/12"]);
  });

  it("does not read dates, fractions or ordinary slashes as references", () => {
    expect(blParseRefs("On 12/3/2020 the and/or s/he 3/4 of [the board]")).toEqual([]);
    expect(blParseRefs("[2020] 1 WLR 45")).toEqual([]);
  });

  it("finds references in footnote text as in body text", () => {
    const refs = blParseRefs("[Footnote 12] Smith 1st, para 4 [B/3/77].");
    expect(pick(refs)).toEqual([{ label: "B", tab: 3, page: 77 }]);
  });
});

describe("the bundle stamp", () => {
  it("recognises the forms a stamp takes", () => {
    expect(blStampForm("45")).toMatchObject({ parts: "P" });
    expect(blStampForm("B45")).toMatchObject({ parts: "LP", label: "B" });
    expect(blStampForm("B/45")).toMatchObject({ parts: "LP", label: "B" });
    expect(blStampForm("B/2/45")).toMatchObject({ parts: "LTP", sep: "/", label: "B" });
    expect(blStampForm("B-2-45")).toMatchObject({ parts: "LTP", sep: "-" });
    expect(blStampForm("Page 3 of 10")).toBe(null);
  });

  it("reads only stamps of the tapped form and label", () => {
    const form = blStampForm("B/2/45");
    expect(blReadStamp("B/2/46", form)).toEqual({ tab: 2, page: 46 });
    expect(blReadStamp("C/1/12", form)).toBe(null);
    expect(blReadStamp("12", form)).toBe(null);
    const b1 = blStampForm("B1/3/9");
    expect(blReadStamp("B1/3/10", b1)).toEqual({ tab: 3, page: 10 });
  });

  /* Tom, 25 Nov 2026: a page may carry the document's own number, an
     exhibit page number or an earlier bundle reference beside the bundle
     stamp, so the right one must be chosen. */
  it("picks the bundle stamp from a page carrying several numbers", () => {
    const W = 600, H = 800;
    const items = [
      { str: "3", x: 295, y: 770, w: 10, h: 10 },          /* document's own page number, foot centre */
      { str: "JS1/12", x: 40, y: 20, w: 40, h: 10 },        /* exhibit page, top left */
      { str: "A/4/88", x: 40, y: 770, w: 40, h: 10 },       /* earlier bundle ref, foot left */
      { str: "B/2/45", x: 520, y: 20, w: 50, h: 10 },       /* bundle stamp, top right */
    ];
    const calib = { cx: 545 / W, cy: 25 / H, form: blStampForm("B/2/45") };
    expect(blFindStamp(items, W, H, calib)).toMatchObject({ tab: 2, page: 45 });
  });

  it("does not take a number of the right form from the wrong corner", () => {
    const W = 600, H = 800;
    const items = [{ str: "45", x: 295, y: 770, w: 10, h: 10 }];
    const calib = { cx: 0.9, cy: 0.03, form: blStampForm("44") };
    expect(blFindStamp(items, W, H, calib)).toBe(null);
  });
});

describe("checking the sequence", () => {
  const rd = (arr) => arr.map((x) => (x === null ? null : typeof x === "number" ? { tab: null, page: x } : { tab: x[0], page: x[1] }));

  it("accepts a clean continuous run", () => {
    const { pages, summary } = blCheckSequence(rd([1, 2, 3, 4, 5]));
    expect(summary).toMatchObject({ read: 5, break: 0, none: 0, mode: "continuous" });
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
  });

  it("infers a page the stamp could not be read on when its neighbours settle it", () => {
    const { pages } = blCheckSequence(rd([44, null, 46]));
    expect(pages[1]).toMatchObject({ page: 45, status: "inferred" });
  });

  it("does not infer across a gap that does not fit", () => {
    const { pages } = blCheckSequence(rd([44, null, 47]));
    expect(pages[1].status).toBe("none");
    expect(pages[2].status).toBe("break");
  });

  it("flags a jump, a repeat and a restart in a continuous bundle", () => {
    expect(blCheckSequence(rd([1, 2, 3, 9, 10])).pages[3].status).toBe("break");
    const rep = blCheckSequence(rd([1, 2, 2, 3])).pages;
    expect(rep[2].status).toBe("break");
  });

  it("leaves an unnumbered cover page unlinked", () => {
    const { pages } = blCheckSequence(rd([null, 1, 2, 3]));
    expect(pages[0].status).toBe("none");
    expect(pages[1]).toMatchObject({ page: 1, status: "read" });
  });

  it("continues the count from an earlier volume", () => {
    const { pages, summary } = blCheckSequence(rd([301, 302, 303]), { startPage: 301 });
    expect(summary.break).toBe(0);
    expect(pages[0].page).toBe(301);
    expect(blCheckSequence(rd([305, 306]), { startPage: 301 }).pages[0].status).toBe("break");
  });

  it("treats restarts at 1 as tabs when the bundle is paginated per tab", () => {
    const { pages, summary } = blCheckSequence(rd([1, 2, 3, 1, 2, 1, 2, 3]));
    expect(summary.mode).toBe("per-tab");
    expect(summary.break).toBe(0);
    expect(pages.map((p) => p.tab)).toEqual([1, 1, 1, 2, 2, 3, 3, 3]);
  });

  it("reads the tab from the stamp when the stamp carries it", () => {
    const { pages, summary } = blCheckSequence(rd([[1, 1], [1, 2], [2, 1], [2, 2]]));
    expect(summary.mode).toBe("per-tab");
    expect(summary.break).toBe(0);
    expect(pages[2]).toMatchObject({ tab: 2, page: 1 });
  });

  it("keeps a continuous count when the stamp carries the tab but numbering runs on", () => {
    const { summary, pages } = blCheckSequence(rd([[1, 1], [1, 2], [2, 3], [2, 4]]));
    expect(summary.mode).toBe("continuous");
    expect(summary.break).toBe(0);
    expect(pages[2].tab).toBe(2);
  });

  it("uses tab starts from bookmarks when the stamps carry no tab", () => {
    const { pages, summary } = blCheckSequence(rd([1, 2, 1, 2]), { tabStarts: { 0: 1, 2: 2 } });
    expect(summary.mode).toBe("per-tab");
    expect(pages.map((p) => p.tab)).toEqual([1, 1, 2, 2]);
  });
});

describe("finding the target page", () => {
  const map = (label, file, seq, opts) => {
    const res = blCheckSequence(seq.map((x) => (x === null ? null : Array.isArray(x) ? { tab: x[0], page: x[1] } : { tab: null, page: x })), opts);
    return { label, file, pages: res.pages, mode: res.summary.mode, tabStarts: opts && opts.tabStarts };
  };

  it("finds a page in a continuous bundle; the tab is a cross-check", () => {
    const maps = [map("B", "Bundle B.pdf", [[1, 1], [1, 2], [2, 3], [2, 4]])];
    expect(blResolveRef({ label: "B", tab: 2, page: 3 }, maps)).toMatchObject({ file: "Bundle B.pdf", pageIndex: 2, status: "matched" });
    expect(blResolveRef({ label: "B", tab: 1, page: 3 }, maps)).toMatchObject({ pageIndex: 2, warning: "tab differs" });
  });

  it("needs the tab in a per-tab bundle", () => {
    const maps = [map("B", "Bundle B.pdf", [1, 2, 1, 2])];
    expect(blResolveRef({ label: "B", tab: 2, page: 2 }, maps)).toMatchObject({ pageIndex: 3, status: "matched" });
    expect(blResolveRef({ label: "B", tab: null, page: 2 }, maps).status).toBe("ambiguous");
  });

  it("finds the right volume when a bundle is split across files", () => {
    const maps = [map("B", "B vol 1.pdf", [1, 2, 3]), map("B", "B vol 2.pdf", [4, 5, 6], { startPage: 4 })];
    expect(blResolveRef({ label: "B", tab: null, page: 5 }, maps)).toMatchObject({ file: "B vol 2.pdf", pageIndex: 1 });
  });

  it("links an authorities tab to its first page", () => {
    const maps = [map("AB", "Authorities.pdf", [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1]])];
    expect(blResolveRef({ label: "AB", tab: 2, page: null }, maps)).toMatchObject({ pageIndex: 2, status: "matched" });
  });

  it("says so when a label or page is not there", () => {
    const maps = [map("B", "Bundle B.pdf", [1, 2, 3])];
    expect(blResolveRef({ label: "C", tab: null, page: 1 }, maps).status).toBe("label-unknown");
    expect(blResolveRef({ label: "B", tab: null, page: 9 }, maps).status).toBe("not-found");
  });

  it("never links to a page Tom has not confirmed", () => {
    const maps = [map("B", "Bundle B.pdf", [44, null, 47])];
    expect(blResolveRef({ label: "B", tab: null, page: 47 }, maps).status).toBe("not-found");
  });

  it("reports an inferred page as inferred", () => {
    const maps = [map("B", "Bundle B.pdf", [44, null, 46])];
    expect(blResolveRef({ label: "B", tab: null, page: 45 }, maps)).toMatchObject({ pageIndex: 1, status: "inferred" });
  });
});

describe("placing the link and naming the file", () => {
  it("places the box by character position within a run", () => {
    const r = blLinkRect({ str: "abcdefghij", x: 100, y: 500, w: 100, h: 10 }, 2, 5);
    expect(r[0]).toBeCloseTo(119);
    expect(r[2]).toBeCloseTo(151);
    expect(r[1]).toBeLessThan(500);
    expect(r[3]).toBeGreaterThan(500);
  });

  it("splits a reference broken across two lines into two boxes", () => {
    const runs = [{ str: "see [B/2/" }, { str: "45] above" }];
    const text = runs.map((r) => r.str).join(" ");
    const [ref] = blParseRefs(text);
    expect(ref).toMatchObject({ label: "B", tab: 2, page: 45 });
    const spans = blSpanRuns(runs, ref.start, ref.end, " ");
    expect(spans).toEqual([{ run: 0, start: 5, end: 9 }, { run: 1, start: 0, end: 2 }]);
  });

  it("names bundles relative to the skeleton, never by a full path", () => {
    expect(blRelativePath("Skeleton.pdf", "Bundle B.pdf")).toBe("Bundle B.pdf");
    expect(blRelativePath("Skeleton.pdf", "Bundles/Bundle B.pdf")).toBe("Bundles/Bundle B.pdf");
    expect(blRelativePath("Skeletons/Sk.pdf", "Bundles/Bundle B.pdf")).toBe("../Bundles/Bundle B.pdf");
    expect(blRelativePath("Sk.pdf", "Bundle B.pdf")).not.toMatch(/^\//);
  });
});

/* v5.84 — found by running the helpers over a real case folder (Visionary v
   NBC, 26 Nov 2026). No document text is held here: only the shapes of the
   stamps, bookmarks and key that the real bundles showed. */
describe("lessons from a real case folder", () => {
  const rd = (arr) => arr.map((x) => (x === null ? null : { tab: null, page: x }));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it("reads an authorities bundle stamped in square brackets, and nothing else", () => {
    const form = blStampForm("[46]");
    expect(form).toMatchObject({ parts: "P", wrap: "[]" });
    expect(blReadStamp("[47]", form)).toEqual({ tab: null, page: 47 });
    expect(blReadStamp("47", form)).toBe(null);
    expect(blReadStamp("(7)", form)).toBe(null);
  });

  it("takes tab starts from both bookmark styles", () => {
    expect(blTabStartsFromOutline([
      { title: "01 - 2025.12.15 - Originating Summons", pageIndex: 1 },
      { title: "02 - 2025.12.15 - First Affirmation", pageIndex: 13 },
    ])).toEqual({ 1: 1, 13: 2 });
    expect(blTabStartsFromOutline([
      { title: "Tab 1 - Partnership Act - sections 24 and 25\u0000", pageIndex: 1 },
      { title: "Tab 2 - Bevan v Webb [1901] Ch 59", pageIndex: 7 },
    ])).toEqual({ 1: 1, 7: 2 });
    expect(blTabStartsFromOutline([{ title: "Index", pageIndex: 0 }, { title: "Pleadings", pageIndex: 3 }])).toEqual({});
  });

  it("keeps a bundle continuous when it has tab bookmarks but numbering runs on", () => {
    const { summary, pages } = blCheckSequence(rd(range(1, 6)), { tabStarts: { 0: 1, 3: 2 } });
    expect(summary.mode).toBe("continuous");
    expect(pages.map((p) => p.tab)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("cross-checks the skeleton's tab against the bookmarks", () => {
    const res = blCheckSequence(rd(range(1, 6)), { tabStarts: { 0: 1, 3: 2 } });
    const maps = [{ label: "A", file: "A.pdf", pages: res.pages, mode: res.summary.mode }];
    expect(blResolveRef({ label: "A", tab: 2, page: 5 }, maps)).toMatchObject({ pageIndex: 4, status: "matched" });
    expect(blResolveRef({ label: "A", tab: 1, page: 5 }, maps).warning).toBe("tab differs");
  });

  it("sets aside exhibit page numbers sitting where the stamp should be", () => {
    /* Bundle B: pages 3899–3906 carried their own 2…9 in the stamp's corner. */
    const seq = range(1, 3898).concat(range(2, 9)).concat(range(3907, 3950));
    const { pages, summary } = blCheckSequence(rd(seq));
    expect(summary.break).toBe(0);
    expect(pages[3898]).toMatchObject({ page: 3899, status: "inferred", misread: 2 });
    expect(pages[3905]).toMatchObject({ page: 3906, status: "inferred", misread: 9 });
    const maps = [{ label: "B", file: "B.pdf", pages, mode: summary.mode }];
    expect(blResolveRef({ label: "B", tab: null, page: 3, }, maps)).toMatchObject({ pageIndex: 2, status: "matched" });
  });

  it("sets aside a single stray number", () => {
    const seq = range(1, 875).concat([2, 3]).concat(range(878, 920));
    const { pages, summary } = blCheckSequence(rd(seq));
    expect(summary.break).toBe(0);
    expect(pages[875]).toMatchObject({ page: 876, misread: 2 });
  });

  it("does not paper over a genuine jump in the numbering", () => {
    const seq = range(1, 100).concat(range(106, 160));
    const { pages, summary } = blCheckSequence(rd(seq));
    expect(summary.break).toBe(1);
    expect(pages[100]).toMatchObject({ page: 106, status: "break" });
    expect(pages[100].misread).toBeUndefined();
  });

  it("reads the skeleton's key to its bundles", () => {
    const key = "References in square brackets to [A/TAB/PAGE], [B/TAB/PAGE] and [C/TAB/PAGE] are to Bundle A, Bundle B and the Correspondence Bundle respectively. References to [AB/TAB/PAGE] are to the Plaintiff’s Authorities Bundle.";
    expect(blLabelsFromKey(key)).toEqual([
      { label: "A", name: "Bundle A" },
      { label: "B", name: "Bundle B" },
      { label: "C", name: "Correspondence Bundle" },
      { label: "AB", name: "Plaintiff's Authorities Bundle" },
    ]);
    expect(blLabelsFromKey("[A/TAB/PAGE] and [B/TAB/PAGE] are to Bundle A.")).toEqual([]);
  });

  it("finds the files a bundle name means, and offers both versions when there are two", () => {
    const files = [
      "2026.11.23 - Bundle A.pdf", "2026.11.23 - Bundle AB.pdf",
      "2026.11.23 - Correspondence Bundle.pdf",
      "2026.11.26 - Correspondence Bundle (FSD 364 of 2025).pdf",
      "2026.11.26 - Plaintiff's Authorities Bundle (FSD 364 of 2025).pdf",
    ];
    expect(blFilesForName("Bundle A", files)).toEqual(["2026.11.23 - Bundle A.pdf"]);
    expect(blFilesForName("Correspondence Bundle", files)).toHaveLength(2);
    expect(blFilesForName("Plaintiff’s Authorities Bundle", files)).toHaveLength(1);
  });

  it("reads a range broken by a line end", () => {
    expect(blParseRefs("[B/4/3907- 3937]")[0]).toMatchObject({ label: "B", tab: 4, page: 3907, pageEnd: 3937 });
  });
});

/* v5.86 — pdf.js splits numbers into pieces. Joined with a space between
   every piece, [C/42/153-154] read as page 15 and 40 of 246 links in the
   first linked file went to the wrong page (Tom, 26 Nov 2026). */
describe("joining the pieces of a page", () => {
  const run = (str, x, w, y = 700, h = 11) => ({ str, x, y, w, h });

  it("does not put a space inside a split number", () => {
    const runs = [run("[C/", 100, 15), run("42", 115, 10), run("/", 125, 3), run("15", 128, 10), run("3", 138, 5), run("].", 143, 6)];
    const { text } = blJoinRuns(runs);
    expect(text).toBe("[C/42/153].");
    expect(blParseRefs(text)[0]).toMatchObject({ label: "C", tab: 42, page: 153 });
  });

  it("keeps the space the page shows between words", () => {
    const { text } = blJoinRuns([run("letter of", 100, 40), run("18 November", 145, 50)]);
    expect(text).toBe("letter of 18 November");
  });

  it("puts a space at a line end, so a range broken over two lines still reads", () => {
    const runs = [run("[C/42/153-", 400, 50, 700), run("154].", 100, 20, 686)];
    const { text } = blJoinRuns(runs);
    expect(blParseRefs(text)[0]).toMatchObject({ page: 153, pageEnd: 154 });
  });

  it("maps a reference back to exactly the pieces it came from", () => {
    const runs = [run("see [B/4/390", 100, 55), run("7]", 155, 8)];
    const J = blJoinRuns(runs);
    const [ref] = blParseRefs(J.text);
    expect(ref.page).toBe(3907);
    expect(blSpanRunsAt(runs, J.starts, ref.start, ref.end)).toEqual([
      { run: 0, start: 5, end: 12 }, { run: 1, start: 0, end: 1 },
    ]);
  });

  it("draws one box per line of a reference", () => {
    expect(blMergeRects([[100, 690, 110, 702], [110, 690, 125, 702], [100, 676, 120, 688]])).toEqual([
      [100, 690, 125, 702], [100, 676, 120, 688],
    ]);
  });
});
