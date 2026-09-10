/* ══ v5.62 Push D: SPLITTING A MULTI-CASE FILE ═══════════════════════════════
   A bundle of judgments arrives as one PDF. Stored whole it becomes one
   case_law_docs row with one name, and the draft prompt — which tells the
   model to cite each authority by the name in its heading — would then cite
   passages from the third judgment under the first judgment's name.

   These helpers find where one judgment ends and the next begins, and cut
   the extracted pages at those points. They are pure and hold no DOM, so
   api/__tests__/case_law_split.test.js can exercise them directly; the
   browser loads this file as a plain script before library.js.

   Detection is deliberately conservative. A judgment quoting another
   judgment is the normal case, not the exception, so a citation appearing
   mid-sentence is never a boundary. Only a line that is itself a court
   header, or a case title standing alone, counts — and then only when far
   enough past the previous boundary to be a new document rather than a
   running header. False negatives leave the file stored as one entry, which
   is today's behaviour; false positives would shred a judgment, so the
   thresholds lean towards missing a split. */

/* A boundary must be at least this far past the previous one. Running
   headers repeat every page; a real judgment does not restart in 2000
   characters. */
var CL_MIN_SEGMENT_CHARS = 2000;
/* Below this, treat the whole file as one document however it looks. */
var CL_MIN_FILE_CHARS = 4000;
var CL_MAX_SEGMENTS = 40;

/* Court headers. Each must be the substance of its own line — anchored at
   the start, and (where the court could be named mid-sentence) short enough
   that it is a heading rather than prose. */
var CL_COURT_PATTERNS = [
  /^in the .{0,80}?\b(court|tribunal)\b[\s.,:;]*$/i,
  /^in the (judicial committee of the )?privy council\b[\s.,:;]*$/i,
  /^(the )?judicial committee of the privy council[\s.,:;]*$/i,
  /^(in the )?(grand court|court of appeal|supreme court|high court|court of first instance)\b.{0,40}$/i,
  /^before\s*:?\s*.{0,60}\b(j|jj|cj|justice|chief justice)\b[\s.,:;]*$/i,
];

/* A neutral or law-report citation sitting alone on its line — the title
   block of a report, not a reference inside a sentence. */
/* Year, an optional volume number, the reporter, then the page:
   "[2003] 2 AC 709", "[2016] (2) CILR 1", "[2021] UKPC 47", "(1997) 3 All ER 1". */
var CL_CITATION_LINE = /^\[?\(?\d{4}\)?\]?\s+(\(?\d{1,3}\)?\s+)?[A-Za-z(][A-Za-z0-9()\s.]{0,24}?\s+\d+\s*$/;

/* "BETWEEN:" — often letter-spaced in a scanned report. */
var CL_BETWEEN_LINE = /^b\s?e\s?t\s?w\s?e\s?e\s?n\s*:?\s*$/i;

/* "IN THE MATTER OF the Companies Act ... presented to the court" is part of
   a judgment's own header block, and reads as a court line to the patterns
   below. Splitting there would cut a single judgment in half at its title,
   so these openings are excluded before anything else is tried. */
var CL_NOT_A_COURT_LINE = /^in the (matter|matters|estate|will|marriage|application|petition)\b/i;

function clIsCourtHeaderLine(line) {
  var t = String(line || "").trim();
  if (!t || t.length > 120) return false;
  if (CL_NOT_A_COURT_LINE.test(t)) return false;
  for (var i = 0; i < CL_COURT_PATTERNS.length; i++) {
    if (CL_COURT_PATTERNS[i].test(t)) return true;
  }
  return false;
}

function clIsTitleLine(line) {
  var t = String(line || "").trim();
  if (!t || t.length > 120) return false;
  if (CL_BETWEEN_LINE.test(t)) return true;
  return CL_CITATION_LINE.test(t);
}

/* Returns the character offsets at which a new judgment appears to start.
   The first offset is always 0. Fewer than two offsets means "one document". */
function clDetectCaseBoundaries(text) {
  var full = String(text || "");
  if (full.length < CL_MIN_FILE_CHARS) return [0];

  var bounds = [0];
  var pos = 0;
  var lines = full.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lineStart = pos;
    pos += line.length + 1;
    if (lineStart === 0) continue;
    if (lineStart - bounds[bounds.length - 1] < CL_MIN_SEGMENT_CHARS) continue;

    var strong = clIsCourtHeaderLine(line);
    /* A title line on its own is weaker evidence: accept it only when
       another title-ish line follows within the next few lines, which is
       what the head of a law report looks like. */
    var weak = !strong && clIsTitleLine(line) &&
      (clIsTitleLine(lines[i + 1]) || clIsTitleLine(lines[i + 2]) || clIsCourtHeaderLine(lines[i + 1]));

    if (strong || weak) {
      bounds.push(lineStart);
      if (bounds.length >= CL_MAX_SEGMENTS) break;
    }
  }
  return bounds;
}

/* Where each page sits in the joined text. extractPdfText / extractDocxText
   return [{page,text}] and callers join with "\n\n", so every page after the
   first starts two characters later than its own text length suggests. */
function clPageOffsets(pages) {
  var offs = [];
  var pos = 0;
  for (var i = 0; i < (pages || []).length; i++) {
    var t = (pages[i] && pages[i].text) || "";
    offs.push({ page: pages[i].page, start: pos, end: pos + t.length, text: t });
    pos += t.length + 2;
  }
  return offs;
}

/* The pages, or parts of pages, covering [start, end). Page numbers are
   preserved so a segment spanning pages 40-58 still reports those pages. */
function clSlicePages(offsets, start, end) {
  var out = [];
  for (var i = 0; i < offsets.length; i++) {
    var o = offsets[i];
    if (o.end <= start || o.start >= end) continue;
    var from = Math.max(0, start - o.start);
    var to = Math.min(o.text.length, end - o.start);
    var t = o.text.slice(from, to);
    if (t.trim()) out.push({ page: o.page, text: t });
  }
  return out;
}

/* Split extracted pages into one page-array per detected judgment. Always
   returns at least one segment. */
function clSplitPages(pages) {
  var text = (pages || []).map(function (p) { return p.text || ""; }).join("\n\n");
  var bounds = clDetectCaseBoundaries(text);
  var offsets = clPageOffsets(pages);
  var segs = [];
  for (var i = 0; i < bounds.length; i++) {
    var start = bounds[i];
    var end = (i + 1 < bounds.length) ? bounds[i + 1] : text.length;
    var segPages = clSlicePages(offsets, start, end);
    if (segPages.length === 0) continue;
    segs.push({
      index: segs.length,
      pages: segPages,
      charCount: end - start,
      excerpt: text.slice(start, Math.min(end, start + 2500)),
    });
  }
  return segs.length ? segs : [{ index: 0, pages: pages || [], charCount: text.length, excerpt: text.slice(0, 2500) }];
}

/* Node (the test) takes the functions through module.exports; the browser
   just gets them as globals from the script tag. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    clDetectCaseBoundaries, clPageOffsets, clSlicePages, clSplitPages,
    clIsCourtHeaderLine, clIsTitleLine,
    CL_MIN_SEGMENT_CHARS, CL_MIN_FILE_CHARS, CL_MAX_SEGMENTS,
  };
}
