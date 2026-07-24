"""Record a Gmail draft id against a company's outreach row (after Claude creates
the draft via the Gmail MCP), and advance the company status to 'drafted'.

Usage:  python mark_drafted.py <domain> <gmail_draft_id>
        python mark_drafted.py <domain> sent      # mark actually sent
        python mark_drafted.py <domain> bounced   # mark a bounce
"""
import sys
import db


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    domain, val = sys.argv[1], sys.argv[2]
    conn = db.connect()
    if val == "sent":
        conn.execute("UPDATE outreach SET status='sent', sent_at=datetime('now') WHERE domain=?", (domain,))
        db.set_status(conn, domain, "sent")
    elif val == "bounced":
        conn.execute("UPDATE outreach SET status='bounced' WHERE domain=?", (domain,))
        db.set_status(conn, domain, "bounced")
    else:
        conn.execute("UPDATE outreach SET gmail_draft_id=?, status='drafted' WHERE domain=?", (val, domain))
        db.set_status(conn, domain, "drafted")
    conn.commit()
    conn.close()
    print(f"{domain}: {val}")


if __name__ == "__main__":
    main()
