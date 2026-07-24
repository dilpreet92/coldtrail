"""Add a founder email discovered via Claude's WebSearch/WebFetch into the pipeline,
MX-verified, so manual finds flow through the same DB/dedupe/draft path as ddgs finds.

Usage:  python add_contact.py <domain> <founder_name> <email> [source]
Rejects generic/placeholder locals; sets company status to 'emailed' if MX ok.
"""
import sys
import db
from find_emails import mx_ok, score


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    domain, founder, email = sys.argv[1].lower(), sys.argv[2], sys.argv[3].lower()
    source = sys.argv[4] if len(sys.argv) > 4 else "websearch"

    conf = score(email, founder)
    if conf is None:
        print(f"REJECTED (generic/placeholder): {email}")
        sys.exit(2)
    ok = mx_ok(email.split("@")[1])
    conn = db.connect()
    # ensure company exists
    if not conn.execute("SELECT 1 FROM companies WHERE domain=?", (domain,)).fetchone():
        conn.execute("INSERT INTO companies (domain, source_query) VALUES (?, 'manual')", (domain,))
    conn.execute(
        "INSERT OR IGNORE INTO contacts (domain, founder_name, email, email_source, email_confidence, mx_ok) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (domain, founder, email, source, conf, 1 if ok else 0),
    )
    db.set_status(conn, domain, "emailed" if ok else "named")
    conn.commit()
    conn.close()
    print(f"added {email} [{conf}, {source}] mx_ok={ok} for {domain}")


if __name__ == "__main__":
    main()
