"""Generate personalized email drafts (with your link) for contacts that have a
MX-verified founder email and aren't drafted yet.

The message itself — your name, your pitch, your link/UTM — lives in `message.py`
(gitignored, private). Copy `message.example.py` -> `message.py` and edit it first.

Writes an `outreach` row (status draft_pending) per contact and dumps
pending_drafts.json for you (or an agent via a Gmail MCP) to create as DRAFTS.
Nothing is ever sent automatically — you review and hit send by hand.

Usage:  python draft_prep.py [max]
"""
import json
import os
import re
import sys

import db

try:
    import message
except ModuleNotFoundError:
    sys.exit("No message.py found. Copy message.example.py -> message.py and edit "
             "it with your sender name, pitch, and link, then re-run.")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pending_drafts.json")


def first_name(full):
    return (full or "there").strip().split()[0] if full else "there"


def slug(domain):
    return re.sub(r"\.[a-z.]+$", "", domain).replace(".", "-")


def build(company, founder, domain):
    fn = first_name(founder)
    link = message.LINK.format(slug=slug(domain))
    ctx = {"company": company, "fn": fn}
    subject = message.SUBJECT.format(**ctx)
    paras = [p.format(**ctx) for p in message.PARAGRAPHS]
    cta_plain = message.CTA_PLAIN.format(link=link)
    cta_html = message.CTA_HTML.format(link=link)
    body = "\n\n".join(cta_plain if p == "__CTA__" else p for p in paras)
    html = "".join(f"<p>{cta_html if p == '__CTA__' else p}</p>" for p in paras)
    return subject, body, html, link


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    db.init()
    conn = db.connect()
    rows = conn.execute(
        """SELECT k.id contact_id, k.domain, k.founder_name, k.email, c.name
           FROM contacts k JOIN companies c ON c.domain=k.domain
           WHERE k.mx_ok=1 AND k.email IS NOT NULL
             AND c.status='emailed'
             AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.domain=k.domain)
           ORDER BY k.found_at LIMIT ?""",
        (limit,),
    ).fetchall()

    drafts = []
    for r in rows:
        subject, body, html, link = build(r["name"], r["founder_name"], r["domain"])
        conn.execute(
            "INSERT INTO outreach (domain, contact_id, subject, body, utm_url, status) "
            "VALUES (?, ?, ?, ?, ?, 'draft_pending')",
            (r["domain"], r["contact_id"], subject, body, link),
        )
        drafts.append({
            "domain": r["domain"], "to": r["email"], "subject": subject,
            "body": body, "html": html,
        })
    conn.commit()
    conn.close()

    with open(OUT, "w") as f:
        json.dump(drafts, f, indent=2)
    print(f"prepared {len(drafts)} drafts -> {OUT}")
    for d in drafts:
        print(f"  {d['domain']:<28} -> {d['to']}")


if __name__ == "__main__":
    main()
