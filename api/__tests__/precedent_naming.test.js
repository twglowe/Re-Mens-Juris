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
