/* EX LIBRIS JURIS v5.77 — api/lib/tighten.js
   The tighten pass. Runs once on a finished draft, briefing note or issue
   briefing, after assembly and before saving. Agreed with Tom, 24 Sep 2026.

   What it does:
     1. Splits the output into blocks (paragraphs separated by blank lines)
        and labels the ones that may be cut. Headings, the court heading and
        anything before the first heading, label lines ("**Date:** …"),
        tables, notes and the Points to check section are never labelled.
     2. One Claude call reads the labelled document and returns JSON only:
        which blocks to cut and why, and every case or textbook cited. The
        model cannot rewrite anything. It can only name whole blocks, so it
        cannot quietly change the substance or strength of an argument.
     3. The code makes the cuts. If the model asks to cut more than
        MAX_CUT_SHARE of the eligible blocks, nothing is cut and that is
        flagged instead: an aggressive pass is more likely wrong than right.
     4. Paragraphs are renumbered and "paragraph N" cross-references updated,
        but only where the original numbering ran 1, 2, 3 … without a break.
        Otherwise numbering is left alone and flagged.
     5. The authorities check is done in code, not by the model: each cited
        case or textbook is looked for in the supplied material (the system
        prompt, which carries the case law and precedents, plus the matter's
        documents). Anything not found is listed in Points to check as "not
        in supplied material".
     6. Points to check is rebuilt as one list at the end: the points already
        there, the authorities not found, cross-references to cut paragraphs,
        and the full text of every cut block so it can be put back.

   The model is not asked whether an argument is legally or factually sound:
   it has not seen the source documents in this call, so it may cut only
   repetition, commentary that does not advance the argument, speculation
   the block itself shows to be conjecture, and summaries that restate.

   Feature flag: ELJ_TIGHTEN=off. It is also off whenever ELJ_STYLE_GUIDE is
   off, since Points to check belongs to the guide. */

export const TIGHTEN_MAX_TOKENS = 4000;
export const MAX_CUT_SHARE = 0.25;
/* Vercel's ceiling is 800s. Do not start the pass after this point in a run. */
export const TIGHTEN_TIME_BUDGET_MS = 600000;

const TOOL_LABELS = { draft: "legal drafting document", briefing: "briefing note", issueBriefing: "issue briefing" };

export function tightenEnabled(env) {
  const e = env || {};
  const off = function (v) { return String(v || "").trim().toLowerCase() === "off"; };
  return !off(e.ELJ_TIGHTEN) && !off(e.ELJ_STYLE_GUIDE);
}

/* ── Blocks ─────────────────────────────────────────────────────────── */

const POINTS_HEAD = /^(?:#{1,6}[ \t]*)?\**[ \t]*points to check\b/i;
const TOP_NUM = /^([ \t]*(?:\*\*)?)(\d{1,4})(\.(?:\*\*)?[ \t]+\S)/;
const SUB_NUM = /^([ \t]*(?:\*\*)?)(\d{1,4})(\.\d{1,3})/;

/* Split into content blocks, keeping each block's following separator so
   the text can be rebuilt byte for byte. */
export function splitBlocks(text) {
  const parts = String(text || "").split(/(\n[ \t]*\n+)/);
  const blocks = [];
  for (let i = 0; i < parts.length; i += 2) {
    blocks.push({ text: parts[i], sep: parts[i + 1] || "" });
  }
  let seenHeading = false;
  let inPoints = false;
  let n = 0;
  for (const b of blocks) {
    const first = b.text.replace(/^\s+/, "").split("\n")[0] || "";
    const isHeading = /^#{1,6}\s/.test(first);
    if (POINTS_HEAD.test(first)) inPoints = true;
    b.points = inPoints;
    b.eligible = seenHeading && !inPoints && !isHeading && first.trim().length > 0 &&
      !/^(>|---|═|\|)/.test(first.trim()) &&
      !/^\*\*[^*\n]{1,40}:\*\*/.test(first.trim());
    if (isHeading) seenHeading = true;
    if (b.eligible) { n++; b.label = "B" + n; }
  }
  return blocks;
}

function joinBlocks(blocks) {
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    out += blocks[i].text + (i < blocks.length - 1 ? (blocks[i].sep || "\n\n") : "");
  }
  return out;
}

/* ── Model reply ────────────────────────────────────────────────────── */

export function parseTightenReply(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim();
  if (t.indexOf("```") === 0) {
    const nl = t.indexOf("\n");
    t = nl === -1 ? "" : t.slice(nl + 1);
    const lf = t.lastIndexOf("```");
    if (lf !== -1) t = t.slice(0, lf);
  }
  let p;
  try { p = JSON.parse(t.trim()); }
  catch (e) {
    /* A sentence either side of the JSON: take the outermost braces. */
    const a = t.indexOf("{"), z = t.lastIndexOf("}");
    if (a === -1 || z <= a) return null;
    try { p = JSON.parse(t.slice(a, z + 1)); } catch (e2) { return null; }
  }
  if (!p || typeof p !== "object") return null;
  const str = function (v) { return typeof v === "string" ? v.trim() : ""; };
  const cuts = (Array.isArray(p.cuts) ? p.cuts : [])
    .map(function (c) { return { block: str(c && c.block).toUpperCase(), reason: str(c && c.reason) }; })
    .filter(function (c) { return /^B\d+$/.test(c.block); });
  const authorities = (Array.isArray(p.authorities) ? p.authorities : [])
    .map(function (a) { return { name: str(a && a.name), citation: str(a && a.citation), block: str(a && a.block).toUpperCase() }; })
    .filter(function (a) { return a.name || a.citation; });
  return { cuts: cuts, authorities: authorities };
}

/* ── Authorities check ──────────────────────────────────────────────── */

export function normalise(s) {
  return " " + String(s || "").toLowerCase().replace(/[*_]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " ";
}

/* True if the authority can be found in the supplied material: by its
   citation, by its full name, or (for "A v B") by both party names. A bare
   "Re X" is looked for as X. Short strings are not trusted to match. */
export function authorityFound(a, haystackNorm) {
  const cit = normalise(a.citation);
  if (cit.trim().length >= 6 && haystackNorm.indexOf(cit) !== -1) return true;
  const name = normalise(a.name).replace(/^ (?:re|in re|in the matter of) /, " ");
  if (name.trim().length >= 6 && haystackNorm.indexOf(name) !== -1) return true;
  const vs = normalise(a.name).split(" v ");
  if (vs.length === 2) {
    const p1 = " " + vs[0].trim() + " ";
    const p2 = " " + vs[1].trim() + " ";
    if (p1.trim().length >= 4 && p2.trim().length >= 4 &&
        haystackNorm.indexOf(p1) !== -1 && haystackNorm.indexOf(p2) !== -1) return true;
  }
  return false;
}

/* ── Numbering ──────────────────────────────────────────────────────── */

function firstTopNumber(blockText) {
  const lines = blockText.split("\n");
  for (const l of lines) {
    const m = l.match(TOP_NUM);
    if (m) return parseInt(m[2], 10);
  }
  return null;
}

/* Where a block sits, for a Points to check line: "para 12", or the nearest
   heading, or "section" as a last resort. */
function whereIs(blocks, idx) {
  const n = firstTopNumber(blocks[idx].text);
  if (n !== null) return "para " + n;
  for (let j = idx; j >= 0; j--) {
    const first = blocks[j].text.replace(/^\s+/, "").split("\n")[0] || "";
    if (/^#{1,6}\s/.test(first)) return "under \"" + first.replace(/^#{1,6}\s+/, "").trim() + "\"";
  }
  return "section";
}

/* Top-level paragraph numbers in body order. */
function topNumbers(blocks) {
  const nums = [];
  for (const b of blocks) {
    if (b.points) continue;
    for (const l of b.text.split("\n")) {
      const m = l.match(TOP_NUM);
      if (m) nums.push(parseInt(m[2], 10));
    }
  }
  return nums;
}

function isContinuous(nums) {
  if (nums.length === 0) return false;
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) return false;
  return true;
}

const XREF = /\b(paragraphs?|paras?\.?)(\s+)(\d{1,4}(?:\.\d{1,3})?(?:\s*(?:,|and|to|-|–)\s*\d{1,4}(?:\.\d{1,3})?)*)/gi;

/* Rewrite "paragraph N" references through map (old top-level → new).
   References to a number in `gone` are left as written and reported. */
export function rewriteXrefs(text, map, gone, report) {
  return String(text || "").replace(XREF, function (all, word, space, list) {
    const newList = list.replace(/\d{1,4}(?:\.\d{1,3})?/g, function (num) {
      const top = parseInt(num.split(".")[0], 10);
      const rest = num.indexOf(".") !== -1 ? num.slice(num.indexOf(".")) : "";
      if (gone && gone.has(top)) { if (report) report.push(top); return num; }
      return map.has(top) ? String(map.get(top)) + rest : num;
    });
    return word + space + newList;
  });
}

function renumberLine(line, map) {
  let m = line.match(SUB_NUM);
  if (m && map.has(parseInt(m[2], 10))) return m[1] + map.get(parseInt(m[2], 10)) + line.slice(m[1].length + m[2].length);
  m = line.match(TOP_NUM);
  if (m && map.has(parseInt(m[2], 10))) return m[1] + map.get(parseInt(m[2], 10)) + line.slice(m[1].length + m[2].length);
  return line;
}

/* ── Points to check ────────────────────────────────────────────────── */

function existingPoints(blocks) {
  const items = [];
  for (const b of blocks) {
    if (!b.points) continue;
    for (const l of b.text.split("\n")) {
      const t = l.trim();
      if (!t || POINTS_HEAD.test(t) || /^\*not for filing\.?\*$/i.test(t) || /^#{1,6}\s/.test(t)) continue;
      const item = t.replace(/^(?:[-*•]|\d+[.)])[ \t]+/, "").trim();
      if (item) items.push(item);
    }
  }
  return items;
}

export function buildPointsSection(points, cutNotes) {
  const seen = new Set();
  const uniq = [];
  for (const p of points) {
    const k = p.toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(k)) { seen.add(k); uniq.push(p); }
  }
  if (uniq.length === 0 && cutNotes.length === 0) return "";
  let s = "## Points to check\n\n*Not for filing.*";
  if (uniq.length) s += "\n\n" + uniq.map(function (p) { return "- " + p; }).join("\n");
  if (cutNotes.length) {
    s += "\n\n### Cut by the tighten pass\n\nThese paragraphs were removed from the body. Put back any you want to keep.\n\n" +
      cutNotes.map(function (c) { return "- " + c.where + " (" + (c.reason || "no reason given") + "):\n\n" + c.text.split("\n").map(function (l) { return "  > " + l; }).join("\n"); }).join("\n\n");
  }
  return s;
}

/* ── The pass ───────────────────────────────────────────────────────── */

export function buildTightenPrompt(toolName, labelled, instructions) {
  const what = TOOL_LABELS[toolName] || "document";
  return "Below is a finished " + what + ", split into blocks. Blocks marked [Bn] may be cut. Unmarked blocks are fixed.\n\n" +
    (instructions ? "WHAT THE DOCUMENT WAS ASKED TO DO: " + instructions + "\n\n" : "") +
    "Return ONLY a JSON object, no preamble and no code fences:\n" +
    "{\"cuts\":[{\"block\":\"B7\",\"reason\":\"repeats B3\"}],\"authorities\":[{\"name\":\"Smith v Jones\",\"citation\":\"[2009] UKPC 34\",\"block\":\"B3\"}]}\n\n" +
    "PART 1: CUTS. Cut a marked block only if it:\n" +
    "  (a) repeats a point already made in an earlier block;\n" +
    "  (b) is general commentary, background, or a list of possible risks that does not advance the document's argument (or, for a briefing, its assessment);\n" +
    "  (c) is speculative: it argues from something the block itself shows to be conjecture;\n" +
    "  (d) is a closing summary that restates earlier blocks.\n" +
    "Do not cut a block because you think it is weak on the law or the facts: you have not seen the source documents. Do not cut the only statement of a point. Cut no more than a quarter of the marked blocks. You cannot edit wording, only cut whole blocks. If nothing qualifies, return an empty cuts list. Give each reason in a few words.\n\n" +
    "PART 2: AUTHORITIES. List every case, law report and textbook cited anywhere in the document, with the block it appears in (\"\" if unmarked). Copy the name and citation exactly as written. Do not list statutes or rules of court.\n\n" +
    "DOCUMENT:\n\n" + labelled;
}

export async function tightenDraft(runTool, systemBase, toolName, text, suppliedText, opts) {
  const o = opts || {};
  const blocks = splitBlocks(text);
  const eligible = blocks.filter(function (b) { return b.eligible; });
  const labelled = blocks.map(function (b) { return b.eligible ? "[" + b.label + "] " + b.text : b.text; }).join("\n\n");

  const r = await runTool(systemBase, buildTightenPrompt(toolName, labelled, o.instructions), TIGHTEN_MAX_TOKENS);
  const reply = parseTightenReply(r.text);
  if (!reply) throw new Error("Tighten pass reply was not valid JSON");

  const points = existingPoints(blocks);
  const byLabel = {};
  blocks.forEach(function (b, i) { if (b.label) byLabel[b.label] = i; });

  /* Authorities: checked in code against the supplied material. */
  const hay = normalise(suppliedText);
  const seenAuth = new Set();
  for (const a of reply.authorities) {
    const key = normalise(a.name + " " + a.citation);
    if (seenAuth.has(key)) continue;
    seenAuth.add(key);
    if (authorityFound(a, hay)) continue;
    const idx = byLabel[a.block];
    const where = idx !== undefined ? whereIs(blocks, idx) : "";
    points.push((where ? where + ": " : "") + (a.name || "") + (a.citation ? " " + a.citation : "") + " (not in supplied material)");
  }

  /* Cuts. */
  const cutIdx = new Set();
  const reasons = {};
  for (const c of reply.cuts) {
    if (byLabel[c.block] !== undefined) { cutIdx.add(byLabel[c.block]); reasons[byLabel[c.block]] = c.reason; }
  }
  let cutNotes = [];
  if (cutIdx.size > 0 && cutIdx.size > Math.floor(eligible.length * MAX_CUT_SHARE)) {
    points.push("Tighten pass proposed cutting " + cutIdx.size + " of " + eligible.length + " paragraphs; none were cut. Review the length yourself.");
    cutIdx.clear();
  }

  /* A cut paragraph takes its own sub-paragraphs with it (5.1, 5.2 …) where
     they sit in blocks of their own; otherwise they would be left orphaned. */
  for (const i of Array.from(cutIdx)) {
    const n = firstTopNumber(blocks[i].text);
    if (n === null) continue;
    for (let j = i + 1; j < blocks.length && blocks[j].eligible; j++) {
      const first = blocks[j].text.replace(/^\s+/, "").split("\n")[0] || "";
      const m = first.match(SUB_NUM);
      if (!m || parseInt(m[2], 10) !== n) break;
      cutIdx.add(j);
      reasons[j] = "sub-paragraph of a cut paragraph";
    }
  }

  let kept = blocks;
  if (cutIdx.size > 0) {
    const before = topNumbers(blocks);
    const gone = new Set();
    blocks.forEach(function (b, i) {
      if (!cutIdx.has(i)) return;
      cutNotes.push({ where: whereIs(blocks, i), reason: reasons[i], text: b.text.trim() });
      for (const l of b.text.split("\n")) { const m = l.match(TOP_NUM); if (m) gone.add(parseInt(m[2], 10)); }
    });
    kept = blocks.filter(function (b, i) { return !cutIdx.has(i); });

    const map = new Map();
    if (gone.size > 0) {
      if (isContinuous(before)) {
        let next = before[0];
        for (const n of before) { if (!gone.has(n)) map.set(n, next++); }
        const broken = [];
        kept = kept.map(function (b) {
          if (b.points) return b;
          const lines = b.text.split("\n").map(function (l) { return renumberLine(l, map); });
          return Object.assign({}, b, { text: rewriteXrefs(lines.join("\n"), map, gone, broken) });
        });
        for (let i = 0; i < points.length; i++) points[i] = rewriteXrefs(points[i], map, null, null);
        for (const n of new Set(broken)) points.push("A cross-reference points to paragraph " + n + ", which the tighten pass cut. Check it.");
        /* Cut notes keep their original numbers, so say so. */
        cutNotes = cutNotes.map(function (c) { return Object.assign({}, c, { where: c.where.replace(/^para /, "was para ") }); });
      } else {
        points.push("Paragraph numbering was not adjusted after the tighten pass cut paragraphs, because the original numbering was not continuous. Check the numbering.");
      }
    }
  }

  const body = joinBlocks(kept.filter(function (b) { return !b.points; })).replace(/\s+$/, "");
  const pointsSection = buildPointsSection(points, cutNotes);

  return {
    text: body + (pointsSection ? "\n\n" + pointsSection : ""),
    cut: cutNotes.length,
    unverified: points.length,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cost: r.cost,
  };
}

/* Add one line to the Points to check list without a model call, e.g. to
   record that the pass was skipped. */
export function appendPoint(text, point) {
  const blocks = splitBlocks(text);
  const points = existingPoints(blocks);
  points.push(point);
  const body = joinBlocks(blocks.filter(function (b) { return !b.points; })).replace(/\s+$/, "");
  return body + "\n\n" + buildPointsSection(points, []);
}
