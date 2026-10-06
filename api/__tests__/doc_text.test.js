/* v5.80 Push 1 — footnotes and paragraph numbers on upload.

   public/js/doc_text.js is a plain browser script; it also exports through
   module.exports when Node loads it, which is how this reaches the same
   source the app runs. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dt = require("../../public/js/doc_text.js");
const { dtDocxToPages, dtPdfPageText } = dt;

/* ── Word ────────────────────────────────────────────────────────────── */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function doc(body) { return '<?xml version="1.0"?><w:document ' + W + "><w:body>" + body + "</w:body></w:document>"; }
function para(text, opts) {
  opts = opts || {};
  let ppr = "";
  if (opts.style || opts.numId !== undefined) {
    ppr = "<w:pPr>" + (opts.style ? '<w:pStyle w:val="' + opts.style + '"/>' : "") +
      (opts.numId !== undefined ? '<w:numPr><w:ilvl w:val="' + (opts.ilvl || 0) + '"/><w:numId w:val="' + opts.numId + '"/></w:numPr>' : "") +
      "</w:pPr>";
  }
  const runs = text.split(/(\{fn:\d+\})/).map(function (bit) {
    const m = /^\{fn:(\d+)\}$/.exec(bit);
    if (m) return '<w:r><w:footnoteReference w:id="' + m[1] + '"/></w:r>';
    return bit ? '<w:r><w:t xml:space="preserve">' + bit + "</w:t></w:r>" : "";
  }).join("");
  return "<w:p>" + ppr + runs + "</w:p>";
}
const NUMBERING = '<w:numbering ' + W + '>' +
  '<w:abstractNum w:abstractNumId="10">' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>' +
  '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%2)"/></w:lvl>' +
  '<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="(%3)"/></w:lvl>' +
  "</w:abstractNum>" +
  '<w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="10"/></w:num>' +
  '<w:num w:numId="3"><w:abstractNumId w:val="10"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>' +
  '<w:num w:numId="4"><w:abstractNumId w:val="20"/></w:num>' +
  "</w:numbering>";
const STYLES = '<w:styles ' + W + '>' +
  '<w:style w:type="paragraph" w:styleId="Para"><w:name w:val="Para"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ParaSub"><w:basedOn w:val="Para"/><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr></w:style>' +
  "</w:styles>";
function notes(map) {
  return '<w:footnotes ' + W + '>' +
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
    '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
    Object.keys(map).map(function (id) {
      return '<w:footnote w:id="' + id + '"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ' + map[id] + "</w:t></w:r></w:p></w:footnote>";
    }).join("") + "</w:footnotes>";
}
function read(body, extra) {
  return dtDocxToPages(Object.assign({ document: doc(body), numbering: NUMBERING, styles: STYLES }, extra || {}))[0].text;
}

describe("Word: paragraph numbers", () => {
  it("numbers run on through headings, as Word shows them", () => {
    const t = read(para("A. INTRODUCTION") + para("First.", { numId: 1 }) + para("Second.", { numId: 1 }) +
      para("B. THE LAW") + para("Third.", { numId: 1 }));
    expect(t).toBe("A. INTRODUCTION\n\n1. First.\n\n2. Second.\n\nB. THE LAW\n\n3. Third.");
  });

  it("sub-paragraphs letter within their parent and restart under the next", () => {
    const t = read(para("Lead.", { numId: 1 }) + para("one", { numId: 1, ilvl: 1 }) + para("two", { numId: 1, ilvl: 1 }) +
      para("deeper", { numId: 1, ilvl: 2 }) + para("Next.", { numId: 1 }) + para("again", { numId: 1, ilvl: 1 }));
    expect(t).toBe("1. Lead.\n\n(a) one\n\n(b) two\n\n(i) deeper\n\n2. Next.\n\n(a) again");
  });

  it("a second num on the same list carries on counting; a start override restarts it", () => {
    const t = read(para("a", { numId: 1 }) + para("b", { numId: 2 }) + para("c", { numId: 3 }) + para("d", { numId: 3 }));
    expect(t).toBe("1. a\n\n2. b\n\n1. c\n\n2. d");
  });

  it("numbering carried by a paragraph style, through basedOn", () => {
    const t = read(para("Styled.", { style: "Para" }) + para("Sub.", { style: "ParaSub" }) + para("Styled again.", { style: "Para" }));
    expect(t).toBe("1. Styled.\n\n(a) Sub.\n\n2. Styled again.");
  });

  it("numId 0 switches numbering off, and bullets carry no label", () => {
    const t = read(para("Off.", { style: "Para", numId: 0 }) + para("Point.", { numId: 4 }));
    expect(t).toBe("Off.\n\nPoint.");
  });

  it("ignores the old numbering recorded in a tracked formatting change", () => {
    const body = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' +
      '<w:pPrChange w:id="9"><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="4"/></w:numPr></w:pPr></w:pPrChange></w:pPr>' +
      '<w:r><w:t>Changed.</w:t></w:r></w:p>';
    expect(read(body)).toBe("1. Changed.");
  });
});

describe("Word: footnotes", () => {
  it("marks the reference and puts the note under its paragraph", () => {
    const t = read(para("It is submitted{fn:1} that.", { numId: 1 }) + para("Next.", { numId: 1 }),
      { footnotes: notes({ 1: "Swain v Hillman [2001] 1 All ER 91" }) });
    expect(t).toBe("1. It is submitted[fn 1] that.\n[Footnote 1] Swain v Hillman [2001] 1 All ER 91\n\n2. Next.");
  });

  it("numbers notes in order of reference, as Word displays them, not by stored id", () => {
    const t = read(para("A{fn:7} B{fn:3}"), { footnotes: notes({ 3: "Second note", 7: "First note" }) });
    expect(t).toBe("A[fn 1] B[fn 2]\n[Footnote 1] First note\n[Footnote 2] Second note");
  });

  it("says so when a note's text cannot be found, rather than dropping the marker", () => {
    const t = read(para("A{fn:4}"), { footnotes: notes({}) });
    expect(t).toContain("[fn 1]");
    expect(t).toContain("[Footnote 1] (text of this footnote could not be read)");
  });

  it("reads tracked text where it stands now: not deleted text, not a move's old place", () => {
    const body = '<w:p><w:r><w:t>Kept </w:t></w:r><w:del><w:r><w:delText>gone </w:delText></w:r></w:del>' +
      '<w:moveFrom><w:r><w:t>moved </w:t></w:r></w:moveFrom><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>' +
      '<w:p><w:moveTo><w:r><w:t>moved</w:t></w:r></w:moveTo></w:p>';
    expect(read(body)).toBe("Kept added\n\nmoved");
  });

  it("decodes entities and keeps tabs and nested text-box paragraphs", () => {
    const body = '<w:p><w:r><w:t>Smith &amp; Co v Jones</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>[1970]</w:t></w:r>' +
      '<w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Inside box</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>';
    const t = read(body);
    expect(t).toContain("Inside box");
    expect(t).toContain("Smith & Co v Jones\t[1970]");
  });
});

/* ── PDF ─────────────────────────────────────────────────────────────── */

/* A pdf.js text item: string at (x, y) in size pt. y counts up from the foot. */
function item(str, x, y, size, width) {
  return { str: str, transform: [size, 0, 0, size, x, y], width: width === undefined ? str.length * size * 0.5 : width, height: size };
}
/* A body line of words at 12pt, with an optional raised marker after it. */
function bodyLine(text, y, marker) {
  const out = [item(text, 72, y, 12)];
  if (marker) out.push(item(String(marker), 72 + text.length * 6, y + 4, 7, 4));
  return out;
}

describe("PDF: footnotes by position and size", () => {
  it("marks raised small numbers in the body and labels small notes at the foot", () => {
    const items = [].concat(
      bodyLine("1. The test is well established.", 700, 1),
      bodyLine("2. The court must not conduct a mini-trial.", 680, 2),
      bodyLine("3. Nothing more.", 660),
      [item("1", 72, 104, 6, 3), item("Swain v Hillman [2001] 1 All ER 91", 78, 100, 10)],
      [item("2", 72, 92, 6, 3), item("Three Rivers DC v Bank of England (No 3) [2003] 2 AC 1", 78, 88, 10)],
      [item("Page 3 of 9", 280, 40, 10)]
    );
    expect(dtPdfPageText(items)).toBe(
      "1. The test is well established.[fn 1]\n" +
      "2. The court must not conduct a mini-trial.[fn 2]\n" +
      "3. Nothing more.\n" +
      "[Footnotes on this page]\n" +
      "[Footnote 1] Swain v Hillman [2001] 1 All ER 91\n" +
      "[Footnote 2] Three Rivers DC v Bank of England (No 3) [2003] 2 AC 1\n" +
      "Page 3 of 9");
  });

  it("finds notes set in the body's own size by the marker that leads them", () => {
    const items = [].concat(
      bodyLine("4. A proposition.", 700, 5),
      bodyLine("5. Another.", 680),
      [item("5", 72, 124, 7, 4), item("Re Last Case [1999] 2 BCLC 1", 78, 120, 12)],
      [item("12", 300, 40, 12)]
    );
    expect(dtPdfPageText(items)).toBe(
      "4. A proposition.[fn 5]\n5. Another.\n[Footnotes on this page]\n[Footnote 5] Re Last Case [1999] 2 BCLC 1\n12");
  });

  it("carries a note's continuation line with it", () => {
    const items = [].concat(
      bodyLine("6. Text.", 700, 8),
      [item("8", 72, 104, 6, 3), item("Long note that runs on", 78, 100, 10)],
      [item("to a second line.", 72, 88, 10)]
    );
    expect(dtPdfPageText(items)).toBe(
      "6. Text.[fn 8]\n[Footnotes on this page]\n[Footnote 8] Long note that runs on\nto a second line.");
  });

  it("leaves small trailing text unlabelled when nothing on the page is a footnote", () => {
    const items = [].concat(bodyLine("7. Plain page.", 700), [item("Skeleton argument of the Plaintiff", 72, 40, 9)]);
    expect(dtPdfPageText(items)).toBe("7. Plain page.\nSkeleton argument of the Plaintiff");
  });

  it("does not treat a paragraph number or a figure in the body as a marker", () => {
    const items = [].concat(bodyLine("8. The sum of", 700), [item("12", 160, 700, 12, 12)], bodyLine("9. Next.", 680));
    expect(dtPdfPageText(items)).toBe("8. The sum of 12\n9. Next.");
  });

  it("drops nothing: every character of the plain reading survives", () => {
    const items = [].concat(bodyLine("10. Body.", 700, 3), [item("3", 72, 104, 6, 3), item("Note text", 78, 100, 10)], [item("Footer", 72, 40, 9)]);
    const plain = items.map(i => i.str).join("").replace(/\s/g, "");
    /* Labels go; the number inside a label was in the plain reading too. */
    const laid = dtPdfPageText(items).replace(/\[(?:fn|Footnote) (\d+)\]/g, "$1").replace(/\[Footnotes on this page\]/g, "").replace(/\s/g, "");
    expect(laid.split("").sort().join("")).toBe(plain.split("").sort().join(""));
  });

  /* Patterns found on two real skeletons, 6 Oct 2026. */
  it("reads past the empty fragment that opens a real note line", () => {
    const items = [].concat(
      bodyLine("1. Text.", 700, 2),
      [item("", 72, 104, 6.5, 0), item("2", 72, 104, 6.5, 3), item(" ", 75, 104, 6.5, 3), item("See generally the Petition", 108, 100, 10)]
    );
    expect(dtPdfPageText(items, 11.5)).toContain("[Footnote 2] See generally the Petition");
  });

  it("treats a body-size running footer below the notes as a footer", () => {
    const items = [].concat(
      bodyLine("15. Text.", 700, 4),
      [item("4", 94, 127, 6.1, 3), item("CNBM, for its part", 100, 124, 9.4)],
      [item("FSD0161/2018", 40, 30, 12), item("2026-10-05", 510, 30, 12)]
    );
    expect(dtPdfPageText(items, 10.5)).toBe(
      "15. Text.[fn 4]\n[Footnotes on this page]\n[Footnote 4] CNBM, for its part\nFSD0161/2018 2026-10-05");
  });

  it("does not open a new note at a continuation line that starts with a number", () => {
    const items = [].concat(
      bodyLine("9. Text.", 700, 9),
      [item("9", 72, 124, 6, 3), item("Announcements on 28", 80, 120, 9.4)],
      [item("May 2020 and 791 (Comm)", 72, 108, 9.4)],
      [item("791 (Comm) [ref].", 72, 96, 9.4)]
    );
    const t = dtPdfPageText(items, 10.5);
    expect(t).toContain("[Footnote 9] Announcements on 28");
    expect(t).not.toContain("[Footnote 791]");
  });

  it("uses the document's body size, so a page full of footnote quotation keeps its notes", () => {
    const quote = [];
    for (let k = 0; k < 8; k++) quote.push(item("quoted text inside footnote one hundred and eighty-three", 107, 300 - k * 12, 10));
    const items = [].concat(
      bodyLine("50. Short body.", 700, 183),
      [item("183", 72, 314, 6.5, 9.7), item("The announcement read:", 107, 310, 10)],
      quote
    );
    expect(dtPdfPageText(items, 11.5)).toContain("[Footnote 183] The announcement read:");
    expect(dt.dtBodySize([items, [item("x".repeat(500), 72, 700, 11.5)]])).toBe(11.5);
  });

  it("returns an empty string for a page with no text", () => {
    expect(dtPdfPageText([])).toBe("");
  });
});

describe("the safety check", () => {
  const { dtTextWeight } = dt;
  it("weighs a layout reading equal to the plain reading it came from", () => {
    const items = [].concat(bodyLine("1. Body text.", 700, 4), [item("4", 72, 104, 6, 3), item("A note", 78, 100, 10)]);
    const plain = items.map(i => i.str).join(" ");
    expect(dtTextWeight(dtPdfPageText(items))).toBe(dtTextWeight(plain));
  });
  it("keeps the number inside a label and drops the label", () => {
    expect(dtTextWeight("a[fn 12] [Footnote 12] b\n[Footnotes on this page]")).toBe("a1212b".length);
  });
});

/* ── Wiring ──────────────────────────────────────────────────────────── */

describe("wiring", () => {
  const core = fs.readFileSync(new URL("../../public/js/core.js", import.meta.url), "utf8");
  const drafting = fs.readFileSync(new URL("../../public/js/drafting.js", import.meta.url), "utf8");
  const library = fs.readFileSync(new URL("../../public/js/library.js", import.meta.url), "utf8");

  it("matter uploads ask for the layout reading", () => {
    expect(core).toMatch(/extractDocxText\(file,\{layout:true\}\):await extractPdfText\(file,\{layout:true\}\)/);
    expect(drafting).toMatch(/extractDocxText\(file,\{layout:true\}\):await extractPdfText\(file,\{layout:true\}\)/);
  });

  it("library uploads do not — the case law splitter reads their page footers", () => {
    expect(library).not.toMatch(/layout:true/);
  });

  it("both index.html copies are identical and load doc_text.js before core.js", () => {
    const a = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const b = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    expect(a).toBe(b);
    expect(b.indexOf('src="/js/doc_text.js')).toBeGreaterThan(-1);
    expect(b.indexOf('src="/js/doc_text.js')).toBeLessThan(b.indexOf('src="/js/core.js'));
  });
});
