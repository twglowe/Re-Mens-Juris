/* ══ v5.84–v5.85 Bundle Links Push 1: PURE HELPERS ══════════════════════════════════
   Bundle Links adds a link to every bundle reference in a skeleton PDF,
   pointing at the right page of the right bundle PDF in the same case
   folder. Nothing is uploaded; everything runs in the browser.

   These helpers hold no DOM and no pdf.js, so
   api/__tests__/bundle_links_helpers.test.js can exercise them directly; the
   browser loads this file as a plain script before core.js. The tab itself
   (Push 2 onwards) lives in bundle_links.js.

   The hard part is the page number. A bundle page often carries two or more
   numbers: the document's own page number, an exhibit page number, an
   earlier bundle's reference, and the bundle stamp. Tom shows the tool the
   bundle stamp once, on a sample page; these helpers then read the number in
   that position and of that form on every page, and check that the numbers
   run in sequence. A wrong guess here sends a link to the wrong page, which
   is worse than no link, so anything doubtful is flagged for Tom rather than
   resolved silently.

   Pagination is either continuous through the bundle (B/2/45 is the only
   page 45 in bundle B) or restarts at each tab (Tom, 25 Nov 2026: it
   depends on whether the whole bundle was paginated). Both are handled. */

/* Bundle labels Tom uses: A, B, B1, C2, Core, CB, HB1, EB1, and for
   authorities AB, DAB, PAB, AAB. A label starts with a letter, is at most
   eight characters, and may end in a volume number. */
var BL_LABEL_SRC = "(?:Core|[A-Z]{1,4})\\d{0,2}";

/* A label is an authorities bundle when it ends in AB (AB, DAB, PAB, AAB,
   AB1 …). In an authorities bundle a two-part reference [AB/3] is a tab;
   in any other bundle a two-part reference [B/45] is a page. */
function blIsAuthoritiesLabel(label) {
  return /AB\d{0,2}$/i.test(String(label || "").trim());
}

/* Normalise a label so "core", "Core" and "CORE" match, and "B 1" reads as
   "B1". */
function blNormLabel(label) {
  var s = String(label || "").replace(/\s+/g, "").toUpperCase();
  return s;
}

/* Guess a bundle's label from its filename. Returns "" when there is no
   confident guess; Tom confirms or types the label in any case.
     "Bundle B.pdf"            → "B"
     "Bundle B1 - Pleadings"   → "B1"
     "Core Bundle.pdf"         → "CORE"
     "HB1.pdf", "EB1 Exhibits" → "HB1", "EB1"
     "Authorities Bundle"      → "AB"
     "DAB Vol 2.pdf"           → "DAB2" */
function blGuessLabel(filename) {
  var base = String(filename || "").replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "").trim();
  if (!base) return "";
  var vol = base.match(/\bVol(?:ume)?\.?\s*(\d{1,2})\b/i);
  var volNum = vol ? vol[1] : "";
  if (/\bcore\b/i.test(base)) return "CORE" + volNum;
  if (/\bauthorities\b/i.test(base) && !/\b[A-Z]{1,3}AB\d{0,2}\b/.test(base)) return "AB" + volNum;
  var m = base.match(/\b[Bb]undle\s+([A-Z]{1,4}\d{0,2})\b/);
  if (m) return blNormLabel(m[1]) + (volNum && !/\d$/.test(m[1]) ? volNum : "");
  m = base.match(/^([A-Z]{1,4}\d{0,2})(?:\b|_|-)/);
  if (m) return m[1] + (volNum && !/\d$/.test(m[1]) ? volNum : "");
  return "";
}

/* ── Reading bundle references in the skeleton ───────────────────────────
   Finds every bundle reference in a run of text, in any of these forms:
     [B/2/45]  [B2/45]  [B/45]  {B/2/45}  B/2/45
     [B/2/45-47]  [B/2/45–B/2/47]           (ranges: linked to the first page)
     [B/2/45; C/3/12]  [B/2/45, 47]         (lists: each its own link)
     [AB/3]  [AB/3/12]  [DAB/14]            (authorities: two parts = tab)
   A three-part reference is label/tab/page. A two-part reference is
   label/page, except in an authorities bundle, where it is label/tab.

   Returns [{raw, start, end, label, tab, page, pageEnd}], where start/end
   are character offsets of the reference within `text` (so the link box can
   be drawn over exactly that text), and tab/page/pageEnd are integers or
   null. Dates (12/3/2020) never match because a label must start with a
   letter; a reference must be bracketed unless it has three parts, so
   "and/or" or "s/he" cannot match. */
function blParseRefs(text) {
  var s = String(text || "");
  var out = [];
  var part = BL_LABEL_SRC + "\\s?\\/\\s?\\d{1,4}(?:\\s?\\/\\s?\\d{1,5})?";
  /* One reference, optionally followed by a range end: -47, –B/2/47, -2/47. */
  var one = "(" + part + ")(?:\\s?[-–—]\\s?((?:" + BL_LABEL_SRC + "\\s?\\/\\s?)?(?:\\d{1,4}\\s?\\/\\s?)?\\d{1,5}))?";
  var reOne = new RegExp(one, "g");

  /* Bracketed groups first: [ … ] and { … }. */
  var reGroup = /[\[\{]([^\[\]\{\}]{2,200})[\]\}]/g;
  var gm;
  var covered = [];
  while ((gm = reGroup.exec(s))) {
    var inner = gm[1];
    var innerStart = gm.index + 1;
    var prev = null;
    var items = inner.split(/(\s*[;,]\s*|\s+and\s+)/);
    var pos = 0;
    var any = false;
    for (var i = 0; i < items.length; i++) {
      var chunk = items[i];
      var chunkStart = innerStart + pos;
      pos += chunk.length;
      if (i % 2 === 1) continue; /* separator */
      var trimmed = chunk.replace(/^\s+/, "");
      var lead = chunk.length - trimmed.length;
      trimmed = trimmed.replace(/\s+$/, "");
      if (!trimmed) continue;
      reOne.lastIndex = 0;
      var m = reOne.exec(trimmed);
      if (m && m.index === 0) {
        var ref = blRefFromParts(m[1], m[2]);
        if (ref) {
          ref.start = chunkStart + lead;
          ref.end = chunkStart + lead + m[0].length;
          ref.raw = s.slice(ref.start, ref.end);
          out.push(ref);
          prev = ref;
          any = true;
          continue;
        }
      }
      /* A bare continuation in a list: [B/2/45, 47] or [B/2/45, 3/12]. */
      var cont = trimmed.match(/^(\d{1,4})(?:\s?\/\s?(\d{1,5}))?(?:\s?[-–—]\s?(\d{1,5}))?$/);
      if (prev && cont) {
        var c = { label: prev.label, tab: prev.tab, page: null, pageEnd: null };
        if (cont[2]) { c.tab = parseInt(cont[1], 10); c.page = parseInt(cont[2], 10); }
        else if (prev.page !== null) { c.page = parseInt(cont[1], 10); }
        else { c.tab = parseInt(cont[1], 10); }
        if (cont[3]) c.pageEnd = parseInt(cont[3], 10);
        c.start = chunkStart + lead;
        c.end = chunkStart + lead + trimmed.length;
        c.raw = s.slice(c.start, c.end);
        out.push(c);
        prev = c;
        any = true;
      }
    }
    if (any) covered.push([gm.index, gm.index + gm[0].length]);
  }

  /* Unbracketed three-part references: B/2/45 in running text. */
  var reBare = new RegExp("(?:^|[^A-Za-z0-9\\/])(" + BL_LABEL_SRC + "\\s?\\/\\s?\\d{1,4}\\s?\\/\\s?\\d{1,5})(?:\\s?[-–—]\\s?(\\d{1,5}))?(?![\\/\\d])", "g");
  var bm;
  while ((bm = reBare.exec(s))) {
    var bStart = bm.index + bm[0].indexOf(bm[1]);
    var inside = covered.some(function (r) { return bStart >= r[0] && bStart < r[1]; });
    if (inside) continue;
    var bref = blRefFromParts(bm[1], bm[2]);
    if (!bref) continue;
    var bEnd = bStart + bm[1].length + (bm[2] ? bm[0].length - bm[0].indexOf(bm[1]) - bm[1].length : 0);
    bref.start = bStart;
    bref.end = bEnd;
    bref.raw = s.slice(bStart, bEnd);
    out.push(bref);
  }

  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

/* Turn "B/2/45" (+ optional range end "47" or "B/2/47") into a reference. */
function blRefFromParts(main, rangeEnd) {
  var p = String(main).replace(/\s+/g, "").split("/");
  if (p.length < 2) return null;
  var label = blNormLabel(p[0]);
  var ref = { label: label, tab: null, page: null, pageEnd: null };
  if (p.length === 3) {
    ref.tab = parseInt(p[1], 10);
    ref.page = parseInt(p[2], 10);
  } else if (blIsAuthoritiesLabel(label)) {
    ref.tab = parseInt(p[1], 10);
  } else {
    ref.page = parseInt(p[1], 10);
  }
  if (rangeEnd) {
    var e = String(rangeEnd).replace(/\s+/g, "").split("/");
    var last = parseInt(e[e.length - 1], 10);
    if (ref.page !== null) ref.pageEnd = last;
    else ref.tabEnd = last;
  }
  return ref;
}

/* ── Reading the bundle stamp ────────────────────────────────────────────
   The form of a stamp is what Tom tapped: "45", "B45", "B/45", "B/2/45",
   "B-2-45", "B 2 45", "Page 45 of 300" excluded. blStampForm records which
   parts it has and its separator, so other numbers on the page in a
   different form (an exhibit "Exh JS-1/12", a document's own "Page 3") are
   not read as the bundle stamp. */
function blStampForm(str) {
  var t = String(str || "").trim();
  /* v5.84: an authorities bundle stamped "[46]" (Visionary v NBC, 26 Nov
     2026). The wrapper is part of the form, so a paragraph number "(7)" or
     a bare "7" on the same page is not read as that stamp. */
  var wrap = "";
  var w = t.match(/^([\[\(\{])\s*(.*?)\s*([\]\)\}])$/);
  if (w && "[(\{".indexOf(w[1]) === "])}".indexOf(w[3])) { wrap = w[1] + w[3]; t = w[2]; }
  var m, f = null;
  if ((m = t.match(/^([A-Z]{1,4}\d{0,2}|Core\d{0,2})\s*([\/\-\s])\s*(\d{1,4})\s*\2\s*(\d{1,5})$/i)))
    f = { parts: "LTP", sep: m[2] === " " ? " " : m[2], label: blNormLabel(m[1]) };
  else if ((m = t.match(/^([A-Z]{1,4}\d{0,2}|Core\d{0,2})\s*([\/\-\s])\s*(\d{1,5})$/i)))
    f = { parts: "LP", sep: m[2] === " " ? " " : m[2], label: blNormLabel(m[1]) };
  else if ((m = t.match(/^([A-Z]{1,4})(\d{1,5})$/)))
    f = { parts: "LP", sep: "", label: blNormLabel(m[1]) };
  else if (/^\d{1,5}$/.test(t)) f = { parts: "P", sep: "", label: "" };
  if (f) f.wrap = wrap;
  return f;
}

/* Read a stamp string against a recorded form. Returns {tab, page} or null
   if the string is not of that form (or carries a different label). */
function blReadStamp(str, form) {
  if (!form) return null;
  var f = blStampForm(str);
  if (!f || f.parts !== form.parts) return null;
  if ((f.wrap || "") !== (form.wrap || "")) return null;
  if (form.label && f.label !== form.label) return null;
  var nums = String(str).match(/\d+/g) || [];
  /* A label like B1 carries a digit of its own; take the numbers after it. */
  if (form.parts === "LTP") return { tab: parseInt(nums[nums.length - 2], 10), page: parseInt(nums[nums.length - 1], 10) };
  return { tab: null, page: parseInt(nums[nums.length - 1], 10) };
}

/* The text pieces on a page that could be a stamp, with their positions as
   fractions of the page (0..1, origin top-left) so a position tapped on one
   page can be found on another page of a different size. `items` are
   {str, x, y, w, h} in page units with y measured from the top. */
function blStampCandidates(items, pageW, pageH) {
  var out = [];
  (items || []).forEach(function (it, i) {
    var str = String(it.str || "").trim();
    if (!str || !blStampForm(str)) return;
    out.push({
      i: i, str: str,
      cx: (it.x + (it.w || 0) / 2) / (pageW || 1),
      cy: (it.y + (it.h || 0) / 2) / (pageH || 1),
    });
  });
  return out;
}

/* Find the stamp on a page from the calibration: the candidate of the right
   form nearest the tapped position, within the tolerance (a fraction of the
   page; 0.08 by default — stamps drift a little between pages but never
   change corner). Returns {tab, page, str, dist} or null. */
function blFindStamp(items, pageW, pageH, calib) {
  var tol = calib.tol || 0.08;
  var best = null;
  blStampCandidates(items, pageW, pageH).forEach(function (c) {
    var r = blReadStamp(c.str, calib.form);
    if (!r) return;
    var d = Math.sqrt(Math.pow(c.cx - calib.cx, 2) + Math.pow(c.cy - calib.cy, 2));
    if (d > tol) return;
    if (!best || d < best.dist) best = { tab: r.tab, page: r.page, str: c.str, dist: d };
  });
  return best;
}

/* ── Checking the sequence ───────────────────────────────────────────────
   `readings` is one entry per PDF page, in order: {tab, page} or null where
   no stamp was read. `opts.startPage` is the expected first number when the
   bundle continues from an earlier volume. `opts.tabStarts` (optional) maps
   PDF page index → tab number, from bookmarks or from Tom, for bundles
   whose stamps do not carry the tab.

   Returns one entry per page: {idx, tab, page, status} where status is
     read      stamp read and in sequence
     inferred  no stamp, but the pages either side make the number certain
     break     out of sequence, repeated, or a jump — Tom must confirm
     none      no stamp and the neighbours do not settle it — Tom must confirm
   and a summary {read, inferred, break, none, mode} where mode is
   "continuous" or "per-tab".

   A restart at 1 is a break in a continuously paginated bundle but the
   normal start of a tab in a per-tab bundle. The mode is taken from the
   readings: if the stamps carry a tab, or the numbers restart at 1 more
   than once, the bundle is treated as per-tab. */
function blCheckSequenceOnce(readings, opts) {
  opts = opts || {};
  var n = readings.length;
  var out = [];
  var tabStarts = opts.tabStarts || {};
  var hasTab = readings.some(function (r) { return r && r.tab !== null && r.tab !== undefined; });
  var ones = 0;
  readings.forEach(function (r) { if (r && r.page === 1) ones++; });
  /* Tab starts (from bookmarks) say where tabs begin, not how pages are
     numbered: every Visionary v NBC bundle has tab bookmarks and continuous
     numbering. Only restarts at 1 make a bundle per-tab. */
  var mode = opts.mode || (ones >= 2 ? "per-tab" : "continuous");
  var perTab = mode === "per-tab";

  /* Tab for each page: from the stamp when it carries one, else from
     tabStarts, else (per-tab bundles only) counted from the restarts at 1.
     Pages before the first restart belong to tab 1. */
  var curTab = null;
  for (var i = 0; i < n; i++) {
    var r = readings[i];
    if (r && r.tab !== null && r.tab !== undefined) curTab = r.tab;
    else if (tabStarts[i] !== undefined) curTab = tabStarts[i];
    else if (perTab && !hasTab && r && r.page === 1 && i > 0 && curTab !== null) curTab = curTab + 1;
    else if (perTab && !hasTab && curTab === null) curTab = 1;
    out.push({ idx: i, tab: (hasTab || perTab || curTab !== null) ? curTab : null, page: r ? r.page : null, status: r ? "read" : "none" });
  }

  /* Walk forward checking each stamp against the expected number. In a
     per-tab bundle the count restarts at each new tab; in a continuous
     bundle it runs on across tabs. */
  var expect = opts.startPage || null;
  var prevTab = null;
  for (var j = 0; j < n; j++) {
    var e = out[j];
    var newTab = perTab && j > 0 && e.tab !== prevTab;
    if (e.page === null) {
      if (expect !== null && !newTab) expect++;
      prevTab = e.tab;
      continue;
    }
    if (expect === null) {
      expect = e.page + 1;
    } else if (newTab) {
      if (e.page !== 1) e.status = "break";
      expect = e.page + 1;
    } else if (e.page !== expect) {
      e.status = "break";
      expect = e.page + 1;
    } else {
      expect++;
    }
    prevTab = e.tab;
  }

  /* Fill gaps: a run of unread pages between two in-sequence stamps in the
     same tab whose difference matches the run length exactly is inferred.
     Leading unread pages before the first stamp are inferred backwards only
     if the first stamp leaves room (page 3 at PDF index 2 → 1, 2). */
  var a = 0;
  while (a < n) {
    if (out[a].page !== null) { a++; continue; }
    var b = a;
    while (b < n && out[b].page === null) b++;
    var before = a > 0 ? out[a - 1] : null;
    var after = b < n ? out[b] : null;
    var len = b - a;
    var ok = false;
    if (before && after && before.tab === after.tab && after.status === "read" &&
        after.page - before.page === len + 1) {
      for (var g = a; g < b; g++) { out[g].page = before.page + (g - a) + 1; out[g].status = "inferred"; }
      ok = true;
    } else if (!before && after && after.status === "read" && after.page - len >= 1 && (!perTab || after.page - len === 1)) {
      for (var h = a; h < b; h++) { out[h].page = after.page - (b - h); out[h].status = "inferred"; }
      ok = true;
    } else if (before && !after && len <= 2) {
      /* A page or two at the very end with no stamp: often a blank back
         page. Not linked to unless Tom says so. */
      ok = false;
    }
    if (!ok) for (var q = a; q < b; q++) out[q].status = "none";
    a = b;
  }

  /* Duplicates in the same tab are breaks even if each looked in sequence
     locally (two pages both stamped 45). */
  var seen = {};
  out.forEach(function (e) {
    if (e.page === null) return;
    var key = (e.tab === null ? "" : e.tab) + "/" + e.page;
    if (seen[key] !== undefined) { e.status = "break"; out[seen[key]].status = "break"; }
    else seen[key] = e.idx;
  });

  var summary = { read: 0, inferred: 0, break: 0, none: 0, mode: mode };
  out.forEach(function (e) { summary[e.status]++; });
  return { pages: out, summary: summary };
}

/* v5.84: a stray number in the stamp's corner. Bundle B in Visionary v NBC
   has exhibit pages whose own page numbers ("2", "3") sit where the bundle
   stamp should be; read as stamps, each one breaks the sequence and the
   pages after it, and a stray "3" makes B/1/3 ambiguous. A reading is a
   misread when its offset (stamp minus PDF position) agrees with neither
   the pages before it nor the pages after it. Misreads are set aside and
   the gap re-inferred from the pages either side; a misread that cannot be
   re-inferred stays a break for Tom. A genuine jump in numbering agrees
   with one side, so it is never set aside. */
var BL_MISREAD_WINDOW = 40;
var BL_MISREAD_MIN = 5;

function blCheckSequence(readings, opts) {
  var first = blCheckSequenceOnce(readings, opts);
  if (!first.summary.break) return first;
  var pages = first.pages;
  var n = pages.length;
  var modal = function (lo, hi, tab) {
    var counts = {}, total = 0;
    for (var k = Math.max(0, lo); k <= Math.min(n - 1, hi); k++) {
      var r = readings[k];
      if (!r || pages[k].tab !== tab) continue;
      var off = r.page - k;
      counts[off] = (counts[off] || 0) + 1;
      total++;
    }
    if (total < BL_MISREAD_MIN) return null;
    var best = null;
    for (var o in counts) if (best === null || counts[o] > counts[best]) best = o;
    return counts[best] * 2 > total ? parseInt(best, 10) : null;
  };
  var suspects = [];
  for (var i = 0; i < n; i++) {
    /* Every reading is tested, not only breaks: after a stray "2", a stray
       "3" on the next page looks in sequence. */
    if (!readings[i]) continue;
    var own = readings[i].page - i;
    var left = modal(i - BL_MISREAD_WINDOW, i - 1, pages[i].tab);
    var right = modal(i + 1, i + BL_MISREAD_WINDOW, pages[i].tab);
    if (left === null && right === null) continue;
    if (own !== left && own !== right) suspects.push(i);
  }
  if (!suspects.length) return first;
  var again = readings.slice();
  suspects.forEach(function (k) { again[k] = null; });
  var second = blCheckSequenceOnce(again, opts);
  suspects.forEach(function (k) {
    var e = second.pages[k];
    e.misread = readings[k].page;
    if (e.status !== "inferred") { e.status = "break"; e.page = readings[k].page; }
  });
  var summary = { read: 0, inferred: 0, break: 0, none: 0, mode: second.summary.mode };
  second.pages.forEach(function (e) { summary[e.status]++; });
  second.summary = summary;
  return second;
}

/* ── Finding the target page ─────────────────────────────────────────────
   `maps` is [{label, file, pages, mode, tabStarts?}] — one per bundle file,
   where `pages` is the output of blCheckSequence (after Tom's corrections).
   Several files may share a label (volumes B1, B2 of the same bundle, or a
   bundle Tom labelled "B" split across files); the page map decides which
   file holds the page.

   Returns {file, pageIndex, status} where status is
     matched        the page was read or confirmed
     inferred       the page number was inferred from its neighbours
     not-found      the label is known but no page carries that number
     label-unknown  no bundle has that label
     ambiguous      more than one page carries that number (e.g. a per-tab
                    bundle referred to without its tab)
   Pages still marked break or none are never linked to. */
function blResolveRef(ref, maps) {
  var label = blNormLabel(ref.label);
  var files = (maps || []).filter(function (m) { return blNormLabel(m.label) === label; });
  if (!files.length) return { status: "label-unknown" };
  var hits = [];
  files.forEach(function (m) {
    (m.pages || []).forEach(function (p) {
      if (p.status !== "read" && p.status !== "inferred") return;
      if (ref.page === null) {
        /* Authorities [AB/3]: the first page of tab 3. */
        if (ref.tab !== null && p.tab === ref.tab) hits.push({ m: m, p: p });
        return;
      }
      if (p.page !== ref.page) return;
      if (m.mode === "per-tab") {
        if (ref.tab === null || p.tab === ref.tab) hits.push({ m: m, p: p });
      } else {
        /* Continuous: the tab in the reference is a cross-check only. */
        hits.push({ m: m, p: p });
      }
    });
  });
  if (ref.page === null && hits.length) hits = [hits[0]];
  if (!hits.length) {
    if (ref.page === null && ref.tab !== null) {
      /* A tab with no page: use the bundle's tab starts if known. */
      for (var i = 0; i < files.length; i++) {
        var ts = files[i].tabStarts || {};
        for (var k in ts) if (ts[k] === ref.tab) return { file: files[i].file, pageIndex: parseInt(k, 10), status: "matched" };
      }
    }
    return { status: "not-found" };
  }
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.map(function (h) { return { file: h.m.file, pageIndex: h.p.idx }; }) };
  var res = { file: hits[0].m.file, pageIndex: hits[0].p.idx, status: hits[0].p.status === "inferred" ? "inferred" : "matched" };
  /* Continuous pagination: the page alone decides, but a tab in the
     reference that disagrees with the stamp's tab is shown to Tom — either
     the skeleton or the stamp reading is wrong. */
  var hp = hits[0].p;
  if (ref.tab !== null && ref.page !== null && hp.tab !== null && hp.tab !== undefined && hp.tab !== ref.tab) res.warning = "tab differs";
  return res;
}

/* ── Placing the link box ────────────────────────────────────────────────
   pdf.js gives text in runs ("items"), each with a position and width. A
   reference usually sits inside a longer run, so its box is placed by
   character position within the run — close, not exact, since characters
   differ in width; the review screen shows each box so a misplaced one is
   seen. `item` is {str, x, y, w, h} with y the baseline in PDF units
   (origin bottom-left, as PDF annotations expect). Returns [x1, y1, x2, y2]
   with a small margin. */
function blLinkRect(item, start, end) {
  var len = Math.max(1, String(item.str || "").length);
  var w = item.w || 0;
  var h = item.h || 10;
  var x1 = item.x + w * (start / len);
  var x2 = item.x + w * (end / len);
  var pad = 1;
  return [x1 - pad, item.y - h * 0.25 - pad, x2 + pad, item.y + h * 0.85 + pad];
}

/* Map a reference's character range in the joined text of a page back to
   the runs it spans. `runs` is [{str, ...}] in reading order; the joined
   text is the runs' strings concatenated with `joiner` between them (the
   same joiner the caller used to build the text it passed to
   blParseRefs). Returns [{run, start, end}] — usually one entry, two when a
   reference breaks across a line. */
function blSpanRuns(runs, start, end, joiner) {
  var j = joiner === undefined ? " " : joiner;
  var out = [];
  var pos = 0;
  for (var i = 0; i < runs.length; i++) {
    var str = String(runs[i].str || "");
    var rs = pos, re = pos + str.length;
    var s = Math.max(start, rs), e = Math.min(end, re);
    if (s < e) out.push({ run: i, start: s - rs, end: e - rs });
    pos = re + j.length;
    if (pos > end) break;
  }
  return out;
}

/* ── Tabs from bookmarks ──────────────────────────────────────────────────
   Bundles from a bundling service carry a bookmark per tab, titled
   "01 - 2025.12.15 - Originating Summons" or "Tab 4 - Gulf Investment …".
   `outline` is [{title, pageIndex}] (pageIndex zero-based, resolved by the
   caller from pdf.js). Returns {pageIndex: tab}. A title with no leading
   tab number is skipped; if fewer than half the bookmarks carry one, none
   are used, since the numbers are then probably something else. */
function blTabStartsFromOutline(outline) {
  var out = {};
  var list = (outline || []).filter(function (o) { return o && o.pageIndex !== null && o.pageIndex !== undefined; });
  var hits = 0;
  list.forEach(function (o) {
    var t = String(o.title || "").replace(/\u0000/g, "").trim();
    var m = t.match(/^(?:Tab\s*)?(\d{1,3})\s*(?:[-–—.:)]|\s)/i);
    if (!m) return;
    hits++;
    out[o.pageIndex] = parseInt(m[1], 10);
  });
  return hits >= Math.ceil(list.length / 2) && hits > 0 ? out : {};
}

/* ── The skeleton's own key to its bundles ───────────────────────────────
   Skeletons usually say which label means which bundle: "References in
   square brackets to [A/TAB/PAGE], [B/TAB/PAGE] and [C/TAB/PAGE] are to
   Bundle A, Bundle B and the Correspondence Bundle respectively. References
   to [AB/TAB/PAGE] are to the Plaintiff's Authorities Bundle."
   Returns [{label, name}]. Where the labels and names do not pair up one to
   one, nothing is returned for that sentence; Tom assigns by hand. */
function blLabelsFromKey(text) {
  var s = String(text || "").replace(/\s+/g, " ").replace(/[’‘]/g, "'");
  var out = [];
  var re = /((?:\[\s*[A-Za-z]{1,4}\d{0,2}\s*\/\s*TAB\s*\/\s*PAGE\s*\]\s*(?:,|and|&)?\s*)+)\s*(?:are|is)\s+(?:references\s+)?to\s+([^.]+?)(?:,?\s+respectively)?\s*\./gi;
  var m;
  while ((m = re.exec(s))) {
    var labels = (m[1].match(/\[\s*([A-Za-z]{1,4}\d{0,2})\s*\//g) || []).map(function (x) { return blNormLabel(x.replace(/[\[\/\s]/g, "")); });
    var names = m[2].split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map(function (n) {
      return n.replace(/^(?:the|a)\s+/i, "").trim();
    }).filter(Boolean);
    if (labels.length !== names.length) continue;
    labels.forEach(function (l, i) { out.push({ label: l, name: names[i] }); });
  }
  return out;
}

/* Which files a bundle name from the key could be. "Bundle A" must not
   match "Bundle AB"; curly and straight apostrophes are the same. Returns
   the matching file paths; more than one (two versions of the
   Correspondence Bundle in one folder) is for Tom to choose between. */
function blFilesForName(name, files) {
  var norm = function (x) { return String(x || "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").toLowerCase(); };
  var n = norm(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!n) return [];
  var re = new RegExp("(^|[^a-z0-9])" + n + "($|[^a-z0-9])");
  return (files || []).filter(function (f) {
    var base = norm(String(f).replace(/^.*[\\/]/, "").replace(/\.pdf$/i, ""));
    return re.test(base);
  });
}

/* ── Relative paths ──────────────────────────────────────────────────────
   Links must name the bundle relative to the skeleton, never by a full path
   from Tom's machine, so the case folder can be zipped and sent. Paths are
   relative to the case folder root, with "/" separators:
     ("Skeleton.pdf",        "Bundle B.pdf")         → "Bundle B.pdf"
     ("Skeleton.pdf",        "Bundles/Bundle B.pdf") → "Bundles/Bundle B.pdf"
     ("Skeletons/Sk.pdf",    "Bundles/Bundle B.pdf") → "../Bundles/Bundle B.pdf" */
function blRelativePath(fromFile, toFile) {
  var from = String(fromFile || "").replace(/\\/g, "/").split("/");
  var to = String(toFile || "").replace(/\\/g, "/").split("/");
  from.pop(); /* the skeleton's own name */
  var i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  var ups = [];
  for (var k = i; k < from.length; k++) ups.push("..");
  return ups.concat(to.slice(i)).join("/");
}

/* Node (the test) takes the functions through module.exports; the browser
   just gets them as globals from the script tag. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    blIsAuthoritiesLabel, blNormLabel, blGuessLabel,
    blParseRefs, blRefFromParts,
    blStampForm, blReadStamp, blStampCandidates, blFindStamp,
    blCheckSequence, blResolveRef,
    blTabStartsFromOutline, blLabelsFromKey, blFilesForName,
    blLinkRect, blSpanRuns, blRelativePath,
  };
}
