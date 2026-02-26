# Mens Juris — Setup Guide

## What this system does
- Per-user login with email and password
- Private matters — each user sees only their own
- Matter sharing — share any matter with a colleague, read-only or with edit access
- Unlimited document storage and full-text search across all documents
- Chat-style legal analysis — ask unlimited questions per matter
- Seven specialist analysis tools:
  - **Inconsistency Tracker** — finds contradictions between anchor documents and all other evidence
  - **Chronology Builder** — extracts and assembles all dates and events
  - **Persons & Entities Index** — maps every person and organisation across all documents
  - **Issue Tracker** — maps pleaded issues to supporting/contradicting evidence
  - **Citation Checker** — verifies case law citations in skeleton arguments
  - **Briefing Note** — structured matter summary for getting a colleague up to speed
  - **Draft Generator** — drafts skeleton arguments, witness statements, submissions

---

## Step 1 — Supabase (10 minutes)

1. Go to **https://supabase.com** → create a free account
2. Click **New Project** → name it `mens-juris` → set a password → choose a nearby region → wait ~2 minutes
3. Go to **SQL Editor** (left sidebar) → **New Query**
4. Open `SUPABASE_SETUP.sql`, copy all contents, paste, click **Run**
5. Go to **Authentication → Settings** and make sure Email Auth is enabled
6. Go to **Settings → API** and copy:
   - **Project URL** (e.g. `https://xxxxxx.supabase.co`)
   - **service_role** key (under Project API keys — use service_role not anon)

**Create user accounts:**
- Go to **Authentication → Users → Invite User**
- Add yourself and each colleague who will use the system
- They will receive an email to set their password

---

## Step 2 — GitHub

1. Go to **github.com/twglowe** → create a new repository called `mens-juris`
2. Upload all files maintaining this structure:
```
api/
  auth.js
  analyse.js
  documents.js
  matters.js
  sharing.js
  tools.js
  upload.js
public/
  index.html
package.json
vercel.json
SUPABASE_SETUP.sql
README.md
```

---

## Step 3 — Vercel

1. Go to **vercel.com** → Add New Project → select `mens-juris` from GitHub
2. Click **Deploy**
3. Go to **Settings → Environment Variables** and add:

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic key (sk-ant-...) |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service_role key |

4. Go to **Settings → Domains** → add `mens-juris` as the project name for URL `mens-juris.vercel.app`
5. Go to **Deployments** → Redeploy

---

## Step 4 — Use it

Open **https://mens-juris.vercel.app** on any device.

**Daily workflow:**
1. Sign in with your email and password
2. Create a matter (left panel → + New)
3. Select document type from the dropdown (right panel)
4. Upload PDFs — each is indexed in 15–60 seconds
5. Ask questions in the chat
6. Use Tools bar for specialist analysis

**To share a matter:**
- Click the green **Share** button (top right of document panel)
- Enter your colleague's email (they must already have an account)
- Choose read-only or edit access

**To add a new user:**
- Go to supabase.com → your project → Authentication → Users → Invite User

---

## Updating the Claude model

When Anthropic releases a new model:
1. Vercel → your project → Settings → Environment Variables
2. Add `CLAUDE_MODEL` = new model name (e.g. `claude-opus-4-5`)
3. Redeploy — done

---

## Scanned PDFs

If a PDF cannot be read (scanned image), use a free OCR service first:
- **ilovepdf.com** → OCR PDF
- **smallpdf.com** → OCR PDF
- **Adobe Acrobat** → File → Export To → Word, then re-save as PDF

---

## Cost estimate (Anthropic API)

| Action | Approximate cost |
|--------|-----------------|
| Upload 50-page document | £0.05–0.20 |
| Each Q&A exchange | £0.02–0.10 |
| Inconsistency analysis on large matter | £0.20–0.80 |
| Full day heavy use | £2–5 max |

Set a monthly spend limit at **platform.anthropic.com → Billing → Usage limits**.
