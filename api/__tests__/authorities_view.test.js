/* v5.82 Push 3 — List of Authorities screen: the view switcher's pure half
   and the wiring in tools.js, core.js and index.html. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as A from "../lib/authorities.js";
const require = createRequire(import.meta.url);
const V = require("../../public/js/authorities_view.js");

describe("authSplit", () => {
  it("reads back exactly what embedViews wrote, with non-ASCII intact", () => {
    const views = { alpha: "## LIST — alpha ¶12 ✓", year: "## year ◐", cited: "## cited «x»" };
    const r = A.embedViews(views);
    const back = V.authSplit(r);
    expect(back.alpha).toBe(views.alpha);
    expect(back.year).toBe(views.year);
    expect(back.cited).toBe(views.cited);
    expect(V.authPrepare(r)).toBe(views.alpha);
    expect(V.AUTH_VIEW_MARKER).toBe(A.VIEW_MARKER);
  });
  it("leaves a plain result alone", () => {
    expect(V.authSplit("plain")).toEqual({ alpha: "plain", year: null, cited: null });
    expect(V.authSplit("x\n\n" + A.VIEW_MARKER + "not base64 json-->").year).toBe(null);
  });
});

describe("wiring", () => {
  const tools = fs.readFileSync(new URL("../../public/js/tools.js", import.meta.url), "utf8");
  const core = fs.readFileSync(new URL("../../public/js/core.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  const root = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  it("the tool is defined, sends its skeletons, and re-fires its own worker", () => {
    expect(tools).toMatch(/authorities:\{title:'[^']*List of Authorities'/);
    expect(tools).toMatch(/body\.authoritySkeletons=authoritySkeletons/);
    expect(tools).toMatch(/toolName==='authorities'\?'\/api\/authoritiesWorker':'\/api\/worker'/);
    expect(tools).toMatch(/citations:\{title:/);   /* kept for History replay */
  });

  it("core.js strips the embedded views before rendering and adds the switcher", () => {
    expect(core).toMatch(/content=authPrepare\(content\)/);
    expect(core).toMatch(/authDecorate\(w,bubble,rawContent/);
  });

  it("the tools bar offers the List of Authorities and not the Citation Checker; both copies identical; script before core.js", () => {
    expect(html).toBe(root);
    expect(html).toContain("openTool('authorities')");
    expect(html).not.toContain("openTool('citations')");
    expect(html.indexOf('src="/js/authorities_view.js')).toBeGreaterThan(-1);
    expect(html.indexOf('src="/js/authorities_view.js')).toBeLessThan(html.indexOf('src="/js/core.js'));
    expect(html).toMatch(/core\.js\?v=5\.82/);
    expect(html).toMatch(/tools\.js\?v=5\.82/);
  });
});
