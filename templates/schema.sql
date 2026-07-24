-- Outreach pipeline state. Dedupe key = company domain.
CREATE TABLE IF NOT EXISTS companies (
    domain          TEXT PRIMARY KEY,
    name            TEXT,
    hq              TEXT,
    employees       INTEGER,
    founding_year   INTEGER,
    source_query    TEXT,
    first_seen      TEXT DEFAULT (datetime('now')),
    -- sourced -> named -> emailed -> drafted -> sent -> replied / bounced / skip
    status          TEXT DEFAULT 'sourced',
    note            TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    domain          TEXT REFERENCES companies(domain),
    founder_name    TEXT,
    role            TEXT,
    linkedin_url    TEXT,
    email           TEXT,
    email_source    TEXT,          -- how we got it (ddg-snippet, site-page, canonical, websearch)
    email_confidence TEXT,         -- direct | inferred | generic
    mx_ok           INTEGER,       -- 1 verified MX/domain resolves, 0 fail
    found_at        TEXT DEFAULT (datetime('now')),
    UNIQUE(domain, email)
);

CREATE TABLE IF NOT EXISTS outreach (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    domain          TEXT REFERENCES companies(domain),
    contact_id      INTEGER REFERENCES contacts(id),
    channel         TEXT DEFAULT 'email',
    subject         TEXT,
    body            TEXT,
    utm_url         TEXT,
    gmail_draft_id  TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    sent_at         TEXT,
    status          TEXT DEFAULT 'draft_pending',  -- draft_pending -> drafted -> sent -> replied -> bounced
    reply           TEXT
);
