/* EX LIBRIS JURIS v5.81 (Push 2) — api/lib/authorities.js
   LIST OF AUTHORITIES: the pure half of the tool. No database, no model —
   api/authoritiesWorker.js does the I/O and calls these. Kept pure so
   api/__tests__/authorities.test.js can exercise every rule Tom set
   (6 Oct 2026):

     - every case and textbook cited in the skeletons for one hearing, in
       the text and in footnotes;
     - each entry carries every report citation given for it, taken ONLY
       from the skeletons reviewed (anything the model offers that is not in
       the skeletons is dropped here, in code);
     - where it is cited: skeleton, paragraph, footnote;
     - one sentence per proposition it is cited for;
     - three orders: alphabetical (the default), by year — the REPORT year,
       not the decision year — and order of citation within each skeleton;
     - cases grouped Cayman Islands, United Kingdom, BVI, Bermuda, Isle of
       Man; then a separate foreign section: Australia, Hong Kong, Canada,
       United States, then any other jurisdiction alphabetically;
     - a Privy Council appeal sits under Cayman, BVI or Bermuda when it came
       from there, otherwise under the United Kingdom (the merge prompt
       applies this; the code only normalises the names);
     - textbooks in their own section, by author, or by edition year.

   The three orders are all built here, on the server, and embedded in the
   saved result so the screen can switch between them without re-running
   and History keeps the switch. See embedViews / VIEW_MARKER. */

/* ── Jurisdictions ──────────────────────────────────────────────────────── */

export const HOME_ORDER = ["Cayman Islands", "United Kingdom", "British Virgin Islands", "Bermuda", "Isle of Man"];
export const FOREIGN_ORDER = ["Australia", "Hong Kong", "Canada", "United States"];
export const UNKNOWN_JURISDICTION = "Jurisdiction not identified";

export function normaliseJurisdiction(j) {
  var s = String(j || "").trim();
  var l = s.toLowerCase();
  if (!l || l === "unknown" || l === "n/a" || l === "none") return UNKNOWN_JURISDICTION;
  if (/cayman/.test(l)) return "Cayman Islands";
  if (/virgin|\bbvi\b/.test(l)) return "British Virgin Islands";
  if (/bermuda/.test(l)) return "Bermuda";
  if (/isle of man|\bmanx\b|\biom\b/.test(l)) return "Isle of Man";
  if (/^(uk|u\.k\.|united kingdom|great britain|britain|england|england and wales|england & wales|english|wales|scotland|scottish|northern ireland|privy council|house of lords|uk supreme court)\b/.test(l)) return "United Kingdom";
  if (/australia|new south wales|\bnsw\b|victoria|queensland/.test(l)) return "Australia";
  if (/hong kong|\bhksar\b/.test(l)) return "Hong Kong";
  if (/canada|ontario|british columbia|alberta|quebec/.test(l)) return "Canada";
  if (/united states|\busa\b|\bu\.s\.a?\.?$|\bus\b|delaware|new york|california/.test(l)) return "United States";
  /* Anything else keeps its own name, tidied: "new zealand" -> "New Zealand". */
  return s.replace(/\s+/g, " ").replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });
}

/* Where a jurisdiction sits: section "home" or "foreign", and its rank. */
export function jurisdictionRank(jur) {
  var h = HOME_ORDER.indexOf(jur);
  if (h !== -1) return { section: "home", rank: h };
  var f = FOREIGN_ORDER.indexOf(jur);
  if (f !== -1) return { section: "foreign", rank: f };
  if (jur === UNKNOWN_JURISDICTION) return { section: "foreign", rank: 9999 };
  /* Other jurisdictions follow the United States, alphabetically. */
  return { section: "foreign", rank: 100 };
}

export function compareJurisdictions(a, b) {
  var ra = jurisdictionRank(a), rb = jurisdictionRank(b);
  if (ra.section !== rb.section) return ra.section === "home" ? -1 : 1;
  if (ra.rank !== rb.rank) return ra.rank - rb.rank;
  return a.localeCompare(b);
}

/* ── Citations and years ────────────────────────────────────────────────── */

/* Report-series tokens that make a [year] citation a NEUTRAL citation. The
   report year is taken from the first citation that is not one of these.
   "Ch" is deliberately absent: [1970] Ch 352 is the Law Reports. */
var NEUTRAL_SERIES = /^(?:UKSC|UKHL|UKPC|EWCA|EWHC|EWCOP|EWFC|UKUT|UKFTT|UKEAT|CSIH|CSOH|NICA|NIQB|IEHC|IESC|IECA|HKCFA|HKCA|HKCFI|HKDC|CIGC|NZSC|NZCA|NZHC|SGCA|SGHC|SGHCI|HCA|FCA|FCAFC|NSWSC|NSWCA|VSC|VSCA|QCA|QSC|WASC|WASCA|SCC|ONCA|ONSC|BCCA|BCSC|QCCA|ABCA|ABQB|CICA|GC|KYGC|KYCA|KYPC|BVIHC|BVIHCV|BVIHCM|ECSC|SC|CA)\b/;

export function isNeutralCitation(c) {
  var m = /\[(\d{4})\]\s*(.*)$/.exec(String(c || ""));
  if (!m) return false;
  var rest = m[2].replace(/^\(\d+\)\s*/, "");
  if (/^\d/.test(rest)) return false;          /* [2003] 2 AC 1 */
  return NEUTRAL_SERIES.test(rest);
}

export function citationYear(c) {
  var s = String(c || "");
  var m = /[\[(](\d{4})[\])]/.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /^\s*(\d{4})\s/.exec(s);          /* 2014 (2) CILR 191, 1952 SC 49 */
  if (m) return parseInt(m[1], 10);
  /* An unreported judgment: "FSD 24 of 2021", "unreported, 1 March 2016". */
  m = /\b(1[89]\d\d|20\d\d)\b/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

/* Tom's rule: the year that orders the list is the REPORT year, not the
   decision year. First law report given; a neutral citation only when no
   report is. */
export function reportYear(reports) {
  var list = reports || [];
  for (var i = 0; i < list.length; i++) {
    if (!isNeutralCitation(list[i])) { var y = citationYear(list[i]); if (y) return y; }
  }
  for (i = 0; i < list.length; i++) { var y2 = citationYear(list[i]); if (y2) return y2; }
  return null;
}

/* Lower-case letters and digits only: "[2003] 2 AC 1" -> "20032ac1". */
export function normCit(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function splitCitations(s) {
  return String(s || "").split(/\s*;\s*/).map(function (x) { return x.trim().replace(/[.,]+$/, ""); }).filter(Boolean);
}

/* Names compare without case, punctuation or a leading "Re"/"In re"/"The". */
export function sortName(name) {
  return String(name || "").toLowerCase()
    .replace(/^\s*(?:in re|in the matter of|re|the|ex parte)\s+/, "")
    .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export function normName(name) {
  return String(name || "").toLowerCase().replace(/\b(?:limited|ltd|plc|inc|llc|co|company|corporation|corp)\b/g, "").replace(/[^a-z0-9]/g, "");
}

/* ── Rebuilding a skeleton's text from its chunks ───────────────────────── */

/* The upload chunker repeats the last 150 characters of each chunk at the
   start of the next. Strip that, or a citation at a chunk boundary is read
   twice. Returns how many characters at the start of `next` repeat the end
   of the text so far (`tail`).

   Two things found on a real skeleton (6 Oct 2026) shape this:
     - the repeat is cut BEFORE the chunk is trimmed, so its whitespace need
       not match the stored chunk's — compare with whitespace collapsed;
     - the previous chunk can be shorter than the repeat (a page footer on
       its own), so the repeat reaches back into the chunk before it —
       compare against the text so far, not the previous chunk alone.
   60 characters is the least that counts: a shorter match could be a
   running footer, and the chunker's repeat is 150. */
export function overlapLength(tail, next) {
  var t = String(tail || "").replace(/\s+/g, " ").replace(/\s+$/, "");
  var max = Math.min(260, next.length);
  for (var k = max; k >= 60; k--) {
    var cand = next.slice(0, k).replace(/\s+/g, " ").trim();
    if (cand.length >= 60 && cand.length <= t.length && t.slice(t.length - cand.length) === cand) {
      /* Leave any whitespace after the repeat with the new text, so a word
         break at the join survives ("191 of the", not "191 ofthe"). */
      while (k > 0 && /\s/.test(next.charAt(k - 1))) k--;
      return k;
    }
  }
  return 0;
}

/* chunks: [{content, page_number, chunk_index}] for ONE document, any order.
   Returns the document's text with "[Page N]" wherever the page changes. */
export function rebuildText(chunks) {
  var list = (chunks || []).slice().sort(function (a, b) { return a.chunk_index - b.chunk_index; });
  var out = "";
  var raw = "";          /* the text so far, without page marks */
  var lastPage = null;
  for (var i = 0; i < list.length; i++) {
    var c = String(list[i].content || "");
    var k = raw ? overlapLength(raw.slice(-600), c) : 0;
    /* After a repeat, the new text continues the old exactly, whitespace
       and all; with no repeat found, start a new paragraph. */
    var piece = k ? c.slice(k) : c.replace(/^\s+/, "");
    if (!piece.trim()) continue;
    var sep = (!raw || k) ? "" : "\n\n";
    var page = list[i].page_number;
    if (page != null && page !== lastPage) {
      out += (out ? "\n\n" : "") + "[Page " + page + "]\n";
      lastPage = page;
      out += piece.replace(/^\s+/, "");
    } else {
      out += sep + piece;
    }
    raw += sep + piece;
  }
  return out;
}

/* Cut a document's text into batches of about maxChars, at page breaks
   where possible so a page's footnotes stay with its paragraphs. Each batch
   carries the end of the previous one as context, for paragraph numbers and
   short names that began there. */
export function batchText(text, maxChars) {
  maxChars = maxChars || 40000;
  var parts = String(text || "").split(/(?=\[Page \d+\]\n)/);
  var pieces = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    while (p.length > maxChars) {
      var cut = p.lastIndexOf("\n\n", maxChars);
      if (cut < maxChars / 2) cut = p.lastIndexOf("\n", maxChars);
      if (cut < maxChars / 2) cut = maxChars;
      pieces.push(p.slice(0, cut));
      p = p.slice(cut);
    }
    if (p) pieces.push(p);
  }
  var batches = [];
  var cur = "";
  for (i = 0; i < pieces.length; i++) {
    if (cur && cur.length + pieces[i].length > maxChars) { batches.push(cur); cur = ""; }
    cur += pieces[i];
  }
  if (cur.trim()) batches.push(cur);
  return batches.map(function (t, idx) {
    var before = idx > 0 ? batches[idx - 1] : "";
    return { text: t, context: before.slice(-2500), pages: pageRange(t) };
  });
}

function pageRange(t) {
  var m = String(t).match(/\[Page (\d+)\]/g) || [];
  if (!m.length) return "";
  var first = m[0].replace(/\D/g, ""), last = m[m.length - 1].replace(/\D/g, "");
  return first === last ? first : first + "–" + last;
}

/* A readable name for a skeleton: no extension, no leading date, no
   underscores. "2026.10.05_-_Skeleton_Argument_on_behalf_of_ACC.pdf" ->
   "Skeleton Argument on behalf of ACC". */
export function skeletonLabel(name) {
  var s = String(name || "").replace(/\.(pdf|docx?)$/i, "").replace(/_/g, " ");
  s = s.replace(/^\s*\d{4}[.\-\/ ]\d{1,2}[.\-\/ ]\d{1,2}\s*[-–—]?\s*/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 77).replace(/\s+\S*$/, "") + "…";
  return s || String(name || "");
}

/* ── Model output ───────────────────────────────────────────────────────── */

export function parseJsonBlock(text) {
  var s = String(text || "");
  var m = /<json>([\s\S]*?)<\/json>/i.exec(s);
  var body = m ? m[1] : s;
  var start = body.search(/[\[{]/);
  if (start === -1) throw new Error("no JSON in model output");
  var end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  body = body.slice(start, end + 1);
  try { return JSON.parse(body); }
  catch (e) {
    /* One repair: trailing commas, the commonest slip. */
    return JSON.parse(body.replace(/,\s*([}\]])/g, "$1"));
  }
}

function str(v) { return v == null ? "" : String(v).trim(); }

/* "case", "textbook", or "related": a judgment in these or related
   proceedings cited for its findings or procedural history, not for law.
   Related judgments get their own section and are not checked — there is
   no proposition of law to check. */
export function normKind(k) {
  k = str(k).toLowerCase();
  return k === "textbook" || k === "related" ? k : "case";
}

/* One extraction batch's citations, cleaned and numbered. `seq` is the
   running count for this job so ids are unique: "i1", "i2", … Order is
   document order: skeleton, then batch, then position. */
export function cleanInstances(parsed, docIndex, batchIndex, seqStart) {
  var list = (parsed && Array.isArray(parsed.citations)) ? parsed.citations : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i] || {};
    var kind = normKind(c.kind);
    var name = str(c.name);
    if (!name && kind === "textbook") name = [str(c.author), str(c.title)].filter(Boolean).join(", ");
    if (!name) continue;
    out.push({
      id: "i" + (seqStart + out.length + 1),
      doc: docIndex,
      order: docIndex * 1e6 + batchIndex * 1e3 + i,
      kind: kind,
      name: name,
      citation: str(c.citation),
      pinpoint: str(c.pinpoint),
      para: str(c.para).replace(/^(?:para(?:graph)?\.?|¶)\s*/i, ""),
      fn: str(c.fn).replace(/^(?:fn|footnote)\.?\s*/i, ""),
      proposition: str(c.proposition),
      author: str(c.author), title: str(c.title), edition: str(c.edition), year: str(c.year),
    });
  }
  return out;
}

/* The overlap strip is exact, but a page's text can still be read twice at
   a batch join. The same authority at the same paragraph and footnote of
   the same skeleton is one citation. */
export function dedupeInstances(instances) {
  var seen = {};
  return instances.filter(function (x) {
    var k = x.doc + "|" + x.kind + "|" + normName(x.name) + "|" + x.para + "|" + x.fn + "|" + normCit(x.citation);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

/* Distinct (name, citation) lines for the merge prompt. */
export function mergeEntries(instances) {
  var byKey = {};
  var entries = [];
  for (var i = 0; i < instances.length; i++) {
    var x = instances[i];
    var k = x.kind + "|" + normName(x.name) + "|" + normCit(x.citation);
    if (!byKey[k]) {
      byKey[k] = { id: "E" + (entries.length + 1), kind: x.kind, name: x.name, citation: x.citation, author: x.author, title: x.title, edition: x.edition, year: x.year, members: [] };
      entries.push(byKey[k]);
    }
    byKey[k].members.push(x.id);
  }
  return entries;
}

/* Apply the model's grouping. Every entry ends up in exactly one authority;
   anything the model left out becomes an authority of its own. Report
   citations survive only if they appear in the skeletons' own text. */
export function applyMerge(parsed, entries) {
  var byId = {};
  entries.forEach(function (e) { byId[e.id] = e; });
  var used = {};
  var groups = (parsed && Array.isArray(parsed.authorities)) ? parsed.authorities : [];
  var out = [];
  function make(g, members) {
    var kinds = members.map(function (e) { return e.kind; });
    var kind = g.kind ? normKind(g.kind) : members[0].kind;
    /* A citation for law anywhere in the group makes it a case. */
    if (kind === "related" && kinds.indexOf("case") !== -1) kind = "case";
    if (kind !== "textbook" && kinds.every(function (x) { return x === "textbook"; })) kind = "textbook";
    var instanceIds = [];
    var cited = [];
    members.forEach(function (e) { instanceIds = instanceIds.concat(e.members); if (e.citation) cited.push(e.citation); });
    var haystack = cited.map(normCit).join("|");
    var reports = [];
    var seen = {};
    (Array.isArray(g.reports) ? g.reports : []).forEach(function (r) {
      var n = normCit(r);
      if (n.length >= 6 && haystack.indexOf(n) !== -1 && !seen[n]) { seen[n] = true; reports.push(str(r)); }
    });
    /* Nothing the model gave survived the check: fall back to the
       citations exactly as the skeletons wrote them. */
    if (!reports.length) {
      cited.forEach(function (c) { splitCitations(c).forEach(function (r) { var n = normCit(r); if (n && !seen[n]) { seen[n] = true; reports.push(r); } }); });
    }
    var name = str(g.name) || members[0].name;
    var a = {
      key: "A" + (out.length + 1),
      kind: kind,
      name: name,
      jurisdiction: kind !== "textbook" ? normaliseJurisdiction(g.jurisdiction) : "",
      court: str(g.court),
      reports: reports,
      author: str(g.author) || members[0].author || "",
      title: str(g.title) || members[0].title || "",
      edition: str(g.edition) || members[0].edition || "",
      year: null,
      instanceIds: instanceIds,
      propositions: [],
    };
    if (kind === "textbook") {
      var ty = parseInt(str(g.year) || members[0].year, 10);
      a.year = isNaN(ty) ? citationYear(name) : ty;
    } else {
      a.year = reportYear(reports);
    }
    out.push(a);
  }
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i] || {};
    var members = (Array.isArray(g.members) ? g.members : []).map(function (id) { return byId[str(id)]; })
      .filter(function (e) { return e && !used[e.id]; });
    if (!members.length) continue;
    members.forEach(function (e) { used[e.id] = true; });
    make(g, members);
  }
  entries.forEach(function (e) { if (!used[e.id]) make({ name: e.name, kind: e.kind }, [e]); });
  return out;
}

/* No usable merge from the model: group by name alone. Short forms stay
   separate entries — under-merging is visible, over-merging is not. */
export function fallbackMerge(entries) {
  var groups = {};
  var order = [];
  entries.forEach(function (e) {
    var k = e.kind + "|" + normName(e.name);
    if (!groups[k]) { groups[k] = { name: e.name, kind: e.kind, members: [] }; order.push(k); }
    groups[k].members.push(e.id);
  });
  return applyMerge({ authorities: order.map(function (k) { return groups[k]; }) }, entries);
}

/* ── Verification ───────────────────────────────────────────────────────── */

var NAME_STOPWORDS = {
  re: 1, in: 1, the: 1, of: 1, and: 1, ex: 1, parte: 1, matter: 1, on: 1, application: 1, petition: 1,
  ltd: 1, limited: 1, plc: 1, inc: 1, llc: 1, lp: 1, co: 1, company: 1, companies: 1, corporation: 1, corp: 1,
  holdings: 1, holding: 1, group: 1, international: 1, sa: 1, ag: 1, nv: 1, bv: 1, gmbh: 1, spa: 1,
  bank: 1, trust: 1, trustee: 1, trustees: 1, fund: 1, funds: 1, investment: 1, investments: 1,
  partners: 1, partnership: 1, management: 1, capital: 1, services: 1, industries: 1,
  others: 1, another: 1, anor: 1, ors: 1, appellant: 1, respondent: 1, plaintiff: 1, defendant: 1,
  attorney: 1, general: 1, secretary: 1, state: 1, minister: 1, commissioner: 1, commissioners: 1,
  for: 1, by: 1, no: 1, liquidation: 1, official: 1, liquidator: 1, liquidators: 1, receivership: 1,
  r: 1, v: 1, vs: 1, regina: 1, rex: 1, china: 1, cayman: 1, islands: 1, bermuda: 1, hong: 1, kong: 1,
};

function distinctiveWords(s, n) {
  var words = String(s || "").replace(/\(.*?\)/g, " ").match(/[A-Za-z][A-Za-z'\-]{2,}/g) || [];
  var out = [];
  for (var i = 0; i < words.length && out.length < n; i++) {
    var w = words[i].replace(/'s$/i, "");
    if (!NAME_STOPWORDS[w.toLowerCase()]) out.push(w);
  }
  return out;
}

/* A websearch query that finds other documents naming this authority:
   one distinctive word from each side of "v", or two from a "Re" name;
   for a textbook, the author and the first distinctive word of the title.
   Every term must appear (websearch ANDs quoted terms). [] means the name
   is too generic to search for safely. */
export function searchTerms(a) {
  if (a.kind === "textbook") {
    var t = distinctiveWords(a.author, 1).concat(distinctiveWords(a.title || a.name, 2));
    var uniq = [];
    t.forEach(function (w) { if (uniq.indexOf(w) === -1) uniq.push(w); });
    return uniq.slice(0, 2);
  }
  var sides = String(a.name || "").split(/\s+v\.?\s+|\s+vs\.?\s+/i);
  if (sides.length >= 2) {
    var left = distinctiveWords(sides[0], 1), right = distinctiveWords(sides[1], 1);
    return left.concat(right);
  }
  return distinctiveWords(sides[0], 2);
}

export function websearchQuery(terms) {
  return terms.map(function (t) { return '"' + t.replace(/"/g, "") + '"'; }).join(" ");
}

/* Is this source the authority itself? Only when its own name or citation
   carries one of the authority's report citations — a later judgment in the
   same litigation, which usually shares the parties' names, must still
   count as another judgment. */
export function isSameDecision(a, sourceNameAndCitation) {
  var hay = normCit(sourceNameAndCitation);
  return (a.reports || []).some(function (r) { var n = normCit(r); return n.length >= 8 && hay.indexOf(n) !== -1; });
}

/* The part of a passage around the first mention of the authority. */
export function passageWindow(text, terms, size) {
  size = size || 1400;
  var s = String(text || "");
  if (s.length <= size) return s;
  var at = -1;
  for (var i = 0; i < terms.length && at === -1; i++) at = s.toLowerCase().indexOf(String(terms[i]).toLowerCase());
  if (at === -1) return s.slice(0, size);
  var from = Math.max(0, Math.min(at - Math.floor(size / 3), s.length - size));
  return (from > 0 ? "…" : "") + s.slice(from, from + size) + (from + size < s.length ? "…" : "");
}

export var STATUSES = ["supported", "partly", "not_supported", "not_found"];

/* A related judgment is cited for what it found, so there is nothing of
   law to check: its propositions are the skeletons' own, one per distinct
   wording, with no verdict. */
export function relatedPropositions(a, instancesById) {
  var byText = {};
  var props = [];
  a.instanceIds.forEach(function (id) {
    var t = str((instancesById[id] || {}).proposition);
    var k = t.toLowerCase();
    if (!byText[k]) { byText[k] = { text: t, instanceIds: [], status: "facts", source: "", pinpoint: "", note: "" }; props.push(byText[k]); }
    byText[k].instanceIds.push(id);
  });
  a.propositions = props;
}

/* Apply one verification batch's result to its authorities. Every citation
   of an authority ends up under exactly one proposition; a status that
   relies on a passage must name a passage that was actually supplied. */
export function applyVerify(parsed, batch, passagesByKey, instancesById) {
  var results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
  var byKey = {};
  results.forEach(function (r) { if (r && r.key) byKey[str(r.key)] = r; });
  batch.forEach(function (a) {
    var r = byKey[a.key];
    var mine = {};
    a.instanceIds.forEach(function (id) { mine[id] = true; });
    var taken = {};
    var props = [];
    var passages = passagesByKey[a.key] || [];
    var pById = {};
    passages.forEach(function (p) { pById[p.pid] = p; });
    ((r && Array.isArray(r.propositions)) ? r.propositions : []).forEach(function (p) {
      var ids = (Array.isArray(p.instances) ? p.instances : []).map(str).filter(function (id) { return mine[id] && !taken[id]; });
      if (!ids.length) return;
      ids.forEach(function (id) { taken[id] = true; });
      var status = STATUSES.indexOf(str(p.status)) !== -1 ? str(p.status) : "not_found";
      var src = pById[str(p.passage)];
      if (status !== "not_found" && !src) status = "not_found";
      props.push({
        text: str(p.text) || (instancesById[ids[0]] && instancesById[ids[0]].proposition) || "",
        instanceIds: ids,
        status: status,
        source: status === "not_found" ? "" : src.label,
        pinpoint: status === "not_found" ? "" : str(p.pinpoint),
        note: status === "not_found" ? "" : str(p.note),
      });
    });
    /* Citations the model did not place keep their own proposition. When
       the whole check failed (parsed is null) they are marked unchecked,
       not "not found": nothing was looked at. */
    a.instanceIds.forEach(function (id) {
      if (taken[id]) return;
      var x = instancesById[id] || {};
      props.push({ text: x.proposition || "", instanceIds: [id], status: parsed ? "not_found" : "unchecked", source: "", pinpoint: "", note: "" });
    });
    a.propositions = props;
  });
}

/* ── Prompts ────────────────────────────────────────────────────────────────
   The system prompt is identical for every call in a job, so the prompt
   cache holds it (see CLAUDE.md, "Prompt caching"); everything that varies
   is in the user message. The Drafting Style Guide is not used here: its
   [REF NEEDED] and "Points to check" rules are for prose, and every output
   of this tool is JSON. The accuracy rule it carries is stated below, in
   terms that fit. */

export const SYSTEM_PROMPT = "You are a meticulous legal research assistant in an offshore litigation practice (Cayman Islands, British Virgin Islands, Bermuda). You read skeleton arguments and the authorities they cite.\n\n"
  + "Accuracy overrides everything else. Never invent a case name, a citation, a report reference, a paragraph number, a footnote number, a pinpoint or a quotation. Record only what the text in front of you says, exactly as it says it. Where the text does not give something, leave it empty rather than guess. Never rely on your own knowledge of an authority: work only from the text supplied.\n\n"
  + "Write in British English. Return only the JSON asked for, inside <json></json> tags.";

export function extractPrompt(label, batch) {
  return "SKELETON ARGUMENT: " + label + (batch.pages ? " (pages " + batch.pages + ")" : "") + "\n\n"
    + "How the text is marked:\n"
    + "- Paragraph numbers stand at the start of paragraphs: \"15.\", \"(c)\", \"15.1\".\n"
    + "- A footnote marker in the text reads [fn N]. The footnote itself reads [Footnote N] followed by its text: in a PDF the footnotes sit under \"[Footnotes on this page]\" at the foot of the page; in a Word document, on the line under the paragraph that cites them.\n"
    + "- [Page N] marks the start of a page. A few words may repeat where the text was joined; do not list a citation twice for that reason.\n\n"
    + "TASK: List, in the order they appear, every citation of\n"
    + "(a) a case — any reported or unreported judgment of any court, in any jurisdiction;\n"
    + "(b) a textbook or practitioners' work; and\n"
    + "(c) a judgment given in these proceedings or in related proceedings between the same or connected parties, cited for what it found or ordered, or for procedural history, rather than for a proposition of law.\n"
    + "Include citations in the body text and in footnotes. Every citation is a separate item, including a repeat citation of an authority already cited (\"Baosheng at [47]\", \"ibid\", \"supra\", \"op cit\").\n\n"
    + "Do NOT list: statutes, regulations, rules of court, practice directions or codes; bundle or evidence references such as {A/1/16} or [C2/2/8]; witness statements, affidavits, transcripts, exhibits, correspondence or pleadings.\n\n"
    + "For each citation give:\n"
    + "- kind: \"case\", \"textbook\", or \"related\" for (c). A judgment in these or related proceedings that is cited for a proposition of law is \"case\".\n"
    + "- name: the full case name (for a related judgment, the name or description the skeleton uses, e.g. \"Judgment of Coleman J in HCA 2880/2015\"). Where the text uses a short form (\"Baosheng\", \"ibid\", \"supra\", \"the Shanshui case\"), give the full name if it appears in this text or in the earlier context; otherwise give the short form exactly as written.\n"
    + "- citation: every law report and neutral citation given for it AT THIS PLACE, exactly as written and in the same order, separated by \"; \" — e.g. \"[1970] 1 WLR 352; [1971] 1 All ER 653\". Leave out pinpoints and descriptions of the court or judge. \"\" if none is given here. For an unreported judgment give the identifier as written (e.g. \"FSD 24 of 2021 (RPJ), 10 December 2021\").\n"
    + "- pinpoint: the paragraph or page pinpoint if given (\"at [16]-[18]\", \"at 360\"), else \"\".\n"
    + "- para: the number of the skeleton's paragraph in which the citation appears, as printed (\"15\", \"15(c)\"). For a footnote, the paragraph containing that footnote's marker [fn N]. \"\" if you cannot see it — never guess.\n"
    + "- fn: the footnote number if the citation is in a footnote, else \"\".\n"
    + "- proposition: ONE sentence stating the proposition of law for which the skeleton cites the authority at this point, faithful to what the skeleton says. If it is cited only for a fact, for procedural history, or with no proposition stated, say so in one sentence.\n"
    + "- for a textbook also: author, title, edition (e.g. \"21st\"), year (publication year) — \"\" for anything not given.\n\n"
    + "Return ONLY this, inside <json></json> tags:\n"
    + "<json>{\"citations\":[{\"kind\":\"case\",\"name\":\"\",\"citation\":\"\",\"pinpoint\":\"\",\"para\":\"\",\"fn\":\"\",\"proposition\":\"\",\"author\":\"\",\"title\":\"\",\"edition\":\"\",\"year\":\"\"}]}</json>\n"
    + "If there are none: <json>{\"citations\":[]}</json>\n\n"
    + (batch.context ? "EARLIER CONTEXT — the end of the previous part, ONLY for paragraph numbers and full names; do not list citations from it:\n<<<\n" + batch.context + "\n>>>\n\n" : "")
    + "TEXT:\n<<<\n" + batch.text + "\n>>>";
}

export function mergePrompt(entries) {
  var lines = entries.map(function (e) {
    var bits = [e.id, e.kind, e.name, e.citation || "-"];
    if (e.kind === "textbook") bits.push([e.author, e.title, e.edition, e.year].filter(Boolean).join(", ") || "-");
    return bits.join(" | ").replace(/\s+/g, " ");
  });
  return "Below, one per line, are the citations found in the skeleton arguments for a hearing: id | kind | name as cited | citation as cited" + " (| author, title, edition, year for textbooks).\n"
    + "Several lines may be the same authority — a short form, a repeat, or the same case cited with different reports. Group the lines so that each group is ONE authority. Put two lines together only when you are confident they are the same authority; when in doubt keep them apart. A first-instance decision and the appeal in the same case are different authorities.\n\n"
    + "For each authority give:\n"
    + "- members: the ids in the group.\n"
    + "- kind: \"case\", \"textbook\" or \"related\" (a judgment in these or related proceedings cited only for its findings or procedural history) — as given in the lines; if a group mixes \"case\" and \"related\", give \"case\".\n"
    + "- name: the fullest form of the name that appears in the group's lines. Add nothing that is not in the lines.\n"
    + "- jurisdiction (cases and related judgments): \"Cayman Islands\", \"United Kingdom\" (England and Wales, Scotland, Northern Ireland, the House of Lords, the UK Supreme Court), \"British Virgin Islands\", \"Bermuda\", \"Isle of Man\", \"Australia\", \"Hong Kong\", \"Canada\", \"United States\", or the name of any other jurisdiction. A Privy Council decision on appeal from the Cayman Islands, the British Virgin Islands or Bermuda belongs to that jurisdiction; any other Privy Council decision belongs to the United Kingdom. Decide from the court, the report series and the name; if you cannot tell, give \"Unknown\".\n"
    + "- court (cases and related judgments): e.g. \"Privy Council\", \"Court of Appeal\", \"Grand Court\" — only if apparent from the lines, else \"\".\n"
    + "- reports (cases and related judgments): each separate report or neutral citation that appears in the group's lines, one per item, exactly as written there — e.g. [\"[2003] 2 AC 1\", \"[2001] UKHL 16\"]. Put the principal law report first. NEVER add a citation that is not in the lines.\n"
    + "- author, title, edition, year (textbooks): as given in the lines.\n\n"
    + "Every id must appear in exactly one group.\n"
    + "Return ONLY this, inside <json></json> tags:\n"
    + "<json>{\"authorities\":[{\"members\":[\"E1\"],\"kind\":\"case\",\"name\":\"\",\"jurisdiction\":\"\",\"court\":\"\",\"reports\":[],\"author\":\"\",\"title\":\"\",\"edition\":\"\",\"year\":\"\"}]}</json>\n\n"
    + "LINES:\n" + lines.join("\n");
}

export function verifyPrompt(batch, passagesByKey, instancesById, skeletons) {
  var blocks = batch.map(function (a) {
    var head = "AUTHORITY " + a.key + ": " + (a.kind === "textbook" ? [a.author, a.title || a.name, a.edition ? a.edition + " ed" : "", a.year].filter(Boolean).join(", ") : a.name + (a.reports.length ? " " + a.reports.join("; ") : ""));
    var cited = a.instanceIds.map(function (id) {
      var x = instancesById[id] || {};
      var s = skeletons[x.doc] ? skeletons[x.doc].label : "";
      return "  " + id + " [" + s + ", " + (x.fn ? "fn " + x.fn : "¶" + (x.para || "?")) + "]: " + (x.proposition || "(no proposition stated)");
    }).join("\n");
    var ps = passagesByKey[a.key] || [];
    var passages = ps.length ? ps.map(function (p) { return "  " + p.pid + " — " + p.label + ":\n  «" + p.text.replace(/\s+/g, " ") + "»"; }).join("\n") : "  (none found)";
    return head + "\nPropositions as cited in the skeletons:\n" + cited + "\nPassages from OTHER documents that mention this authority:\n" + passages;
  });
  return "For each authority below:\n"
    + "1. Group the cited propositions that state the same point of law, and write each distinct point as ONE sentence. Keep different points separate.\n"
    + "2. Decide, for each distinct proposition, using ONLY the passages given for that authority:\n"
    + "   - \"supported\": a passage from another judgment or from a textbook states or applies the authority for this proposition;\n"
    + "   - \"partly\": a passage supports part of it, or a narrower version of it;\n"
    + "   - \"not_supported\": a passage describes the authority as deciding something inconsistent with it;\n"
    + "   - \"not_found\": no passage speaks to it.\n"
    + "   Disregard a passage that is from the authority itself (the decision or book being cited), and any passage from a skeleton argument, submissions, pleading, affidavit, witness statement, transcript or letter: they verify nothing.\n"
    + "3. For supported, partly and not_supported give the passage id you rely on, the pinpoint within it if one is visible (\"at [33]\", \"p.12\"), and for partly and not_supported a note of no more than 20 words saying why.\n\n"
    + "Every citation id listed under an authority must appear in exactly one of its propositions.\n"
    + "Return ONLY this, inside <json></json> tags:\n"
    + "<json>{\"results\":[{\"key\":\"A1\",\"propositions\":[{\"text\":\"\",\"instances\":[\"i1\"],\"status\":\"not_found\",\"passage\":\"\",\"pinpoint\":\"\",\"note\":\"\"}]}]}</json>\n\n"
    + blocks.join("\n\n");
}

/* ── The three views ────────────────────────────────────────────────────── */

export const VIEW_MARKER = "<!--ELJ-AUTHORITIES-VIEWS:";

var STATUS_TEXT = {
  supported: "✓ Supported",
  partly: "◐ Partly supported",
  not_supported: "✗ Not supported",
  not_found: "? Not found in other judgments or textbooks",
  unchecked: "Not checked",
  facts: "",
};

function locationText(x) {
  var s = "";
  if (x.fn) s = "fn " + x.fn + (x.para ? " (¶" + x.para + ")" : "");
  else s = x.para ? "¶" + x.para : "paragraph not identified";
  if (x.pinpoint) s += " " + x.pinpoint;
  return s;
}

function citedIn(a, ctx, onlyDoc) {
  var byDoc = {};
  var docs = [];
  a.instanceIds.forEach(function (id) {
    var x = ctx.instances[id];
    if (!x || (onlyDoc != null && x.doc !== onlyDoc)) return;
    if (!byDoc[x.doc]) { byDoc[x.doc] = []; docs.push(x.doc); }
    var t = locationText(x);
    if (byDoc[x.doc].indexOf(t) === -1) byDoc[x.doc].push(t);
  });
  docs.sort(function (p, q) { return p - q; });
  return docs.map(function (d) {
    var label = ctx.skeletons[d] ? ctx.skeletons[d].label : "Skeleton " + (d + 1);
    return (onlyDoc != null ? "" : label + " — ") + byDoc[d].join("; ");
  }).join(" · ");
}

function headline(a, n) {
  var cite = (a.reports || []).join("; ");
  if (a.kind === "textbook") {
    var t = [a.author, a.title ? "*" + a.title + "*" : "", a.edition ? "(" + a.edition + (/ed/i.test(a.edition) ? "" : " ed") + (a.year ? ", " + a.year : "") + ")" : (a.year ? "(" + a.year + ")" : "")].filter(Boolean).join(", ");
    return "**" + n + ".** " + (t || a.name);
  }
  return "**" + n + ".** *" + a.name + "* " + (cite || "[no report citation given in the skeletons]");
}

function propositionLines(a, ctx, onlyDoc) {
  return (a.propositions || []).filter(function (p) {
    return onlyDoc == null || p.instanceIds.some(function (id) { return ctx.instances[id] && ctx.instances[id].doc === onlyDoc; });
  }).map(function (p) {
    if (p.status === "facts") return "- *Cited for:* " + p.text;
    var v = STATUS_TEXT[p.status] || STATUS_TEXT.not_found;
    if (p.source) v += ": " + p.source + (p.pinpoint ? " " + p.pinpoint : "");
    if (p.note) v += " — " + p.note;
    return "- *Proposition:* " + p.text + " — " + v;
  });
}

function entry(a, n, ctx, onlyDoc) {
  var lines = [headline(a, n)];
  var where = citedIn(a, ctx, onlyDoc);
  if (where) lines.push("- *Cited " + (onlyDoc != null ? "at" : "in") + ":* " + where);
  return lines.concat(propositionLines(a, ctx, onlyDoc)).join("\n");
}

function byName(a, b) { return sortName(a.name).localeCompare(sortName(b.name)) || String(a.name).localeCompare(String(b.name)); }
function byYear(a, b) {
  var ya = a.year || 99999, yb = b.year || 99999;
  return ya - yb || byName(a, b);
}
function textbookName(a) { return sortName(a.author || a.title || a.name) + " " + sortName(a.title || a.name); }
function byTextbookName(a, b) { return textbookName(a).localeCompare(textbookName(b)); }

function header(ctx, orderLabel) {
  var lines = ["## LIST OF AUTHORITIES" + (ctx.matterName ? " — " + ctx.matterName : ""), "*Order: " + orderLabel + "*", "", "### Skeleton arguments reviewed"];
  ctx.skeletons.forEach(function (s) { lines.push("- " + s.label + (s.date ? " (" + s.date + ")" : "")); });
  lines.push("");
  lines.push("*Report citations are those given in these skeletons. Each proposition of law was checked against other judgments and textbooks in this matter and in the Library that cite the authority — never against the authority itself. ✓ supported · ◐ partly · ✗ not supported · ? not found. Judgments in these and related proceedings, cited for their findings, are listed separately and not checked.*");
  if (ctx.warnings && ctx.warnings.length) {
    lines.push("");
    ctx.warnings.forEach(function (w) { lines.push("⚠️ " + w); });
  }
  return lines.join("\n");
}

function groupedView(ctx, cmpCases, cmpBooks, orderLabel) {
  var cases = ctx.authorities.filter(function (a) { return a.kind === "case"; });
  var books = ctx.authorities.filter(function (a) { return a.kind === "textbook"; });
  var related = ctx.authorities.filter(function (a) { return a.kind === "related"; });
  var jurs = [];
  cases.forEach(function (a) { if (jurs.indexOf(a.jurisdiction) === -1) jurs.push(a.jurisdiction); });
  jurs.sort(compareJurisdictions);
  var home = jurs.filter(function (j) { return jurisdictionRank(j).section === "home"; });
  var foreign = jurs.filter(function (j) { return jurisdictionRank(j).section === "foreign"; });
  var out = [header(ctx, orderLabel)];
  function section(title, list) {
    if (!list.length) return;
    out.push("## " + title);
    list.forEach(function (j) {
      var these = cases.filter(function (a) { return a.jurisdiction === j; }).sort(cmpCases);
      out.push("### " + j);
      these.forEach(function (a, i) { out.push(entry(a, i + 1, ctx)); });
    });
  }
  section("CASES", home);
  section("FOREIGN AUTHORITIES", foreign);
  if (books.length) {
    out.push("## TEXTBOOKS");
    books.slice().sort(cmpBooks).forEach(function (a, i) { out.push(entry(a, i + 1, ctx)); });
  }
  if (related.length) {
    out.push("## JUDGMENTS IN THESE AND RELATED PROCEEDINGS (cited for their findings)");
    related.slice().sort(cmpCases).forEach(function (a, i) { out.push(entry(a, i + 1, ctx)); });
  }
  if (!cases.length && !books.length && !related.length) out.push("No citations of case law or textbooks were found in these skeletons.");
  return out.join("\n\n");
}

function citedView(ctx) {
  var out = [header(ctx, "order of citation in each skeleton")];
  ctx.skeletons.forEach(function (s, d) {
    var first = {};
    ctx.authorities.forEach(function (a) {
      a.instanceIds.forEach(function (id) {
        var x = ctx.instances[id];
        if (x && x.doc === d && (first[a.key] == null || x.order < first[a.key])) first[a.key] = x.order;
      });
    });
    var here = ctx.authorities.filter(function (a) { return first[a.key] != null; })
      .sort(function (a, b) { return first[a.key] - first[b.key]; });
    out.push("## " + s.label);
    var cases = here.filter(function (a) { return a.kind === "case"; });
    var books = here.filter(function (a) { return a.kind === "textbook"; });
    var related = here.filter(function (a) { return a.kind === "related"; });
    if (!here.length) { out.push("No citations of case law or textbooks found in this skeleton."); return; }
    if (cases.length) {
      out.push("### Cases");
      cases.forEach(function (a, i) { out.push(entry(a, i + 1, ctx, d)); });
    }
    if (books.length) {
      out.push("### Textbooks");
      books.forEach(function (a, i) { out.push(entry(a, i + 1, ctx, d)); });
    }
    if (related.length) {
      out.push("### Judgments in these and related proceedings");
      related.forEach(function (a, i) { out.push(entry(a, i + 1, ctx, d)); });
    }
  });
  return out.join("\n\n");
}

/* ctx: { matterName, skeletons: [{label, date}], authorities, instances
   (by id), warnings } */
export function buildViews(ctx) {
  return {
    alpha: groupedView(ctx, byName, byTextbookName, "alphabetical"),
    year: groupedView(ctx, byYear, function (a, b) { return (a.year || 99999) - (b.year || 99999) || byTextbookName(a, b); }, "by year of report"),
    cited: citedView(ctx),
  };
}

/* The saved result: the alphabetical view as ordinary text — so History,
   Word export and follow-ups work as for every other tool — followed by
   the other two views, base64-encoded inside an HTML comment that the
   screen lifts out (public/js/authorities_view.js) and strips before
   rendering. */
export function embedViews(views) {
  var b64 = Buffer.from(JSON.stringify({ v: 1, views: { year: views.year, cited: views.cited } }), "utf8").toString("base64");
  return views.alpha + "\n\n" + VIEW_MARKER + b64 + "-->";
}

/* The reverse, for tests and for any server-side reader. */
export function splitViews(result) {
  var s = String(result || "");
  var at = s.indexOf(VIEW_MARKER);
  if (at === -1) return { alpha: s, year: null, cited: null };
  var end = s.indexOf("-->", at);
  var alpha = s.slice(0, at).replace(/\s+$/, "");
  try {
    var obj = JSON.parse(Buffer.from(s.slice(at + VIEW_MARKER.length, end === -1 ? undefined : end), "base64").toString("utf8"));
    return { alpha: alpha, year: obj.views.year, cited: obj.views.cited };
  } catch (e) { return { alpha: alpha, year: null, cited: null }; }
}
