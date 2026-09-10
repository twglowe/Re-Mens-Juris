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
  guards `caseLawContext`, `matterToolHistory` and `learnFromComparable`
  against this. The latter two were dropped from v5.11a until v5.63, so the
  draft prompt's "WHAT WE ALREADY KNOW ABOUT THIS MATTER" block never
  appeared. `learnFromComparable` must not be stored as `x || true` — the
  worker reads it as `!== false`, so that would discard the only meaningful
  value.
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

## Multi-case files (Push D, v5.62)
- `public/js/case_law_split.js` — pure helpers, loaded as a plain script
  before `core.js` and exported through `module.exports` so
  `api/__tests__/case_law_split.test.js` runs against the same source.
- **Pagination decides first** (v5.63). Each judgment in a bundle carries its
  own internal numbering and starts again at 1, which no quoted heading can
  fake: `clDetectPageBoundaries` splits on a reset to 1, a change in the
  "of N" total, or a short front page carrying a court header. When that
  yields two or more segments it decides alone; `seg.method` says which
  signal spoke. A front-page boundary resets the numbering context, or the
  body's "Page 1" one page later reads as a second boundary and the case is
  split from its own cover.
- The heading scan is the fallback, for a DOCX (one page) or a PDF whose
  footers did not extract. It is deliberately conservative: only a line that
  is itself a court header, or a case title standing alone, counts, and only
  when at least `CL_MIN_SEGMENT_CHARS` past the previous boundary.
  `IN THE MATTER OF …` lines are excluded — they belong to a judgment's own
  header block, and splitting there would cut one judgment in half. A false
  negative stores the file as one entry (the old behaviour); a false positive
  would shred a judgment, so the thresholds lean towards missing a split.
- `name_case_law_segments` (`api/library.js`) asks Claude to name and cite
  each segment from its opening ~3000 characters. Naming is a convenience,
  never a gate: a failure hands back blanks for the user to type.
- The user confirms in the `clSegments` panel — editable name and citation
  per case, a tick per case, and a "store the file as one entry" escape.
  Nothing is stored until they choose.
- `clRunUpload` takes its pages from `meta.pages` when the caller supplies
  them, so the set path feeds it one judgment at a time; `meta.partOfSet`
  stops it clearing the form between cases.

## Pinpoint citation (v5.64)
- `case_law_chunks.page_number` records the page a chunk came from — the
  authority's **own** internal number where the extractor could read one
  (`clPageOffsets` reads it from each whole page, before any boundary can cut
  a footer off a slice), falling back to the page's position in the file. In
  a bundle those differ, and it is the internal one a court wants.
- The client sends `pageTexts` on `create_case_law`; `chunkPages` chunks page
  by page so no chunk spans two pages and every chunk can name one honestly.
- The worker marks each page change as `[p.N]` and the prompt's rule 2 tells
  the model to pinpoint what is marked and never to guess one that is not.
- **Graceful without the migration**: `migrations/migration_case_law_pages.sql`
  adds the column and re-creates `case_law_search` to return it (the return
  type changes, so it is dropped and recreated). Until it is run, the insert
  retries without the column and both reads fall back to a select that omits
  it — uploads still work, drafts simply carry no pinpoints.

## Prompt caching (v5.62)
- `runTool` puts a `cache_control: {type:"ephemeral"}` breakpoint on the
  system prompt. It is byte-identical across every extraction batch and the
  synthesis, so from the second call on that block bills at ~0.1x.
- Caching is a **prefix match**: anything that varies per batch must stay in
  the user message, below the breakpoint. Adding a timestamp, a batch number
  or a job id to `systemBase` would silently destroy the cache — check
  `cache_read_input_tokens` in the logs if drafts get expensive again.
- An empty system prompt is sent as a plain string; an empty text block is
  rejected by the API. A prompt below the model's minimum cacheable length
  simply is not cached — silent and harmless.
- Cost accounting prices writes at `CACHE_WRITE_MULTIPLIER` (1.25x) and reads
  at `CACHE_READ_MULTIPLIER` (0.1x); `input_tokens` alone excludes cached
  tokens, so without this the cost would be understated. The `inputTokens`
  runTool returns includes cached tokens, so `usage_log` still records every
  input token a call processed.

## Precedent Library naming (v5.65)
- The Precedent Library holds **reusable templates**. A precedent named after
  the matter it came from is findable only by someone who remembers that
  matter, and reads as case law sitting among the templates.
- **How matter-named entries got there**: `precUpFileChanged` asked Claude for
  "the case name (e.g. Smith v Jones) or the first party name" when the name
  field was empty, so the suggestion offered *was* the matter name and
  accepting it filed the precedent under it. That is the only route — the
  Draft tab's "Upload precedent from device" posts to `/api/upload` as a
  matter document, `libNewPrecedent` opens the modal empty, and
  `libCreatePrecedent` has no callers.
- The prompt now asks for the kind of document and its subject
  ("Skeleton Argument — unfair prejudice petition") and forbids party, case,
  company and matter names. `libMatchingMatterName` then discards a
  suggestion that collides with one of the user's matters, and challenges a
  hand-typed one at save with a confirm rather than a block.
- **The name was doing a real job**: it recorded which matter a precedent came
  from, so the AI could judge its context. `precedent_docs.source_matter_id`
  (`migration_precedent_source_matter.sql`, mirroring `case_law_docs`) gives
  that link a column, so the name can describe the document while the
  association survives. Set at upload (defaulting to the open matter) and
  editable afterwards in the precedent panel, so entries uploaded before the
  field existed can be linked.
- The drafting prompt reads it: for each precedent it names the source matter
  and carries that matter's nature and issues, telling the model to learn how
  the document met that situation and to say so where the present facts
  differ. `resolveSourceMatter` checks owner-or-sharer server-side — the
  service key bypasses RLS, so the foreign key is not a permission check.
- **Renaming** (v5.66): until then *nothing in the app could rename a
  precedent* — `update_precedent` never accepted a `name` and the panel had no
  name field, so an entry filed under a matter's name was stuck with it. The
  panel now has an editable Name with a **Suggest** button that reads the
  stored chunks back through `type=prec_chunks` and runs them past
  `PREC_NAME_PROMPT` — the same prompt the upload path uses, defined once so
  the two cannot drift. A suggestion lands in the box for the user to accept;
  nothing is renamed until Save Changes. A blank name is refused client-side
  and ignored server-side, since `precedent_docs.name` is NOT NULL.
- **Bulk tidy** (v5.67): the "Tidy" button in the Precedent Library panel head
  finds every precedent whose name matches a matter, suggests a template name
  for each from the text stored at upload, flags entries sharing a name (this
  library had duplicate uploads), and saves the new name and the source matter
  together. Suggestions run in sequence and land in editable boxes; Apply is a
  separate press. Meant as a one-off clear-up, not a standing workflow — the
  prompt that caused the mess is fixed.
- **Scope** (v5.70): Tidy lists matter-named precedents by default, and the
  whole library when "Show every precedent" is ticked — a stray upload named
  after a company that was never a matter never matched, so it never appeared
  and could not be deleted there. An unmatched row defaults to Leave alone,
  not Rename: its name may be perfectly good already.
- **Per-row matter** (v5.71): every row being renamed carries its own matter
  select. The auto match only *seeds* it (an existing `source_matter_id` wins
  over both), because a precedent named after a case that is not one of your
  matters — "Evergrande", where the document is an expert report — matches
  nothing, and it still came from somewhere.
- **Deleting** (v5.68): each tidy row chooses Rename, Delete or Leave alone,
  defaulting to Rename since deleting is the one choice that cannot be undone.
  Deletions are confirmed once, listing the names. `delete_precedent` removes
  `precedent_chunks` **before** the row — until v5.68 it deleted the row only,
  and nothing in the client called it at all, so a precedent could not be
  deleted in the app and the API path would have orphaned its chunks. An
  orphaned chunk still feeds the drafting prompt.
- **Several at once** (v5.69): the upload modal takes multiple files. One file
  behaves exactly as before; two or more swap the single Name and matter
  fields for a row each — own name (AI-suggested per file), own
  `source_matter_id` — while sharing the case type, stage, doc type and
  jurisdiction set above. The point is a set of the same kind of document
  from different matters: one skeleton teaches the AI what a skeleton is,
  four across four cases teach it how the form varies. Uploads run in
  sequence (each is a multipart POST that extracts and chunks server-side)
  and a failure stops, reporting how many are already in, so the user can
  retry the rest without duplicating.
- Cleanup SQL lives in `migrations/`: `review_precedent_library.sql` is read
  only, `delete_precedent_entries.sql` takes an explicit id list and deletes
  `precedent_chunks` first — the foreign key's ON DELETE behaviour is not
  recorded in this repo, and an orphaned chunk still feeds the drafting
  prompt. **Prefer relinking to deleting**: a matter-named precedent still
  holds a usable template, and the backfill helper in
  `migration_precedent_source_matter.sql` pairs it with its matter.

## Related earlier work
- Push A, the legislation library (`legislation`, `legislation_chunks`), is
  the pattern Push B follows — see the `leg*` functions in `library.js` and
  `create_legislation` in `api/library.js`.

## Merging (standing instruction, 10 Sep 2026)
Tom's rule: **open the PR, wait for CI, and merge it yourself once the tests
pass.** No need to ask each time.

- CI is `.github/workflows/tests.yml` — `npm test` on a clean machine, on
  every PR into `main`. Green is the gate.
- Merge with **rebase**. `main` has never carried a merge commit; keep it
  linear.
- Still stop and ask when:
  - tests fail, or a check is red for a reason that is not obviously mine
  - there is a merge conflict whose resolution loses someone's work
  - the change deletes data, drops a column, or is otherwise hard to undo
  - the work turned up a decision that is Tom's to make, not mine
- Say what was merged and what still needs him — a migration to run, a thing
  to test against live data. A green tick means the logic behaves as written,
  never that it works against the real Supabase.

## House style
- British English throughout, in code comments and UI text alike.
- Comments explain *why*, and carry version markers (`v5.56 Push B: …`).
