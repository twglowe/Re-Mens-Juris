/* v5.73 — the upload must never send the user round in a circle.

   Reported failure, roughly one file in six: the picker shows a filename,
   Upload says "Enter the case or textbook name", typing one gets "Choose a
   file first", and re-picking says it cannot read the file. The cause was a
   failed read leaving the app with no text while the picker still displayed
   the file, and the name being demanded before the real problem was said.

   public/js/library.js is a browser script, so these read the source. The
   behaviour itself is driven in a headless browser. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../../public/js/library.js", import.meta.url), "utf8");
const upload = src.slice(src.indexOf("async function clUpload(){"), src.indexOf("async function clDelete"));
const changed = src.slice(src.indexOf("async function clFileChanged"), src.indexOf("async function clSubjectAdd"));

describe("the file is checked before the name", () => {
  it("clUpload reports a missing file before demanding a name", () => {
    const fileAt = upload.indexOf("!clPendingText");
    const nameAt = upload.indexOf("Enter the case or textbook name");
    expect(fileAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(-1);
    expect(fileAt).toBeLessThan(nameAt);
  });

  it("clUpload repeats why the read failed rather than saying to choose a file", () => {
    expect(upload).toMatch(/showToast\(clReadFailure\|\|'Choose a file first'\)/);
  });

  it("clUploadSet checks the file first too", () => {
    const set = src.slice(src.indexOf("async function clUploadSet"), src.indexOf("async function clRetrySet"));
    const fileAt = set.indexOf("!clPendingPages");
    const nameAt = set.indexOf("Give every ticked authority a name");
    expect(fileAt).toBeLessThan(nameAt);
  });
});

describe("a failed read leaves honest state", () => {
  it("clears the picker, so it cannot show a file the app does not hold", () => {
    const fn = src.slice(src.indexOf("function clReadFailed"), src.indexOf("async function clFileChanged"));
    expect(fn).toMatch(/if\(input\)input\.value=''/);
    expect(fn).toMatch(/clPendingText=null/);
    expect(fn).toMatch(/clReadFailure=message/);
  });

  it("routes every read failure through it", () => {
    /* wrong file type, a throw from the extractor, and the length check —
       which covers no text and too little text in one call */
    expect((changed.match(/clReadFailed\(input,/g) || []).length).toBe(3);
  });

  it("distinguishes nothing at all from too little", () => {
    expect(changed).toMatch(/No text came out of/);
    expect(changed).toMatch(/Only '\+got\+' characters came out of/);
  });

  it("names the file in the message", () => {
    expect(changed).toMatch(/Could not read '\+file\.name/);
  });
});

describe("the name is offered whatever happens to the read", () => {
  it("fills it from the filename before extraction is attempted", () => {
    const fillAt = changed.indexOf("nameField.value=file.name.replace");
    const readAt = changed.indexOf("await extractDocxText(file)");
    expect(fillAt).toBeGreaterThan(-1);
    expect(fillAt).toBeLessThan(readAt);
  });

  it("never overwrites a name already typed", () => {
    expect(changed).toMatch(/if\(nameField&&!nameField\.value\.trim\(\)\)/);
  });
});

describe("a single authority is named too", () => {
  it("asks for its heading rather than settling for the filename", () => {
    const fn = src.slice(src.indexOf("async function clNameSingle"), src.indexOf("async function clDetectSegments"));
    expect(fn).toMatch(/action:'name_case_law_segments'/);
    expect(fn).toMatch(/clUpCitation/);
  });

  it("may replace a filename guess, but never a name the user typed", () => {
    const fn = src.slice(src.indexOf("async function clNameSingle"), src.indexOf("async function clDetectSegments"));
    /* a filename is often fine, so it stands unless a heading beats it */
    expect(fn).toMatch(/current===clNameFromFile/);
    expect(fn).toMatch(/wantCite=citeField&&!citeField\.value\.trim\(\)/);
    expect(fn).toMatch(/if\(wantName&&got\.name\)/);
  });

  it("is a convenience, not a gate", () => {
    const fn = src.slice(src.indexOf("async function clNameSingle"), src.indexOf("async function clDetectSegments"));
    expect(fn).toMatch(/catch\s*\(e\)/);
    expect(fn).not.toMatch(/return false/);
  });
});

describe("detection failing does not cost the text", () => {
  it("wraps the split and naming, keeping what was read", () => {
    const tail = changed.slice(changed.indexOf("clPendingText=text"));
    expect(tail).toMatch(/try\{/);
    expect(tail).toMatch(/Could not check for several judgments/);
    /* the text stays; it is simply stored as one authority */
    expect(tail).not.toMatch(/clPendingText=null/);
  });
});
