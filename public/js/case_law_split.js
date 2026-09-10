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


/* ── v5.63: PAGINATION AS THE PRIMARY SIGNAL ────────────────────────────────
   Scanning prose for court headers works, but the plainer signal is how the
   judgments are paginated. Each judgment in a bundle carries its own internal
   numbering — "Page 1 of 34" in a footer, or a bare number — and starts again
   at 1 for the next one. A reset is close to proof of a new document, in a way
   that no line of text is: a judgment can quote another judgment's heading,
   but it cannot restart its own page numbering half way through.

   Two page-level signals, both read from the extracted pages rather than the
   joined text:

     reset      — the internal page number goes back to 1, or the "of N" total
                  changes. "Page 1 of 34" following "Page 34 of 34" is the
                  clearest case there is.
     front page — a short page carrying a court header or a standalone
                  citation. A judgment's first page is mostly white space:
                  court, parties, citation, counsel. A body page is dense.

   When pagination yields two or more segments it is used alone, because it is
   the better evidence. Where there is none to read — a DOCX arrives as a
   single page, and some PDFs extract without footers — the line scan above
   still runs. */

/* Roughly the length below which a page is a cover rather than argument. */
var CL_FRONT_PAGE_MAX_CHARS = 900;
/* Where in a page a footer or header number is looked for. */
var CL_EDGE_CHARS = 260;

var CL_PAGE_OF_TOTAL = /\bpage\s+(\d{1,4})\s+of\s+(\d{1,4})\b/i;
var CL_PAGE_N = /\bpage\s+(\d{1,4})\b/i;
/* A number alone on its line, optionally in dashes or brackets: 7, - 7 -, [7] */
var CL_BARE_NUMBER_LINE = /^[\s\-–—[(]*(\d{1,4})[\s\-–—\])]*$/;

/* The internal page number a page shows, read from its top and bottom edges.
   Returns {num, total} — total is null when the page says only "Page 7". */
function clPageNumber(pageText) {
  var t = String(pageText || "");
  if (!t.trim()) return null;
  var head = t.slice(0, CL_EDGE_CHARS);
  var foot = t.slice(Math.max(0, t.length - CL_EDGE_CHARS));
  var edges = [foot, head]; /* footers are the commoner place, so look there first */

  for (var i = 0; i < edges.length; i++) {
    var m = edges[i].match(CL_PAGE_OF_TOTAL);
    if (m) return { num: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  }
  for (var j = 0; j < edges.length; j++) {
    var m2 = edges[j].match(CL_PAGE_N);
    if (m2) return { num: parseInt(m2[1], 10), total: null };
  }
  /* A bare number on its own line at either edge. */
  for (var k = 0; k < edges.length; k++) {
    var lines = edges[k].split("\n");
    for (var l = 0; l < lines.length; l++) {
      var line = lines[l].trim();
      if (!line) continue;
      var m3 = line.match(CL_BARE_NUMBER_LINE);
      if (m3) {
        var n = parseInt(m3[1], 10);
        /* A four-digit number at a page edge is a year, not a page. */
        if (n >= 1 && n <= 999) return { num: n, total: null };
      }
    }
  }
  return null;
}

/* Does this page read as the front page of a judgment? */
function clIsFrontPage(pageText) {
  var t = String(pageText || "");
  if (!t.trim() || t.length > CL_FRONT_PAGE_MAX_CHARS) return false;
  var lines = t.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (clIsCourtHeaderLine(lines[i])) return true;
  }
  /* A cover with no court line but a citation and a BETWEEN still counts. */
  var titles = 0;
  for (var j = 0; j < lines.length; j++) {
    if (clIsTitleLine(lines[j])) titles++;
  }
  return titles >= 2;
}

/* Indexes into `pages` at which a new judgment appears to start. Always
   includes 0. Fewer than two means pagination told us nothing. */
function clDetectPageBoundaries(pages) {
  var list = pages || [];
  if (list.length < 2) return [0];

  var bounds = [0];
  var prev = null;
  var prevTotal = null;
  var ascending = 0;

  for (var i = 0; i < list.length; i++) {
    var text = list[i].text || "";
    var info = clPageNumber(text);
    var isBoundary = false;

    if (info) {
      if (prevTotal !== null && info.total !== null && info.total !== prevTotal) {
        /* "of N" changed — a different document, whatever the numbers do. */
        isBoundary = true;
      } else if (prev !== null && info.num === 1 && prev !== 1) {
        /* Numbering restarted. */
        isBoundary = true;
      } else if (prev !== null && info.num <= prev && ascending >= 2) {
        /* Went backwards after a run of ascending pages. */
        isBoundary = true;
      }
      ascending = (prev !== null && info.num === prev + 1) ? ascending + 1 : 0;
      prev = info.num;
      if (info.total !== null) prevTotal = info.total;
    }

    /* A front page is a boundary in its own right — it also covers the cover
       sheet that carries no number at all. */
    var fromFrontPage = false;
    if (!isBoundary && i > 0 && clIsFrontPage(text)) {
      isBoundary = true;
      fromFrontPage = true;
    }

    if (isBoundary && i > 0 && bounds[bounds.length - 1] !== i) {
      bounds.push(i);
      /* A cover page usually carries no number and the body behind it starts
         again at 1. Forget the previous document's count here, or that 1
         reads as a second boundary one page later and the case is split from
         its own front page. */
      if (fromFrontPage) { prev = null; prevTotal = null; ascending = 0; }
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
   returns at least one segment.

   v5.63: pagination first. When the pages carry their own numbering, a reset
   is far better evidence than any line of text, so if that yields two or more
   segments it decides alone. Only when it yields nothing — a DOCX, which
   arrives as one page, or a PDF whose footers did not extract — does the
   line scan run. `method` records which one spoke, so a caller can say so. */
function clSplitPages(pages) {
  var text = (pages || []).map(function (p) { return p.text || ""; }).join("\n\n");
  var offsets = clPageOffsets(pages);
  var method = "pagination";
  var bounds = null;

  var pageBounds = clDetectPageBoundaries(pages);
  if (pageBounds.length >= 2) {
    /* Page index -> character offset. */
    bounds = pageBounds.map(function (pi) { return offsets[pi] ? offsets[pi].start : 0; });
  } else {
    method = "headings";
    bounds = clDetectCaseBoundaries(text);
  }

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
      method: method,
      excerpt: text.slice(start, Math.min(end, start + 2500)),
    });
  }
  return segs.length ? segs : [{ index: 0, pages: pages || [], charCount: text.length, method: method, excerpt: text.slice(0, 2500) }];
}

/* Node (the test) takes the functions through module.exports; the browser
   just gets them as globals from the script tag. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    clDetectCaseBoundaries, clPageOffsets, clSlicePages, clSplitPages,
    clIsCourtHeaderLine, clIsTitleLine,
    clPageNumber, clIsFrontPage, clDetectPageBoundaries,
    CL_MIN_SEGMENT_CHARS, CL_MIN_FILE_CHARS, CL_MAX_SEGMENTS,
    CL_FRONT_PAGE_MAX_CHARS,
  };
}
