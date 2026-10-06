/* ══ v5.80 Push 1: FOOTNOTES AND PARAGRAPH NUMBERS ON UPLOAD ═════════════════
   Until now no tool has seen a Word skeleton's footnotes. extractDocxText
   used mammoth.extractRawText, which drops the footnotes and their markers
   altogether (tested 6 Oct 2026 on mammoth 1.6.0, the version the page
   loads). It also drops Word's automatic paragraph numbers, so "paragraph
   23" could not be found either. PDF skeletons kept their footnote text,
   but pdf.js joined each page into one line with the marker left as a stray
   number ("it is submitted 3 that"), indistinguishable from a paragraph or
   page number.

   These helpers fix both, for matter uploads only (see the callers in
   core.js). They are pure and hold no DOM, so api/__tests__/doc_text.test.js
   exercises them directly; the browser loads this file as a plain script
   before core.js.

   What the text now looks like:
     - a footnote marker in the body reads [fn 3];
     - the note itself reads [Footnote 3] ... — in Word, on the line after
       the paragraph that cites it, so the note stays in the same chunk as
       its paragraph; in a PDF, under a [Footnotes on this page] line at the
       foot of that page's text;
     - a Word paragraph carries its automatic number ("23. It is submitted")
       as Word displays it.

   Both readers are best-effort and fail safe: the callers fall back to the
   old extraction if either throws or reads markedly less text than before. */

/* ── Word (.docx) ─────────────────────────────────────────────────────────
   A .docx is a zip of XML parts. The caller unzips it (JSZip, already on the
   page) and passes the parts as strings:
     { document, numbering, styles, footnotes, endnotes }
   Only `document` is required. */

function dtDecodeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e.charAt(1) === "x" || e.charAt(1) === "X") return String.fromCharCode(parseInt(e.slice(2), 16));
    return String.fromCharCode(parseInt(e.slice(1), 10));
  });
}

function dtAttr(attrs, name) {
  var m = new RegExp("(?:^|\\s)w:" + name + "\\s*=\\s*\"([^\"]*)\"").exec(attrs || "");
  return m ? dtDecodeXml(m[1]) : null;
}

/* Walk a WordprocessingML part tag by tag. A tag-level walk rather than a
   regex per paragraph, because paragraphs nest (a text box sits inside a run
   inside a paragraph) and a lazy regex would cut the outer one short.
   Returns the paragraphs in document order:
     { text, numId, ilvl, style, noteId, noteType, refs: [{type, id}] } */
function dtWalkParagraphs(xml) {
  var out = [];
  var stack = [];          /* open paragraphs, innermost last */
  var inText = false;      /* inside <w:t> */
  var pPrDepth = 0;        /* inside <w:pPr> */
  var changeDepth = 0;     /* inside <w:pPrChange> — the OLD formatting, ignored */
  var moveFromDepth = 0;   /* inside <w:moveFrom> — text tracked as moved away */
  var note = null;         /* { id, type } while inside <w:footnote> / <w:endnote> */
  var re = /<(\/?)([A-Za-z0-9_:]+)([^>]*?)(\/?)>|([^<]+)/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    if (m[5] !== undefined) {
      if (inText && stack.length) stack[stack.length - 1].text += dtDecodeXml(m[5]);
      continue;
    }
    var closing = m[1] === "/";
    var tag = m[2];
    var attrs = m[3];
    var selfClosing = m[4] === "/" || /\/\s*$/.test(attrs);
    var p = stack.length ? stack[stack.length - 1] : null;

    if (tag === "w:footnote" || tag === "w:endnote") {
      if (closing) note = null;
      else if (!selfClosing) note = { id: dtAttr(attrs, "id"), type: tag === "w:footnote" ? "footnote" : "endnote", sep: !!dtAttr(attrs, "type") };
      continue;
    }
    if (tag === "w:p") {
      if (closing) {
        if (stack.length) out.push(stack.pop());
      } else {
        var np = { text: "", numId: null, ilvl: null, style: null, noteId: note ? note.id : null, noteType: note ? note.type : null, noteSep: note ? note.sep : false, refs: [] };
        if (selfClosing) out.push(np); else stack.push(np);
      }
      continue;
    }
    if (tag === "w:pPr") { if (!selfClosing) pPrDepth += closing ? -1 : 1; continue; }
    if (tag === "w:pPrChange") { if (!selfClosing) changeDepth += closing ? -1 : 1; continue; }
    /* A tracked move keeps the text at its old place too, in <w:moveFrom>;
       the document reads it only where it now stands. (Tracked deletions
       need no handling: they hold <w:delText>, which is never read.) */
    if (tag === "w:moveFrom") { if (!selfClosing) moveFromDepth += closing ? -1 : 1; continue; }
    if (tag === "w:t") { if (!selfClosing) inText = !closing && moveFromDepth === 0; continue; }
    if (closing || !p) continue;

    if (pPrDepth > 0 && changeDepth === 0) {
      if (tag === "w:pStyle") p.style = dtAttr(attrs, "val");
      else if (tag === "w:numId") p.numId = dtAttr(attrs, "val");
      else if (tag === "w:ilvl") p.ilvl = parseInt(dtAttr(attrs, "val") || "0", 10);
      continue;
    }
    if (tag === "w:tab") p.text += "\t";
    else if (tag === "w:br" || tag === "w:cr") p.text += "\n";
    else if (tag === "w:noBreakHyphen") p.text += "-";
    else if (tag === "w:footnoteReference" || tag === "w:endnoteReference") {
      var ref = { type: tag === "w:footnoteReference" ? "footnote" : "endnote", id: dtAttr(attrs, "id") };
      p.refs.push(ref);
      /* A placeholder the numbering pass replaces with [fn N] — the number
         Word displays is the order of reference, not the stored id. */
      p.text += "\u0000" + (p.refs.length - 1) + "\u0000";
    }
  }
  while (stack.length) out.push(stack.pop());
  return out;
}

/* Styles: which numbering a paragraph style carries, following basedOn. */
function dtParseStyles(xml) {
  var styles = {};
  var re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  var m;
  while ((m = re.exec(xml || "")) !== null) {
    var id = dtAttr(m[1], "styleId");
    if (!id) continue;
    var body = m[2];
    var based = /<w:basedOn\b([^>]*)\/?>/.exec(body);
    var numId = /<w:numId\b([^>]*)\/?>/.exec(body);
    var ilvl = /<w:ilvl\b([^>]*)\/?>/.exec(body);
    styles[id] = {
      basedOn: based ? dtAttr(based[1], "val") : null,
      numId: numId ? dtAttr(numId[1], "val") : null,
      ilvl: ilvl ? parseInt(dtAttr(ilvl[1], "val") || "0", 10) : null,
    };
  }
  return styles;
}

function dtStyleNumbering(styles, styleId) {
  var seen = {};
  var res = { numId: null, ilvl: null };
  while (styleId && styles[styleId] && !seen[styleId]) {
    seen[styleId] = true;
    var s = styles[styleId];
    if (res.numId === null && s.numId !== null) res.numId = s.numId;
    if (res.ilvl === null && s.ilvl !== null) res.ilvl = s.ilvl;
    styleId = s.basedOn;
  }
  return res;
}

/* Numbering definitions: abstract lists (format per level) and the num
   instances that point at them, with any restart overrides. */
function dtParseNumbering(xml) {
  var abstracts = {};
  var nums = {};
  var re = /<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g;
  var m;
  while ((m = re.exec(xml || "")) !== null) {
    var aid = dtAttr(m[1], "abstractNumId");
    var levels = {};
    var lre = /<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g;
    var lm;
    while ((lm = lre.exec(m[2])) !== null) {
      var lv = parseInt(dtAttr(lm[1], "ilvl") || "0", 10);
      var start = /<w:start\b([^>]*)\/?>/.exec(lm[2]);
      var fmt = /<w:numFmt\b([^>]*)\/?>/.exec(lm[2]);
      var text = /<w:lvlText\b([^>]*)\/?>/.exec(lm[2]);
      levels[lv] = {
        start: start ? parseInt(dtAttr(start[1], "val") || "1", 10) : 1,
        fmt: fmt ? dtAttr(fmt[1], "val") : "decimal",
        text: text ? dtAttr(text[1], "val") : "",
      };
    }
    abstracts[aid] = levels;
  }
  var nre = /<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g;
  while ((m = nre.exec(xml || "")) !== null) {
    var nid = dtAttr(m[1], "numId");
    var a = /<w:abstractNumId\b([^>]*)\/?>/.exec(m[2]);
    var overrides = {};
    var ore = /<w:lvlOverride\b([^>]*)>([\s\S]*?)<\/w:lvlOverride>/g;
    var om;
    while ((om = ore.exec(m[2])) !== null) {
      var so = /<w:startOverride\b([^>]*)\/?>/.exec(om[2]);
      if (so) overrides[parseInt(dtAttr(om[1], "ilvl") || "0", 10)] = parseInt(dtAttr(so[1], "val") || "1", 10);
    }
    nums[nid] = { abstractId: a ? dtAttr(a[1], "val") : null, overrides: overrides };
  }
  return { abstracts: abstracts, nums: nums };
}

function dtRoman(n) {
  var r = "";
  var map = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  for (var i = 0; i < map.length; i++) while (n >= map[i][0]) { r += map[i][1]; n -= map[i][0]; }
  return r;
}

function dtLetter(n) {
  /* Word's letters run a..z, then aa..zz, bbb... */
  if (n < 1) return "";
  var ch = String.fromCharCode(97 + ((n - 1) % 26));
  return new Array(Math.floor((n - 1) / 26) + 2).join(ch);
}

function dtFormatNumber(n, fmt) {
  switch (fmt) {
    case "lowerLetter": return dtLetter(n);
    case "upperLetter": return dtLetter(n).toUpperCase();
    case "lowerRoman": return dtRoman(n);
    case "upperRoman": return dtRoman(n).toUpperCase();
    case "bullet": case "none": return "";
    case "decimalZero": return (n < 10 ? "0" : "") + n;
    default: return String(n);
  }
}

/* Gives each numbered paragraph the label Word shows. Counters are kept per
   abstract list, so a list interrupted by headings carries on counting, as
   Word does; a num instance with a start override restarts it where it
   first appears. */
function dtNumberer(numbering, styles) {
  var counters = {};
  var seenNum = {};
  return function (p) {
    var numId = p.numId;
    var ilvl = p.ilvl;
    if (numId === null || ilvl === null) {
      var fromStyle = dtStyleNumbering(styles, p.style);
      if (numId === null) numId = fromStyle.numId;
      if (ilvl === null) ilvl = fromStyle.ilvl;
    }
    if (numId === null || numId === "0") return "";
    if (ilvl === null || isNaN(ilvl)) ilvl = 0;
    var num = numbering.nums[numId];
    if (!num || num.abstractId === null) return "";
    var levels = numbering.abstracts[num.abstractId];
    if (!levels || !levels[ilvl]) return "";
    var c = counters[num.abstractId] || (counters[num.abstractId] = []);
    if (!seenNum[numId]) {
      seenNum[numId] = true;
      for (var ov in num.overrides) {
        var ol = parseInt(ov, 10);
        c[ol] = num.overrides[ov] - 1;
        for (var d = ol + 1; d < 9; d++) c[d] = undefined;
      }
    }
    c[ilvl] = c[ilvl] === undefined ? levels[ilvl].start : c[ilvl] + 1;
    for (var k = ilvl + 1; k < 9; k++) c[k] = undefined;
    if (levels[ilvl].fmt === "bullet" || levels[ilvl].fmt === "none") return "";
    return (levels[ilvl].text || "").replace(/%(\d)/g, function (_, lvlNo) {
      var L = parseInt(lvlNo, 10) - 1;
      var def = levels[L] || { start: 1, fmt: "decimal" };
      var val = c[L] === undefined ? def.start : c[L];
      return dtFormatNumber(val, def.fmt);
    });
  };
}

function dtNoteTexts(xml) {
  var notes = {};
  var paras = dtWalkParagraphs(xml || "");
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    if (p.noteId === null || p.noteSep) continue;
    var t = p.text.replace(/\u0000\d+\u0000/g, "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    notes[p.noteId] = notes[p.noteId] ? notes[p.noteId] + " " + t : t;
  }
  return notes;
}

/* The whole Word document as text, in the same [{page,text}] shape every
   caller already takes. A .docx has no pages, so it is one page, as before. */
function dtDocxToPages(parts) {
  var paras = dtWalkParagraphs(parts.document || "");
  var label = dtNumberer(dtParseNumbering(parts.numbering), dtParseStyles(parts.styles));
  var footnotes = dtNoteTexts(parts.footnotes);
  var endnotes = dtNoteTexts(parts.endnotes);
  var fnCount = 0;
  var enCount = 0;
  var blocks = [];
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    var number = label(p);
    var notes = [];
    var text = p.text.replace(/\u0000(\d+)\u0000/g, function (_, k) {
      var ref = p.refs[parseInt(k, 10)];
      if (ref.type === "footnote") {
        fnCount++;
        notes.push("[Footnote " + fnCount + "] " + (footnotes[ref.id] || "(text of this footnote could not be read)"));
        return "[fn " + fnCount + "]";
      }
      enCount++;
      notes.push("[Endnote " + enCount + "] " + (endnotes[ref.id] || "(text of this endnote could not be read)"));
      return "[en " + enCount + "]";
    });
    var line = (number ? number + " " : "") + text.trim();
    if (!line.trim()) continue;
    blocks.push(notes.length ? line + "\n" + notes.join("\n") : line);
  }
  return [{ page: 1, text: blocks.join("\n\n"), footnotes: fnCount + enCount }];
}

/* ── PDF ──────────────────────────────────────────────────────────────────
   One page's pdf.js text items in, that page's text out. Each item carries
   its text, a transform ([a, b, c, d, x, y] — y measured up from the foot of
   the page) and its width; the font size is |d|.

   How it reads a page:
     1. The body size is the size most of the page's characters are set in.
     2. Items at roughly body size form the body lines.
     3. A small number sitting raised on a body line is a footnote marker and
        becomes [fn N].
     4. Small text below the lowest body line is the footnote area; a line
        there that begins with a number starts [Footnote N].
     5. A line that is only a page number ("3", "Page 3 of 10") is a footer
        and goes last, as it did before.
   Text it cannot place stays in the body in reading order, so nothing is
   dropped; at worst a note is left unlabelled, which is where we were. */

var DT_SMALL = 0.9;          /* below this fraction of body size is "small" */
var DT_FOOTER_RE = /^\s*(?:page\s+)?[-\u2013]?\s*\d{1,4}\s*[-\u2013]?\s*(?:(?:of|\/)\s*\d{1,4})?\s*$/i;

function dtItemSize(it) {
  var t = it.transform || [];
  return Math.abs(t[3]) || Math.abs(t[0]) || it.height || 0;
}

function dtJoinLine(items) {
  items.sort(function (a, b) { return a.x - b.x; });
  var s = "";
  var prevEnd = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var str = it.marker ? "[fn " + it.str.trim() + "]" : it.str;
    if (s && prevEnd !== null && !/\s$/.test(s) && !/^\s/.test(str) && !it.marker && it.x - prevEnd > 0.15 * it.size) s += " ";
    s += str;
    prevEnd = it.x + (it.width || 0);
  }
  return s.replace(/[ \t]+/g, " ").trim();
}

function dtLineLedByMarker(line) {
  var first = null;
  for (var i = 0; i < line.items.length; i++) {
    var it = line.items[i];
    if (!it.str.trim()) continue;
    if (!first || it.x < first.x) first = it;
  }
  return !!(first && first.marker);
}

function dtGroupLines(items, tolFactor) {
  var sorted = items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });
  var lines = [];
  for (var i = 0; i < sorted.length; i++) {
    var it = sorted[i];
    var line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - it.y) <= tolFactor * Math.max(line.size, it.size)) {
      line.items.push(it);
      if (it.size > line.size) { line.size = it.size; line.y = it.y; }
    } else {
      lines.push({ y: it.y, size: it.size, items: [it] });
    }
  }
  return lines;
}

/* The size most of the document's characters are set in. Measured over the
   whole document, not page by page: on a real skeleton (6 Oct 2026) one page
   was mostly a long quotation inside a footnote, so a per-page count took the
   footnote size for the body and lost that page's notes. */
function dtBodySize(pagesOfItems) {
  var weight = {};
  for (var p = 0; p < (pagesOfItems || []).length; p++) {
    var items = pagesOfItems[p] || [];
    for (var i = 0; i < items.length; i++) {
      var raw = items[i];
      if (!raw || typeof raw.str !== "string" || !raw.transform) continue;
      var size = dtItemSize(raw);
      var chars = raw.str.replace(/\s/g, "").length;
      if (size && chars) { var key = Math.round(size * 2) / 2; weight[key] = (weight[key] || 0) + chars; }
    }
  }
  var body = 0, best = -1;
  for (var k in weight) if (weight[k] > best) { best = weight[k]; body = parseFloat(k); }
  return body;
}

/* bodySize: the document's body size from dtBodySize. Without it the page
   is measured on its own. */
function dtPdfPageText(items, bodySize) {
  var its = [];
  for (var i = 0; i < (items || []).length; i++) {
    var raw = items[i];
    if (!raw || typeof raw.str !== "string" || !raw.transform) continue;
    var size = dtItemSize(raw);
    if (!size) continue;
    its.push({ str: raw.str, x: raw.transform[4], y: raw.transform[5], size: size, width: raw.width || 0 });
  }
  if (!its.length) return "";
  var body = bodySize || dtBodySize([items]);

  var big = [], small = [];
  for (i = 0; i < its.length; i++) (its[i].size >= DT_SMALL * body ? big : small).push(its[i]);

  var bodyLines = dtGroupLines(big, 0.3);
  var footers = [];
  var main = [];
  for (i = 0; i < bodyLines.length; i++) {
    var lt = dtJoinLine(bodyLines[i].items.slice());
    if (DT_FOOTER_RE.test(lt)) footers.push(bodyLines[i]); else main.push(bodyLines[i]);
  }
  /* Footnote markers: a short number, small, raised above a body line. */
  var rest = [];
  var markers = 0;
  for (i = 0; i < small.length; i++) {
    var it2 = small[i];
    var host = null;
    if (/^\s*\d{1,3}\s*$/.test(it2.str)) {
      for (var j = 0; j < main.length; j++) {
        var L = main[j];
        var rise = it2.y - L.y;
        if (rise > 0.1 * body && rise < 0.9 * body) {
          var xs = L.items.map(function (q) { return q.x; });
          var minX = Math.min.apply(null, xs);
          var maxX = Math.max.apply(null, L.items.map(function (q) { return q.x + q.width; }));
          /* A note's own number may hang well left of its text; body text
             never has a raised number to the left of a line. */
          if (it2.x >= minX - 4 * body && it2.x <= maxX + 3 * body) { host = L; break; }
        }
      }
    }
    if (host) { it2.marker = true; host.items.push(it2); markers++; }
    else rest.push(it2);
  }

  /* Footnotes set in the body's own size. Their raised number has just been
     taken for a marker, so such a note is a body-size line that BEGINS with
     a marker — which body text practically never does, as a marker follows
     a word. The footnote area starts at the first such line with no
     paragraph opening below it ("12.", "(b)", a heading in capitals);
     everything from there down is notes. */
  main.sort(function (a, b) { return b.y - a.y; });
  var bigNotes = [];
  for (i = 0; i < main.length; i++) {
    if (!dtLineLedByMarker(main[i])) continue;
    var clean = true;
    for (j = i + 1; j < main.length; j++) {
      if (dtLineLedByMarker(main[j])) continue;
      if (/^\s*(?:\d{1,3}\.\s|\([a-z0-9]{1,4}\)\s|[A-Z]\.\s+[A-Z]{3})/.test(dtJoinLine(main[j].items.slice()))) { clean = false; break; }
    }
    if (clean) { bigNotes = main.splice(i); break; }
  }
  var bottom = main.length ? Math.min.apply(null, main.map(function (l) { return l.y; })) : -Infinity;

  /* Where the footnote area starts. Found on real skeletons (6 Oct 2026): a
     running footer in body-size type ("FSD0161/2018 2026-10-05") sits BELOW
     the notes, so "below the lowest body line" put the notes in the body.
     The surer sign is a small line opening with the number of a marker
     found on this page: the highest such line starts the area, and any
     body-size line beneath it is a footer. */
  var markerNums = {};
  for (i = 0; i < main.length; i++) for (j = 0; j < main[i].items.length; j++) if (main[i].items[j].marker) markerNums[main[i].items[j].str.trim()] = true;
  var smallLines = dtGroupLines(rest, 0.5);
  var zoneTop = null;
  for (i = 0; i < smallLines.length; i++) {
    var sl = smallLines[i].items.filter(function (q) { return q.str.trim(); }).sort(function (a, b) { return a.x - b.x; });
    var ln = sl.length ? /^\s*(\d{1,3})\b/.exec(sl[0].str) : null;
    if (ln && markerNums[ln[1]] && (zoneTop === null || smallLines[i].y > zoneTop)) zoneTop = smallLines[i].y;
  }
  if (zoneTop !== null) {
    var kept = [];
    for (i = 0; i < main.length; i++) (main[i].y < zoneTop ? footers : kept).push(main[i]);
    main = kept;
    bottom = zoneTop + 0.6 * body;
  }

  /* Small text below the body is the footnote area; small text elsewhere
     (a table, a block quote) stays where it is. */
  var below = [], inBody = [];
  for (i = 0; i < rest.length; i++) (rest[i].y < bottom ? below : inBody).push(rest[i]);
  var noteLines = bigNotes.concat(dtGroupLines(below, 0.5));
  var notes = [];
  var numbered = false;
  for (i = 0; i < noteLines.length; i++) {
    var nl = noteLines[i];
    /* Empty fragments come first on real note lines; read past them. */
    nl.items = nl.items.filter(function (q) { return q.str.trim(); });
    if (!nl.items.length) continue;
    nl.items.sort(function (a, b) { return a.x - b.x; });
    /* A page number in small type is a footer, not footnote 6. */
    if (DT_FOOTER_RE.test(dtJoinLine(nl.items.slice()))) { footers.push(nl); continue; }
    var first = nl.items[0];
    var txt;
    var lead = /^\s*(\d{1,3})(?:[.)]?\s+|\s*$)/.exec(first.str);
    /* A note's second line can start with a number ("28 May 2020", "791
       (Comm)"). A number opens a note only if it is a marker on this page
       or, on a page with no markers, is set raised and small like one. */
    if (lead && !markerNums[lead[1]]) {
      var next = nl.items[1];
      var raisedSmall = /^\s*\d{1,3}\s*$/.test(first.str) && next && first.size < 0.85 * next.size;
      if (Object.keys(markerNums).length || !raisedSmall) lead = null;
    }
    if (first.marker) first.marker = false;
    if (lead) {
      numbered = true;
      var remainder = first.str.slice(lead[0].length);
      var others = nl.items.slice(1);
      if (remainder) others.unshift({ str: remainder, x: first.x + 1, size: first.size, width: first.width });
      txt = "[Footnote " + lead[1] + "] " + dtJoinLine(others);
    } else {
      txt = dtJoinLine(nl.items.slice());
    }
    if (!txt.trim()) continue;
    if (DT_FOOTER_RE.test(txt)) footers.push(nl); else notes.push(txt.trim());
  }
  /* With no marker on the page and no numbered line below, the "notes" are
     more likely a running footer than footnotes: leave them unlabelled. */
  var isNotes = notes.length && (markers > 0 || numbered);

  var all = main.concat(dtGroupLines(inBody, 0.5)).sort(function (a, b) { return b.y - a.y; });
  var out = all.map(function (l) { return dtJoinLine(l.items.slice()); }).filter(Boolean);
  if (notes.length) {
    if (isNotes) out.push("[Footnotes on this page]");
    out = out.concat(notes);
  }
  footers.sort(function (a, b) { return b.y - a.y; });
  for (i = 0; i < footers.length; i++) out.push(dtJoinLine(footers[i].items.slice()));
  return out.filter(function (s) { return s && s.trim(); }).join("\n");
}

/* ── The safety check ─────────────────────────────────────────────────────
   How much real text a reading holds, ignoring whitespace and the labels the
   layout readers add. The number inside [fn 3] or [Footnote 3] is kept — it
   was in the plain reading too, as a bare "3", and dropping it would make
   every page with a footnote look short and fall back. core.js uses this to
   check a layout reading lost nothing the old reading had. */
function dtTextWeight(s) {
  return String(s || "").replace(/\[(?:fn|en|Footnote|Endnote) (\d+)\]/g, "$1").replace(/\[Footnotes on this page\]/g, "").replace(/\s+/g, "").length;
}

/* Node (the test) takes the functions through module.exports; the browser
   just gets them as globals from the script tag. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    dtDocxToPages, dtWalkParagraphs, dtParseNumbering, dtParseStyles, dtNumberer,
    dtFormatNumber, dtNoteTexts, dtPdfPageText, dtBodySize, dtTextWeight, DT_FOOTER_RE,
  };
}
