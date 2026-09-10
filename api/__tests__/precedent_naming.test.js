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
