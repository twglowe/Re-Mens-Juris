/* v5.62 Push D — finding the judgment boundaries in a bundled PDF.

   public/js/case_law_split.js is a plain browser script; it also exports
   through module.exports when Node loads it, which is how this reaches the
   same source the app runs. */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const split = require("../../public/js/case_law_split.js");

const {
  clDetectCaseBoundaries, clPageOffsets, clSlicePages, clSplitPages,
  clIsCourtHeaderLine, clIsTitleLine,
} = split;

/* Filler long enough to clear CL_MIN_SEGMENT_CHARS between boundaries. */
function body(n) {
  return Array.from({ length: n }, (_, i) =>
    "The court considered the submissions of counsel at paragraph " + i +
    " and concluded that the trustee had acted within the scope of the power conferred.").join("\n");
}

function judgment(court, title) {
  return [court, "", title, "", "B E T W E E N", "", body(30)].join("\n");
}

describe("clIsCourtHeaderLine", () => {
  it("accepts real court headings", () => {
    ["IN THE GRAND COURT OF THE CAYMAN ISLANDS",
     "IN THE COURT OF APPEAL OF BERMUDA",
     "THE JUDICIAL COMMITTEE OF THE PRIVY COUNCIL",
     "In the Supreme Court",
     "Before: Smith J"].forEach((l) => expect(clIsCourtHeaderLine(l)).toBe(true));
  });

  it("rejects the IN THE MATTER OF lines inside a judgment's own header", () => {
    ["IN THE MATTER OF THE COMPANIES ACT (2025 REVISION)",
     "IN THE MATTER OF ABC LTD (IN OFFICIAL LIQUIDATION)",
     "in the matter of the Companies Act and in the matter of a petition presented to the court",
    ].forEach((l) => expect(clIsCourtHeaderLine(l)).toBe(false));
  });

  it("rejects prose that merely mentions a court", () => {
    ["The claimant relies on the decision in the court below.",
     "Counsel referred the court to the judgment in the court of appeal.",
     "It was accepted that the tribunal had jurisdiction over the dispute.",
    ].forEach((l) => expect(clIsCourtHeaderLine(l)).toBe(false));
  });
});

describe("clIsTitleLine", () => {
  it("accepts a citation standing alone and BETWEEN, however spaced", () => {
    expect(clIsTitleLine("[2003] 2 AC 709")).toBe(true);
    expect(clIsTitleLine("[2016] (2) CILR 1")).toBe(true);
    expect(clIsTitleLine("[2021] UKPC 47")).toBe(true);
    expect(clIsTitleLine("(1997) 3 All ER 1")).toBe(true);
    expect(clIsTitleLine("B E T W E E N")).toBe(true);
    expect(clIsTitleLine("BETWEEN:")).toBe(true);
  });

  it("rejects a citation quoted inside a sentence", () => {
    expect(clIsTitleLine("As set out in [2003] 2 AC 709 at 712, the principle is settled.")).toBe(false);
    expect(clIsTitleLine("Between the parties there was no concluded agreement.")).toBe(false);
  });
});

describe("clDetectCaseBoundaries", () => {
  it("treats a short file as one document whatever it looks like", () => {
    expect(clDetectCaseBoundaries("IN THE GRAND COURT\n\nshort")).toEqual([0]);
  });

  it("finds each judgment in a bundle", () => {
    const text = [
      judgment("IN THE GRAND COURT OF THE CAYMAN ISLANDS", "Re Sphinx Group of Funds"),
      judgment("IN THE COURT OF APPEAL OF BERMUDA", "AHAB v Saad"),
      judgment("THE JUDICIAL COMMITTEE OF THE PRIVY COUNCIL", "Schmidt v Rosewood Trust Ltd"),
    ].join("\n\n");
    const bounds = clDetectCaseBoundaries(text);
    expect(bounds).toHaveLength(3);
    expect(bounds[0]).toBe(0);
    expect(text.slice(bounds[1], bounds[1] + 30)).toContain("IN THE COURT OF APPEAL");
    expect(text.slice(bounds[2], bounds[2] + 60)).toContain("PRIVY COUNCIL");
  });

  it("does not split a single judgment that quotes other authorities", () => {
    const text = [
      "IN THE GRAND COURT OF THE CAYMAN ISLANDS", "",
      "IN THE MATTER OF THE COMPANIES ACT (2025 REVISION)", "",
      body(20),
      "Counsel relied on Schmidt v Rosewood Trust Ltd [2003] 2 AC 709, in which the Privy Council held as follows.",
      body(20),
      "That approach was followed in the court of appeal in AHAB v Saad [2021] UKPC 47.",
      body(20),
    ].join("\n");
    expect(clDetectCaseBoundaries(text)).toEqual([0]);
  });

  it("ignores a running header that repeats every page", () => {
    const page = "IN THE GRAND COURT OF THE CAYMAN ISLANDS\n" + body(3);
    const text = Array.from({ length: 6 }, () => page).join("\n");
    /* Each repeat is well under CL_MIN_SEGMENT_CHARS apart, so none counts. */
    expect(clDetectCaseBoundaries(text).length).toBeLessThan(3);
  });
});

describe("clPageOffsets and clSlicePages", () => {
  const pages = [
    { page: 1, text: "aaaa" },
    { page: 2, text: "bbbb" },
    { page: 3, text: "cccc" },
  ];

  it("accounts for the two-character join between pages", () => {
    const offs = clPageOffsets(pages);
    expect(offs[0]).toMatchObject({ page: 1, start: 0, end: 4 });
    expect(offs[1]).toMatchObject({ page: 2, start: 6, end: 10 });
    expect(offs[2]).toMatchObject({ page: 3, start: 12, end: 16 });
    /* the offsets must match how the text is actually joined */
    const joined = pages.map((p) => p.text).join("\n\n");
    expect(joined.slice(offs[2].start, offs[2].end)).toBe("cccc");
  });

  it("returns whole pages inside the range and keeps their numbers", () => {
    const offs = clPageOffsets(pages);
    expect(clSlicePages(offs, 6, 16)).toEqual([
      { page: 2, refPage: null, text: "bbbb" }, { page: 3, refPage: null, text: "cccc" },
    ]);
  });

  it("cuts a page where a boundary falls inside it", () => {
    const offs = clPageOffsets(pages);
    expect(clSlicePages(offs, 2, 8)).toEqual([
      { page: 1, refPage: null, text: "aa" }, { page: 2, refPage: null, text: "bb" },
    ]);
  });

  it("drops pages that contribute only whitespace", () => {
    const offs = clPageOffsets([{ page: 1, text: "aa" }, { page: 2, text: "   " }]);
    expect(clSlicePages(offs, 0, 99)).toEqual([{ page: 1, refPage: null, text: "aa" }]);
  });

  it("carries the judgment's own page number, read before any cut", () => {
    /* The footer is at the end of the page; a boundary cutting the page in
       half must not lose the number for the first half. */
    const paged = [{ page: 40, text: "argument here\n\nPage 1 of 12" }];
    const offs = clPageOffsets(paged);
    expect(offs[0].refPage).toBe(1);
    expect(clSlicePages(offs, 0, 5)).toEqual([{ page: 40, refPage: 1, text: "argum" }]);
  });
});

describe("clSplitPages", () => {
  it("returns one segment for an ordinary single judgment", () => {
    const pages = [{ page: 1, text: "IN THE GRAND COURT OF THE CAYMAN ISLANDS\n" + body(40) }];
    const segs = clSplitPages(pages);
    expect(segs).toHaveLength(1);
    expect(segs[0].pages).toEqual(pages.map((p) => ({ ...p, refPage: null })));
  });

  it("splits a bundle into one segment per judgment, preserving page numbers", () => {
    const pages = [
      { page: 1, text: judgment("IN THE GRAND COURT OF THE CAYMAN ISLANDS", "Re Sphinx") },
      { page: 2, text: judgment("IN THE COURT OF APPEAL OF BERMUDA", "AHAB v Saad") },
    ];
    const segs = clSplitPages(pages);
    expect(segs).toHaveLength(2);
    expect(segs[0].pages[0].page).toBe(1);
    expect(segs[1].pages[0].page).toBe(2);
    expect(segs[0].excerpt).toContain("GRAND COURT");
    expect(segs[1].excerpt).toContain("COURT OF APPEAL");
  });

  it("loses no text across the split", () => {
    const pages = [
      { page: 1, text: judgment("IN THE GRAND COURT OF THE CAYMAN ISLANDS", "Re Sphinx") },
      { page: 2, text: judgment("IN THE COURT OF APPEAL OF BERMUDA", "AHAB v Saad") },
    ];
    const whole = pages.map((p) => p.text).join("\n\n").replace(/\s+/g, "");
    const rejoined = clSplitPages(pages)
      .map((s) => s.pages.map((p) => p.text).join("")).join("").replace(/\s+/g, "");
    expect(rejoined).toBe(whole);
  });

  it("always returns at least one segment, even for empty input", () => {
    expect(clSplitPages([])).toHaveLength(1);
  });
});

/* ── v5.63: pagination as the primary signal ─────────────────────────────── */

const { clPageNumber, clIsFrontPage, clDetectPageBoundaries } = split;

/* A body page: dense argument with a footer. */
function bodyPage(n, total) {
  return body(12) + "\n\nPage " + n + (total ? " of " + total : "");
}
/* A cover: court, parties, citation, and very little else. */
function frontPage(court, title, citation) {
  return [court, "", title, "", citation, "", "B E T W E E N", "", "Mr A Smith for the Applicant"].join("\n");
}

describe("clPageNumber", () => {
  it("reads Page N of M from a footer", () => {
    expect(clPageNumber("argument\n\nPage 7 of 34")).toEqual({ num: 7, total: 34 });
  });

  it("reads a bare Page N", () => {
    expect(clPageNumber("argument\n\nPage 7")).toEqual({ num: 7, total: null });
  });

  it("reads a number alone on a line, dashed or bracketed", () => {
    expect(clPageNumber("argument\n\n- 12 -")).toEqual({ num: 12, total: null });
    expect(clPageNumber("argument\n\n[3]")).toEqual({ num: 3, total: null });
    expect(clPageNumber("9\n\nargument")).toEqual({ num: 9, total: null });
  });

  it("does not mistake a year at the page edge for a page number", () => {
    expect(clPageNumber("argument\n\n2003")).toBeNull();
  });

  it("returns nothing for a page with no numbering", () => {
    expect(clPageNumber(body(5))).toBeNull();
    expect(clPageNumber("")).toBeNull();
  });

  it("ignores a number buried in the middle of a long page", () => {
    const middle = body(30) + "\nPage 4 of 9\n" + body(30);
    expect(clPageNumber(middle)).toBeNull();
  });
});

describe("clIsFrontPage", () => {
  it("accepts a short cover carrying a court header", () => {
    expect(clIsFrontPage(frontPage("IN THE GRAND COURT OF THE CAYMAN ISLANDS", "Re Sphinx", "[2016] (2) CILR 1"))).toBe(true);
  });

  it("accepts a cover with no court line but a citation and BETWEEN", () => {
    expect(clIsFrontPage(["Re Sphinx Group of Funds", "", "[2016] (2) CILR 1", "", "B E T W E E N"].join("\n"))).toBe(true);
  });

  it("rejects a dense body page even when it quotes a court", () => {
    expect(clIsFrontPage(body(30) + "\nIN THE GRAND COURT OF THE CAYMAN ISLANDS\n" + body(30))).toBe(false);
  });

  it("rejects an empty page", () => {
    expect(clIsFrontPage("")).toBe(false);
  });
});

describe("clDetectPageBoundaries", () => {
  it("splits where the numbering restarts at 1", () => {
    const pages = [
      { page: 1, text: bodyPage(1) }, { page: 2, text: bodyPage(2) }, { page: 3, text: bodyPage(3) },
      { page: 4, text: bodyPage(1) }, { page: 5, text: bodyPage(2) },
    ];
    expect(clDetectPageBoundaries(pages)).toEqual([0, 3]);
  });

  it("splits where the 'of N' total changes, even mid-count", () => {
    const pages = [
      { page: 1, text: bodyPage(1, 3) }, { page: 2, text: bodyPage(2, 3) }, { page: 3, text: bodyPage(3, 3) },
      { page: 4, text: bodyPage(1, 12) }, { page: 5, text: bodyPage(2, 12) },
    ];
    expect(clDetectPageBoundaries(pages)).toEqual([0, 3]);
  });

  it("splits at the front page of the next case, numbered or not", () => {
    const pages = [
      { page: 1, text: bodyPage(1) }, { page: 2, text: bodyPage(2) },
      { page: 3, text: frontPage("IN THE COURT OF APPEAL OF BERMUDA", "AHAB v Saad", "[2021] UKPC 47") },
      { page: 4, text: bodyPage(1) },
    ];
    expect(clDetectPageBoundaries(pages)).toEqual([0, 2]);
  });

  it("leaves a single continuously paginated judgment alone", () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, text: bodyPage(i + 1, 8) }));
    expect(clDetectPageBoundaries(pages)).toEqual([0]);
  });

  it("says nothing when the pages carry no numbering", () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: body(12) }));
    expect(clDetectPageBoundaries(pages)).toEqual([0]);
  });

  it("does not split on a single page", () => {
    expect(clDetectPageBoundaries([{ page: 1, text: bodyPage(1) }])).toEqual([0]);
  });
});

describe("clSplitPages — which signal decided", () => {
  it("uses pagination when the numbering resets, and says so", () => {
    const pages = [
      { page: 1, text: bodyPage(1, 3) }, { page: 2, text: bodyPage(2, 3) },
      { page: 3, text: bodyPage(1, 5) }, { page: 4, text: bodyPage(2, 5) },
    ];
    const segs = clSplitPages(pages);
    expect(segs).toHaveLength(2);
    expect(segs[0].method).toBe("pagination");
    expect(segs[0].pages.map((p) => p.page)).toEqual([1, 2]);
    expect(segs[1].pages.map((p) => p.page)).toEqual([3, 4]);
  });

  it("falls back to the heading scan when there is no pagination to read", () => {
    const pages = [
      { page: 1, text: judgment("IN THE GRAND COURT OF THE CAYMAN ISLANDS", "Re Sphinx") },
      { page: 2, text: judgment("IN THE COURT OF APPEAL OF BERMUDA", "AHAB v Saad") },
    ];
    const segs = clSplitPages(pages);
    expect(segs).toHaveLength(2);
    expect(segs[0].method).toBe("headings");
  });

  it("keeps a single paginated judgment as one segment", () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: bodyPage(i + 1, 6) }));
    expect(clSplitPages(pages)).toHaveLength(1);
  });

  it("loses no text when pagination decides the split", () => {
    const pages = [
      { page: 1, text: bodyPage(1, 2) }, { page: 2, text: bodyPage(2, 2) },
      { page: 3, text: bodyPage(1, 2) }, { page: 4, text: bodyPage(2, 2) },
    ];
    const whole = pages.map((p) => p.text).join("\n\n").replace(/\s+/g, "");
    const rejoined = clSplitPages(pages)
      .map((s) => s.pages.map((p) => p.text).join("")).join("").replace(/\s+/g, "");
    expect(rejoined).toBe(whole);
  });
});
