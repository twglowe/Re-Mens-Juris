# Re-Mens-Juris — working notes

## Shape of the app
- Two Vercel projects build from this repo, `re-mens-juris` and
  `lex-offshore`. **`re-mens-juris` is the live one** — the only one the
  user uses. A `lex-offshore` deployment status on a commit can be ignored.
- Static front end: `public/index.html` plus `public/js/*.js`. The root
  `index.html` is a byte-identical copy — **change both together**, they are
  checked for equality by nothing but habit.
- Serverless API: `api/*.js`, Vercel functions, ES modules, Supabase
  service-role client. `vercel.json` rewrites `/(.*)` to `public/index.html`.
- `/js/*` is cached for a day, so bump the `?v=` query on any script tag whose
  file you changed (`public/index.html` and `index.html`, near the bottom).
- Lesson carried in the code comments: a module-scope Supabase client caches
  the PostgREST schema, so any handler touching a recently migrated table
  builds a **fresh client inside the handler**.
- Long documents are extracted in the **browser** (`extractPdfText` /
  `extractDocxText` in `core.js`) and posted as JSON text. The server-side
  PDF extractor runs through Claude with a 4096-token ceiling and silently
  truncates anything long, so it is not used for library uploads.

## Live Supabase schema — case law library (Push B)
These are the real column names, taken from `information_schema`. Do not
invent or assume others. Ownership is `user_id` on all three tables.

```
case_law_subjects
  id          uuid    NOT NULL  default gen_random_uuid()   PRIMARY KEY
  user_id     uuid    NOT NULL
  name        text    NOT NULL
  created_at  timestamptz       default now()
  UNIQUE (user_id, name)

case_law_docs
  id                  uuid    NOT NULL  default gen_random_uuid()  PRIMARY KEY
  user_id             uuid    NOT NULL
  doc_type            text    NOT NULL  default 'case'
  name                text    NOT NULL
  citation            text              default ''
  jurisdiction        text              default ''
  subject_id          uuid              -> case_law_subjects(id) ON DELETE SET NULL
  sub_tags            text[]            default '{}'
  commentary          text              default ''
  source_document_id  uuid
  source_matter_id    uuid              -> matters(id) ON DELETE SET NULL
  char_count          integer           default 0
  created_at          timestamptz       default now()

case_law_chunks
  id           uuid    NOT NULL  default gen_random_uuid()  PRIMARY KEY
  case_law_id  uuid    NOT NULL  -> case_law_docs(id) ON DELETE CASCADE
  user_id      uuid    NOT NULL
  chunk_index  integer NOT NULL
  content      text    NOT NULL
```

Chunks link to docs via `case_law_id` (not `case_law_doc_id`). Docs link to
subjects via `subject_id`. There is no `file_name` column on `case_law_docs`.

### How the case law library is wired
- API actions live in `api/library.js`: GET `type=case_law_subjects` and
  `type=case_law`; POST `create_case_law_subject`, `create_case_law`;
  DELETE `delete_case_law_subject`, `delete_case_law`.
- Client code is the `cl*` block at the foot of `public/js/library.js`, with
  the collapsible panel under Legislation in the Library left panel.
- **Collapse** (v5.58): Legislation and Case Law share `libSectionToggle`,
  keyed on an element-id prefix (`leg` / `cl`) and backed by
  `libSectionExpanded` — state lives in JS, not the DOM, so a
  `loadLibrary()` refresh leaves open sections open. Both start shut; the
  header carries the count (`libSectionCount`) so a shut section still
  reads. Open sections split the leftover panel height with the precedent
  results (`flex:1 1 0%`, 160px floor) and scroll internally. List order is
  sorted client-side with `libNameSort` (case-insensitive `localeCompare`)
  rather than trusting the order rows arrive in; case law with no subject
  groups under `CL_UNCLASSIFIED`, pinned last.
- **Dual-link**: ticking "also add to the current matter" POSTs the same
  extracted text to `/api/upload` first (doc type `Case Law`, so the matter
  tools can search it), then stores the returned `documentId` on the library
  row as `source_document_id` alongside `source_matter_id`. The matter copy
  is made first — the other order would leave a library entry pointing at a
  matter document that was never created.
- `create_case_law` checks the caller owns or shares `source_matter_id`
  before storing it: the service-role key bypasses RLS, so the foreign key
  is not a permission check.
- **Batching** (v5.57): a textbook's text is far larger than Vercel's 4.5 MB
  body limit, so the client packs the extracted pages into ~1 MB batches
  (`packPagesIntoBatches`, shared with the matter uploader) and posts them
  in order. Both stages batch on the same contract:
  - `/api/upload` — `batchIndex`, `batchTotal`, `documentId` (existing v5.2
    protocol, unchanged).
  - `/api/library` `create_case_law` — `batch_index`, `batch_total`,
    `case_law_id`, `total_char_count`. Batch 0 creates the row and chunks
    0..n; later batches append, numbering from the current max
    `chunk_index`. A single-batch caller sends no batch fields and takes
    the original path.
  - An append that fails part-way deletes the chunks it inserted before
    returning, so a retry resumes from a clean index instead of
    duplicating content. The client keeps `clResume` and offers a Retry
    link that restarts at exactly the failed batch — it does not re-send
    the matter copy when only the library stage failed.
  - The chunker's 150-character overlap does not carry across a batch
    boundary, so a few chunk joins in a batched upload are clean cuts.
    `/api/upload` has the same property.

## Case law in the Draft tool (Push C, v5.59)
- Draft tab → Sources → **Case Law & Texts** box. Client code is the
  `draftCl*` block at the foot of `public/js/drafting.js`; it reads
  `libraryData.caseLaw` / `libraryData.caseLawSubjects`, so `loadLibrary()`
  calls `draftClRender()` too.
- Two sources: authorities dual-linked to the matter (a checklist, ticked by
  default — exclusions are stored, so a newly linked authority arrives
  ticked), and a library search in `general`, `subject` or `off` mode.
  `off` turns off the library search only — the toggle sits under "From the
  library", so ticked matter-linked authorities still go in. With nothing
  ticked and the search off, the client sends no `caseLawContext` at all.
- The client sends `body.caseLawContext`; retrieval happens server-side in
  `buildCaseLawContext` (`api/worker.js`), where the matter's issues and the
  draft instructions are already to hand.
- **`api/tools.js` builds job parameters from an explicit whitelist.** A
  field the client sends but `tools.js` does not name is dropped silently and
  the worker sees nothing. Add any new draft field in *both* the destructure
  and the `parameters` object. `api/__tests__/case_law_context.test.js`
  guards `caseLawContext` against this. Note `matterToolHistory` and
  `learnFromComparable` are *not* whitelisted, so the worker reads them empty
  — pre-existing, not yet fixed.
- Relevance uses the `case_law_search` SQL function
  (`migrations/migration_case_law_search.sql`, ranked with `ts_rank_cd`).
  If that migration has not been run the RPC fails and the code falls back to
  an unranked PostgREST `websearch` text search, so the draft still works —
  it just picks matching chunks rather than the best-matching ones.
- Sizes: `CASE_LAW_SEARCH_CHUNKS` = 160 for the library search,
  `CASE_LAW_DOC_CHUNKS` = 80 per matter-linked authority, at most
  `CASE_LAW_MAX_MATTER_DOCS` = 5 of those — the same 80 the precedent search
  allows per precedent document. A chunk is 1500 characters, so 160 is about
  60k tokens; that block lives in the system prompt, which
  `runBatchedChained` re-sends with every extraction batch and again for the
  synthesis, so its cost multiplies by the batch count. Prompt caching on the
  system prompt is the cheaper way to buy more than raising this again.
- Subject mode never widens: if nothing is filed under the chosen subject,
  the library search is skipped rather than falling back to everything.

## Related earlier work
- Push A, the legislation library (`legislation`, `legislation_chunks`), is
  the pattern Push B follows — see the `leg*` functions in `library.js` and
  `create_legislation` in `api/library.js`.

## House style
- British English throughout, in code comments and UI text alike.
- Comments explain *why*, and carry version markers (`v5.56 Push B: …`).
