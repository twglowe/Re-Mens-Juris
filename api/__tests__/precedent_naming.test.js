/* v5.65 — keeping matter names out of the Precedent Library.

   libMatchingMatterName lives in public/js/library.js, which is a browser
   script with no exports and plenty of DOM at the top level. The two pure
   functions are lifted out of the source and evaluated on their own, so the
   test runs against the same text the app ships. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../../public/js/library.js", import.meta.url), "utf8");

function lift(name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found in library.js");
  /* functions here are flat, so the first line starting with "}" ends it */
  const end = src.indexOf("\n}", start);
  return src.slice(start, end + 2);
}

const ctx = { matters: [] };
// eslint-disable-next-line no-new-func
new Function("ctx", lift("libNormaliseName") + lift("libMatchingMatterName") +
  "ctx.libNormaliseName = libNormaliseName; ctx.libMatchingMatterName = libMatchingMatterName;" +
  "Object.defineProperty(globalThis,'matters',{get:()=>ctx.matters,configurable:true});")(ctx);
const { libNormaliseName, libMatchingMatterName } = ctx;

describe("libNormaliseName", () => {
  it("strips case and punctuation", () => {
    expect(libNormaliseName("Tianrui v China Shanshui")).toBe("tianruivchinashanshui");
    expect(libNormaliseName("51 Jobs (Appeal)")).toBe("51jobsappeal");
    expect(libNormaliseName(null)).toBe("");
  });
});

describe("libMatchingMatterName", () => {
  it("catches a precedent named after a matter, either way round", () => {
    ctx.matters = [{ name: "Tianrui v China Shanshui" }];
    /* the suggestion is a fragment of the matter */
    expect(libMatchingMatterName("Tianrui")).toBe("Tianrui v China Shanshui");
    /* the suggestion is the whole matter name, differently punctuated */
    expect(libMatchingMatterName("TIANRUI — v — China Shanshui")).toBe("Tianrui v China Shanshui");
  });

  it("catches the three that prompted this", () => {
    ctx.matters = [
      { name: "Tianrui v China Shanshui" },
      { name: "Thalassa Holdings" },
      { name: "51 Jobs Appeal" },
    ];
    expect(libMatchingMatterName("Thalassa")).toBe("Thalassa Holdings");
    expect(libMatchingMatterName("51 Jobs Appeal")).toBe("51 Jobs Appeal");
  });

  it("leaves a genuine template name alone", () => {
    ctx.matters = [{ name: "Tianrui v China Shanshui" }, { name: "Thalassa Holdings" }];
    ["Skeleton Argument — unfair prejudice petition",
     "Winding-up Petition — insolvency",
     "First Affidavit — freezing injunction application",
    ].forEach((n) => expect(libMatchingMatterName(n)).toBe(""));
  });

  it("ignores names too short to mean anything", () => {
    /* a two-letter matter would otherwise match nearly every template */
    ctx.matters = [{ name: "AB" }];
    expect(libMatchingMatterName("Skeleton Argument")).toBe("");
    ctx.matters = [{ name: "Thalassa Holdings" }];
    expect(libMatchingMatterName("Re")).toBe("");
  });

  it("copes with no matters loaded", () => {
    ctx.matters = [];
    expect(libMatchingMatterName("Anything At All")).toBe("");
  });
});

describe("renaming", () => {
  const lib = fs.readFileSync(new URL("../library.js", import.meta.url), "utf8");

  it("update_precedent accepts a name — nothing could rename a precedent before", () => {
    const upd = lib.slice(lib.indexOf('action === "update_precedent"'), lib.indexOf('action === "create_precedent"'));
    expect(upd).toMatch(/typeof name === "string" && name\.trim\(\)/);
    expect(upd).toMatch(/updates\.name = name\.trim\(\)/);
  });

  it("ignores a blank rather than wiping a NOT NULL column", () => {
    const upd = lib.slice(lib.indexOf('action === "update_precedent"'), lib.indexOf('action === "create_precedent"'));
    /* the guard is on the truthiness of the trimmed value, so "" is skipped */
    expect(upd).not.toMatch(/if \(name !== undefined\) updates\.name/);
  });

  it("the panel sends the name and refuses to save it empty", () => {
    const save = src.slice(src.indexOf("async function libSavePrecedentChanges"), src.indexOf("action:'update_precedent'"));
    expect(save).toMatch(/libPrecName/);
    expect(save).toMatch(/Give the precedent a name/);
    expect(save).toMatch(/libMatchingMatterName\(newName\)/);
  });

  it("suggests from the stored chunks, sharing one prompt with the upload path", () => {
    expect(src).toMatch(/var PREC_NAME_PROMPT=/);
    /* One definition and no second copy of the text — that is the property
       worth holding. Counting callers only breaks when one is added. */
    expect((src.match(/var PREC_NAME_PROMPT=/g) || []).length).toBe(1);
    expect((src.match(/REUSABLE PRECEDENT/g) || []).length).toBe(1);
    const sug = src.slice(src.indexOf("async function libSuggestPrecedentName"), src.indexOf("v5.65: keep matter names out"));
    expect(sug).toMatch(/type=prec_chunks/);
    expect(sug).toMatch(/libMatchingMatterName\(suggested\)/);
  });

  it("puts a suggestion in the box rather than saving it", () => {
    const sug = src.slice(src.indexOf("async function libSuggestPrecedentName"), src.indexOf("v5.65: keep matter names out"));
    expect(sug).toMatch(/nameBox\.value=suggested/);
    expect(sug).not.toMatch(/update_precedent/);
  });
});

describe("the naming prompt", () => {
  it("no longer asks for the case name", () => {
    /* This instruction is what filed precedents under their matter's name. */
    expect(src).not.toMatch(/this should be the case name/);
  });

  it("asks for a generic template name and forbids party names", () => {
    expect(src).toContain("REUSABLE PRECEDENT");
    expect(src).toMatch(/NEVER use party names, case names, company names or matter names/);
    expect(src).toContain("Skeleton Argument — unfair prejudice petition");
  });

  it("discards a suggestion that names a matter, rather than offering it", () => {
    expect(src).toMatch(/var clash=libMatchingMatterName\(suggested\)/);
    expect(src).toContain("Suggestion discarded");
  });

  it("challenges a hand-typed matter name at save", () => {
    const save = src.slice(src.indexOf("async function precUploadSave"), src.indexOf("var btn=document.getElementById('precUpSaveBtn')"));
    expect(save).toMatch(/libMatchingMatterName\(name\)/);
    expect(save).toMatch(/confirm\(/);
  });
});

/* v5.65 — the source matter. The name used to carry which matter a precedent
   came from; that link now has a column, and it is what the AI reads to judge
   the precedent's context. */
describe("source matter", () => {
  const worker = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const lib = fs.readFileSync(new URL("../library.js", import.meta.url), "utf8");

  it("is stored on upload, and only for a matter the caller can reach", () => {
    expect(lib).toMatch(/source_matter_id: sourceMatterId/);
    expect(lib).toMatch(/async function resolveSourceMatter/);
    /* owner or sharer, checked server-side — the service key bypasses RLS */
    const fn = lib.slice(lib.indexOf("async function resolveSourceMatter"), lib.indexOf("const SERVER_VERSION"));
    expect(fn).toContain("owner_id");
    expect(fn).toContain("matter_shares");
    expect(fn).toMatch(/if \(!matterId\) return null/);
  });

  it("can be set or cleared afterwards from the precedent panel", () => {
    const upd = lib.slice(lib.indexOf('action === "update_precedent"'), lib.indexOf('action === "create_precedent"'));
    expect(upd).toMatch(/source_matter_id !== undefined/);
    expect(upd).toMatch(/resolveSourceMatter/);
  });

  it("reaches the drafting prompt with the matter's nature and issues", () => {
    const block = worker.slice(worker.indexOf("v5.65: the matter this precedent was written for"),
                               worker.indexOf("Author instructions"));
    expect(block).toMatch(/\.from\("matters"\)/);
    expect(block).toMatch(/select\("name, nature, issues, jurisdiction"\)/);
    expect(block).toContain("Written for the matter");
    expect(block).toContain("That dispute:");
    expect(block).toContain("Its issues:");
  });

  it("tells the model to learn from the context, not copy it blind", () => {
    expect(worker).toContain("learn how it met that situation");
    expect(worker).toMatch(/say so if the present draft's facts differ/);
  });

  it("still drafts if the migration has not been run", () => {
    /* select() naming a column that does not exist is rejected outright, so
       the read falls back rather than failing the whole draft. */
    expect(worker).toMatch(/source_matter_id\/i\.test/);
  });

  it("never lets a failed lookup break the draft", () => {
    const block = worker.slice(worker.indexOf("v5.65: the matter this precedent was written for"),
                               worker.indexOf("Author instructions"));
    expect(block).toMatch(/catch \(e\)/);
  });
});

/* v5.67 — the bulk tidy. A one-off clear-up for the entries filed under a
   matter's name before the prompt was fixed. */
describe("bulk tidy", () => {
  it("offers only matter-named precedents until asked for the rest", () => {
    const open = src.slice(src.indexOf("function libTidyOpen"), src.indexOf("function libTidyRender"));
    expect(open).toMatch(/libMatchingMatterName\(p\.name\)/);
    expect(open).toMatch(/if\(!matter&&!libTidyShowAll\)return null/);
  });

  it("flags entries sharing a name, since this library has duplicate uploads", () => {
    const open = src.slice(src.indexOf("function libTidyOpen"), src.indexOf("function libTidyRender"));
    expect(open).toContain("duplicate name");
    expect(open).toMatch(/libNormaliseName\(r\.original\)/);
  });

  it("suggests in sequence, not all at once", () => {
    const sug = src.slice(src.indexOf("async function libTidySuggestAll"), src.indexOf("async function libTidyApply"));
    expect(sug).toMatch(/for\s*\(var i=0;i<todo\.length/);
    expect(sug).toMatch(/await api/);
    /* a burst of parallel analyse calls buys nothing for a handful of docs */
    expect(sug).not.toMatch(/Promise\.all/);
  });

  it("uses the shared prompt rather than a copy of its own", () => {
    const sug = src.slice(src.indexOf("async function libTidySuggestAll"), src.indexOf("async function libTidyApply"));
    expect(sug).toContain("PREC_NAME_PROMPT");
    expect(sug).not.toContain("REUSABLE PRECEDENT");
  });

  it("saves the new name and the source matter together", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply).toMatch(/action:'update_precedent'/);
    expect(apply).toMatch(/name:r\.proposed\.trim\(\)/);
    expect(apply).toMatch(/source_matter_id:matterId\|\|null/);
  });

  it("skips a row with no name rather than saving a blank", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply).toMatch(/r\.action==='rename'&&r\.proposed\.trim\(\)/);
  });

  it("stops at the first failure and says how many were done", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply).toMatch(/Stopped at/);
    expect(apply).toMatch(/renamed\+' renamed, '\+removed\+' deleted\.'/);
  });

  it("challenges a proposed name that still carries a matter name", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply).toMatch(/stillNamed/);
    expect(apply).toMatch(/confirm\(/);
  });
});

/* v5.68 — deleting from the tidy. */
describe("deleting a precedent", () => {
  const lib = fs.readFileSync(new URL("../library.js", import.meta.url), "utf8");

  it("removes the stored text before the row", () => {
    const del = lib.slice(lib.indexOf('action === "delete_precedent"'), lib.indexOf('action === "delete_section"'));
    const chunksAt = del.indexOf("precedent_chunks");
    const docsAt = del.indexOf('from("precedent_docs")');
    expect(chunksAt).toBeGreaterThan(-1);
    /* order matters: an orphaned chunk still feeds the drafting prompt */
    expect(chunksAt).toBeLessThan(docsAt);
  });

  it("scopes both deletes to the caller", () => {
    const del = lib.slice(lib.indexOf('action === "delete_precedent"'), lib.indexOf('action === "delete_section"'));
    expect((del.match(/eq\("user_id", user\.id\)/g) || []).length).toBe(2);
  });

  it("reports a failure to clear the text rather than deleting the row anyway", () => {
    const del = lib.slice(lib.indexOf('action === "delete_precedent"'), lib.indexOf('action === "delete_section"'));
    expect(del).toMatch(/if \(chErr\) return res\.status\(500\)/);
  });

  it("offers rename, delete and leave alone, defaulting to rename", () => {
    const open = src.slice(src.indexOf("function libTidyOpen"), src.indexOf("function libTidyRender"));
    /* a matched row defaults to rename; an unmatched one to leave alone */
    expect(open).toMatch(/action:matter\?'rename':'leave'/);
    const set = src.slice(src.indexOf("function libTidySetAction"), src.indexOf("function libTidyEdit"));
    expect(set).toMatch(/v==='delete'\|\|v==='leave'/);
  });

  it("confirms a deletion by name before doing it", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply).toMatch(/deletes\.map/);
    expect(apply).toMatch(/cannot be undone/);
    expect(apply).toMatch(/upload them again/);
  });

  it("renames before it deletes, and reports both counts on a failure", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply.indexOf("for(var i=0;i<renames.length")).toBeLessThan(apply.indexOf("for(var k=0;k<deletes.length"));
    expect(apply).toMatch(/renamed\+' renamed, '\+removed\+' deleted\.'/);
  });

  it("only suggests names for rows being renamed", () => {
    const sug = src.slice(src.indexOf("async function libTidySuggestAll"), src.indexOf("async function libTidyApply"));
    expect(sug).toMatch(/r\.action==='rename'/);
  });
});

/* v5.69 — several precedents at once, each from its own matter. */
describe("multi-file precedent upload", () => {
  it("branches on how many files were chosen, leaving one file as it was", () => {
    const chg = src.slice(src.indexOf("async function precUpFileChanged"), src.indexOf("async function libCreatePrecedent"));
    expect(chg).toMatch(/if\(input\.files\.length>1\)/);
    /* the single-file path still runs to the end, unchanged */
    expect(chg).toMatch(/precUpMulti=\[\];\s*precUpShowSingleRows\(true\);/);
  });

  it("gives every file its own name and matter, defaulting to the open one", () => {
    const chg = src.slice(src.indexOf("async function precUpFileChanged"), src.indexOf("async function libCreatePrecedent"));
    expect(chg).toMatch(/currentMatter\.id/);
    const render = src.slice(src.indexOf("function precUpRenderMulti"), src.indexOf("function precUpMultiEdit"));
    expect(render).toMatch(/From which matter/);
    expect(render).toMatch(/precUpMultiEdit\('\+i\+',\\'matterId\\'/);
  });

  it("hides the single Name and matter rows when there are several", () => {
    const show = src.slice(src.indexOf("function precUpShowSingleRows"), src.indexOf("function precUpRenderMulti"));
    expect(show).toContain("precUpSingleNameRow");
    expect(show).toContain("precUpSingleMatterRow");
  });

  it("suggests each name with the one shared prompt", () => {
    const sug = src.slice(src.indexOf("async function precUpSuggestEach"), src.indexOf("async function precUploadSaveMulti"));
    expect(sug).toContain("PREC_NAME_PROMPT");
    expect(sug).toMatch(/libMatchingMatterName\(suggested\)/);
    /* skip a file the user has already named */
    expect(sug).toMatch(/if\(r\.name\.trim\(\)\)continue/);
  });

  it("uploads in sequence and sends each file's own matter", () => {
    const save = src.slice(src.indexOf("async function precUploadSaveMulti"));
    expect(save).toMatch(/for\s*\(var i=0;i<precUpMulti\.length/);
    expect(save).toMatch(/fd\.append\('source_matter_id',r\.matterId\|\|''\)/);
    expect(save).not.toMatch(/Promise\.all/);
  });

  it("refuses to upload anything unnamed, and says how many", () => {
    const save = src.slice(src.indexOf("async function precUploadSaveMulti"));
    expect(save).toMatch(/unnamed\.length/);
    expect(save).toMatch(/still blank/);
  });

  it("stops at a failure and reports how many are already in", () => {
    const save = src.slice(src.indexOf("async function precUploadSaveMulti"));
    expect(save).toMatch(/done\+' of '\+precUpMulti\.length\+' uploaded/);
    expect(save).toMatch(/Stopped at/);
  });

  it("routes Save to whichever mode is in play", () => {
    const at = src.indexOf("async function precUploadSave(){");
    expect(at).toBeGreaterThan(-1);
    /* the routing is the first thing the function does */
    expect(src.slice(at, at + 200)).toMatch(/if\(precUpIsMulti\(\)\)return precUploadSaveMulti\(\)/);
  });

  it("no longer offers a case name as the example to follow", () => {
    const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    expect(html).not.toContain("Skeleton — ABC v DEF (2024)");
  });
});

/* v5.70 — Tidy can reach the whole library. Scoping it to matter-named
   entries meant a stray upload named after a company that was never a matter
   never appeared, so it could not be deleted here. */
describe("tidy scope", () => {
  it("hides unmatched precedents by default, and lists them on request", () => {
    const open = src.slice(src.indexOf("function libTidyOpen"), src.indexOf("function libTidyRender"));
    expect(open).toMatch(/if\(!matter&&!libTidyShowAll\)return null/);
  });

  it("leaves an unmatched precedent alone by default rather than renaming it", () => {
    const open = src.slice(src.indexOf("function libTidyOpen"), src.indexOf("function libTidyRender"));
    expect(open).toMatch(/action:matter\?'rename':'leave'/);
  });

  it("offers the toggle even when the matched list is empty", () => {
    const render = src.slice(src.indexOf("function libTidyRender"), src.indexOf("function libTidySetAction"));
    const empty = render.slice(render.indexOf("if(!libTidyRows.length)"), render.indexOf("var scope="));
    expect(empty).toContain("libTidySetShowAll");
  });

  it("says so when a row has no matter, rather than showing a blank", () => {
    const render = src.slice(src.indexOf("function libTidyRender"), src.indexOf("function libTidySetAction"));
    expect(render).toContain("no matter matched");
  });

  it("keeps the chosen scope when reopened after an apply", () => {
    const apply = src.slice(src.indexOf("async function libTidyApply"));
    expect(apply).toMatch(/libTidyOpen\(true\)/);
    /* opening it fresh from the button starts narrow again */
    const open = src.slice(src.indexOf("function libTidyOpen"), src.indexOf("function libTidyRender"));
    expect(open).toMatch(/if\(!keepScope\)libTidyShowAll=false/);
  });
});
