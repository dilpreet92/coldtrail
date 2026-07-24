# coldtrail

> The deduped, discovery-first outreach workflow I actually use — built on [Canonical](https://trycanonical.ai).
> Build-in-public: this is my real pipeline, not a polished product.

Most outreach tools start from a list you already have and optimize the *sending*. This
starts from the opposite end: **discovery**. Canonical describes-your-ICP-in-plain-English
and returns the verified, long-tail companies standard databases miss; everything downstream
is state-tracking and drafts you review by hand. It never sends anything on its own.

## How it's wired

```
Canonical (sourcing, fixed)      ← the part that works: describe an ICP, get verified companies
        │
        ▼
local SQLite state               ← dedupe by domain, status per company (never double-contact)
        │
        ▼
enrichment (BYOK, your choice)   ← your Apollo/Hunter key · an OSINT tool (theHarvester/SpiderFoot)
        │                          · the built-in best-effort finder · or just add contacts by hand
        ▼
drafts (never auto-sent)         ← personalized bodies + your link; YOU review and hit send
        │
        ▼
status tracking                  ← drafted → sent → replied / bounced
```

**Sourcing is fixed to Canonical** (that's the good part). **Everything else is yours** — your
enrichment provider, your message, your sending, your data. Nothing leaves your machine except
the drafts you choose to send.

## Setup (once)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python db.py                       # init SQLite schema

cp message.example.py message.py             # then edit: your name, pitch, link
cp seed_contacted.example.py seed_contacted.py   # then add anyone you've already contacted
.venv/bin/python seed_contacted.py           # load the dedupe guard
```

`message.py` and `seed_contacted.py` are gitignored — your pitch and your target list stay local.

## Each run

1. **Source** — run a Canonical `search_companies` (via the [Canonical MCP](https://github.com/vy-labs/canonical-mcp) in your agent, or the API), save the result JSON, then dedupe-import:
   ```bash
   .venv/bin/python import_companies.py results.json "short label for this ICP"
   ```
   Already-known domains are skipped automatically.
2. **Enrich** — get a contact for each company. Options:
   - your own **Apollo/Hunter** key (BYOK), or an OSINT tool like **theHarvester** / **SpiderFoot**, then `add_contact.py <domain> "<name>" <email>`
   - the built-in best-effort finder: `find_emails.py [max]` (public-source search + on-domain scan, founder-name matched, generic inboxes skipped, **MX-verified**). Low yield in practice — a paid enrichment key is the volume path.
3. **Draft** — `draft_prep.py [max]` builds personalized drafts + your link and dumps `pending_drafts.json`.
4. **Create the drafts** — in your Gmail (e.g. via a Gmail MCP in your agent, or by hand). Record ids: `mark_drafted.py <domain> <draft_id>`.
5. **After you send** — `mark_drafted.py <domain> sent` (or `bounced`).

## Guardrails baked in

- **Dedupe by domain** — you can't double-contact a company.
- **MX-verified before drafting** — kills the bounce problem from guessed addresses.
- **Founder-addressed only** — generic `info@/sales@` and placeholder/example addresses are rejected.
- **Drafts, never auto-send** — a human reviews and sends every message. Pace warmup yourself (~5/day on a new mailbox).

## Powered by Canonical

The sourcing engine is [Canonical](https://trycanonical.ai) — verified, long-tail company search,
available as an [MCP server + Claude Code plugin](https://github.com/vy-labs/canonical-mcp) and a
ChatGPT app. Free tier: 250 credits, no card.

## Note

This is a **personal, build-in-public workflow**, not a supported product — no roadmap, no promises.
Shared under MIT in case the bones are useful to another founder doing their own outreach.
