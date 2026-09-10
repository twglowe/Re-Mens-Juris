/* v5.59 Push C — case law retrieval for the Draft tool.

   worker.js builds a Supabase and an Anthropic client at module scope, so
   both need a value in the environment before the import; neither is used
   by anything under test, which takes its client as an argument. */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-key";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";

import { describe, it, expect } from "vitest";
const { buildCaseLawContext, caseLawKeywords, caseLawJoinChunks, caseLawHeading } =
  await import("../worker.js");

const USER = "user-1";
const MATTER = "matter-1";

/* A stub standing in for the parts of supabase-js the helpers touch: a
   chainable query builder that records what was asked for, and rpc(). */
function stubClient(fixtures) {
  const calls = { rpc: [], from: [] };
  function table(name) {
    const q = { table: name, filters: {}, limit: null };
    calls.from.push(q);
    const builder = {
      select() { return builder; },
      eq(col, val) { q.filters[col] = val; return builder; },
      in(col, vals) { q.filters["in:" + col] = vals; return builder; },
      contains(col, vals) { q.filters["contains:" + col] = vals; return builder; },
      order() { return builder; },
      textSearch(col, query, opts) { q.textSearch = { query, opts }; return builder; },
      limit(n) { q.limit = n; return resolve(); },
      then(onOk, onErr) { return resolve().then(onOk, onErr); },
    };
    function resolve() {
      const rows = fixtures.tables[name] ? fixtures.tables[name](q) : [];
      return Promise.resolve({ data: rows, error: null });
    }
    return builder;
  }
  return {
    calls,
    from: table,
    rpc(fn, args) {
      calls.rpc.push({ fn, args });
      if (fixtures.rpc) return Promise.resolve(fixtures.rpc(args));
      return Promise.resolve({ data: null, error: { message: "function not found" } });
    },
  };
}

const DOC_SCHMIDT = {
  id: "cl-1", name: "Schmidt v Rosewood Trust Ltd", citation: "[2003] 2 AC 709",
  jurisdiction: "Privy Council", doc_type: "case", commentary: "",
};
const DOC_LEWIN = {
  id: "cl-2", name: "Lewin on Trusts (20th edn)", citation: "",
  jurisdiction: "England and Wales", doc_type: "textbook", commentary: "",
};

describe("caseLawKeywords", () => {
  it("drops stopwords and the words every legal document contains", () => {
    const kw = caseLawKeywords("The claimant says that the defendant committed a breach of trust in these proceedings");
    expect(kw).toContain("breach");
    expect(kw).toContain("trust");
    expect(kw).toContain("committed");
    expect(kw).not.toContain("claimant");
    expect(kw).not.toContain("defendant");
    expect(kw).not.toContain("proceedings");
    expect(kw).not.toContain("that");
  });

  it("de-duplicates and caps the term count", () => {
    const kw = caseLawKeywords("trust trust trust " + Array.from({ length: 40 }, (_, i) => "wordnum" + i).join(" "));
    expect(kw.filter((w) => w === "trust")).toHaveLength(1);
    expect(kw.length).toBeLessThanOrEqual(12);
  });

  it("returns nothing for empty or unusable input", () => {
    expect(caseLawKeywords("")).toEqual([]);
    expect(caseLawKeywords(null)).toEqual([]);
    expect(caseLawKeywords("a of in the")).toEqual([]);
  });
});

describe("caseLawJoinChunks", () => {
  it("marks a gap between non-consecutive chunks", () => {
    const out = caseLawJoinChunks([
      { chunk_index: 4, content: "first" },
      { chunk_index: 5, content: "second" },
      { chunk_index: 9, content: "third" },
    ]);
    expect(out).toBe("first\n\nsecond\n\n[…]\n\nthird");
  });

  it("leaves consecutive chunks unmarked", () => {
    const out = caseLawJoinChunks([
      { chunk_index: 0, content: "a" },
      { chunk_index: 1, content: "b" },
    ]);
    expect(out).toBe("a\n\nb");
  });
});

describe("caseLawHeading", () => {
  it("names the authority with its citation and jurisdiction", () => {
    expect(caseLawHeading(DOC_SCHMIDT))
      .toBe("=== AUTHORITY: Schmidt v Rosewood Trust Ltd [2003] 2 AC 709 (Privy Council) ===");
  });

  it("marks a textbook as one and copes with a missing citation", () => {
    expect(caseLawHeading(DOC_LEWIN))
      .toBe("=== AUTHORITY: Lewin on Trusts (20th edn) (England and Wales; textbook) ===");
  });
});

describe("buildCaseLawContext", () => {
  it("returns nothing when there is no context at all", async () => {
    expect(await buildCaseLawContext(stubClient({ tables: {} }), USER, MATTER, null, "q")).toBe("");
  });

  it("returns nothing when neither source yields anything", async () => {
    const sb = stubClient({ tables: {} });
    const out = await buildCaseLawContext(sb, USER, MATTER, { mode: "general", matterCaseLawIds: [] }, "breach of trust");
    expect(out).toBe("");
  });

  it("includes authorities linked to the matter, and checks they really are linked", async () => {
    const sb = stubClient({
      tables: {
        case_law_docs: () => [DOC_SCHMIDT],
        case_law_chunks: () => [{ chunk_index: 0, content: "A beneficiary may seek disclosure." }],
      },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, { mode: "general", matterCaseLawIds: ["cl-1"] }, "disclosure");
    expect(out).toContain("## AUTHORITIES LINKED TO THIS MATTER");
    expect(out).toContain("Schmidt v Rosewood Trust Ltd [2003] 2 AC 709");
    expect(out).toContain("A beneficiary may seek disclosure.");
    const docQuery = sb.calls.from.find((c) => c.table === "case_law_docs");
    expect(docQuery.filters.user_id).toBe(USER);
    expect(docQuery.filters.source_matter_id).toBe(MATTER);
    expect(docQuery.filters["in:id"]).toEqual(["cl-1"]);
  });

  it("carries the citation discipline whenever anything is returned", async () => {
    const sb = stubClient({
      tables: {
        case_law_docs: () => [DOC_SCHMIDT],
        case_law_chunks: () => [{ chunk_index: 0, content: "text" }],
      },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, { mode: "general", matterCaseLawIds: ["cl-1"] }, "q");
    expect(out).toContain("# CASE LAW AND TEXTS");
    expect(out).toContain("MUST be cited by name and citation");
    expect(out).toContain("Do NOT reproduce these passages at length");
    expect(out).toContain("Do not cite an authority you have not been given here");
  });

  it("uses the ranked search function when it is available", async () => {
    const sb = stubClient({
      rpc: () => ({ data: [{ case_law_id: "cl-1", chunk_index: 3, content: "ranked passage", rank: 0.9 }], error: null }),
      tables: { case_law_docs: () => [DOC_SCHMIDT] },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, { mode: "general", matterCaseLawIds: [] }, "breach of trust");
    expect(sb.calls.rpc).toHaveLength(1);
    expect(sb.calls.rpc[0].fn).toBe("case_law_search");
    expect(sb.calls.rpc[0].args.p_user_id).toBe(USER);
    expect(sb.calls.rpc[0].args.p_doc_ids).toBeNull();
    expect(out).toContain("## AUTHORITIES FROM THE LIBRARY (whole library)");
    expect(out).toContain("ranked passage");
  });

  it("falls back to an OR text search when the ranked function is missing", async () => {
    const sb = stubClient({
      tables: {
        case_law_chunks: () => [{ case_law_id: "cl-2", chunk_index: 1, content: "fallback passage" }],
        case_law_docs: () => [DOC_LEWIN],
      },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, { mode: "general", matterCaseLawIds: [] }, "breach of trust disclosure");
    const search = sb.calls.from.find((c) => c.textSearch);
    expect(search.textSearch.opts.type).toBe("websearch");
    expect(search.textSearch.query).toContain(" OR ");
    expect(search.limit).toBe(80);
    expect(out).toContain("fallback passage");
  });

  it("confines the search to the chosen subject and sub-tag", async () => {
    const sb = stubClient({
      rpc: () => ({ data: [{ case_law_id: "cl-1", chunk_index: 0, content: "subject passage" }], error: null }),
      tables: {
        case_law_docs: (q) => (q.filters.subject_id ? [{ id: "cl-1" }] : [DOC_SCHMIDT]),
      },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, {
      mode: "subject", matterCaseLawIds: [], subjectId: "subj-1", subjectName: "Trusts", subTag: "disclosure",
    }, "q");
    const docQuery = sb.calls.from.find((c) => c.filters.subject_id);
    expect(docQuery.filters["contains:sub_tags"]).toEqual(["disclosure"]);
    expect(sb.calls.rpc[0].args.p_doc_ids).toEqual(["cl-1"]);
    expect(out).toContain("## AUTHORITIES FROM THE LIBRARY (Trusts — disclosure)");
  });

  it("never widens to the whole library when the chosen subject is empty", async () => {
    const sb = stubClient({
      rpc: () => ({ data: [{ case_law_id: "cl-1", chunk_index: 0, content: "should not appear" }], error: null }),
      tables: { case_law_docs: () => [] },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, {
      mode: "subject", matterCaseLawIds: [], subjectId: "subj-empty", subjectName: "Shipping",
    }, "q");
    expect(sb.calls.rpc).toHaveLength(0);
    expect(out).toBe("");
  });

  it("skips the library search in subject mode with no subject chosen", async () => {
    const sb = stubClient({
      rpc: () => ({ data: [{ case_law_id: "cl-1", chunk_index: 0, content: "should not appear" }], error: null }),
      tables: { case_law_docs: () => [DOC_SCHMIDT], case_law_chunks: () => [{ chunk_index: 0, content: "linked text" }] },
    });
    const out = await buildCaseLawContext(sb, USER, MATTER, {
      mode: "subject", matterCaseLawIds: ["cl-1"], subjectId: null,
    }, "q");
    expect(sb.calls.rpc).toHaveLength(0);
    expect(out).toContain("linked text");
    expect(out).not.toContain("AUTHORITIES FROM THE LIBRARY");
  });

  it("caps the library search at the precedent search's per-document size", async () => {
    const sb = stubClient({
      rpc: () => ({ data: [], error: null }),
      tables: { case_law_docs: () => [] },
    });
    await buildCaseLawContext(sb, USER, MATTER, { mode: "general", matterCaseLawIds: [] }, "trust");
    expect(sb.calls.rpc[0].args.p_limit).toBe(80);
  });
});

/* api/tools.js builds the job's parameters from an explicit whitelist: a
   field the client sends but tools.js does not name is dropped silently,
   and the worker then sees nothing. That is how p.matterToolHistory and
   p.learnFromComparable currently reach the worker empty. This guards the
   case law context against going the same way. */
describe("caseLawContext reaches the worker", () => {
  it("is both destructured and stored by api/tools.js", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8");
    const destructure = src.slice(src.indexOf("const { tool, matterId"), src.indexOf("} = req.body;"));
    expect(destructure).toContain("caseLawContext");
    const params = src.slice(src.indexOf("const parameters = {"), src.indexOf("/* Create job row */"));
    expect(params).toMatch(/caseLawContext:\s*caseLawContext/);
  });

  it("is read from the job parameters by the worker", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
    expect(src).toContain("p.caseLawContext");
    /* and the retrieved block must actually reach the prompt */
    expect(src).toMatch(/libraryText \+ caseLawText/);
  });
});
