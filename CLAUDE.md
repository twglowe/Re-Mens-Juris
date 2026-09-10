# Re-Mens-Juris — working notes

## Shape of the app
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
- **Dual-link**: ticking "also add to the current matter" POSTs the same
  extracted text to `/api/upload` first (doc type `Case Law`, so the matter
  tools can search it), then stores the returned `documentId` on the library
  row as `source_document_id` alongside `source_matter_id`. The matter copy
  is made first — the other order would leave a library entry pointing at a
  matter document that was never created.
- `create_case_law` checks the caller owns or shares `source_matter_id`
  before storing it: the service-role key bypasses RLS, so the foreign key
  is not a permission check.

## Related earlier work
- Push A, the legislation library (`legislation`, `legislation_chunks`), is
  the pattern Push B follows — see the `leg*` functions in `library.js` and
  `create_legislation` in `api/library.js`.

## House style
- British English throughout, in code comments and UI text alike.
- Comments explain *why*, and carry version markers (`v5.56 Push B: …`).
