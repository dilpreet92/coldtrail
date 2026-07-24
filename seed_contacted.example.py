"""Copy this file to `seed_contacted.py` and fill it with domains you've ALREADY
contacted (before or outside this tool), so the pipeline never re-surfaces or
re-contacts them. `seed_contacted.py` is gitignored — your real target list stays
LOCAL and private.

Run once after `python db.py`:
    python seed_contacted.py
Safe to re-run (upsert skips existing).
"""
import db

# domain: (name, status)  — status 'sent' = contacted, 'skip' = do-not-contact
CONTACTED = {
    "example-agency.com": ("Example Agency", "sent"),
    "another-co.io": ("Another Co", "skip"),
}


def main():
    db.init()
    conn = db.connect()
    n = 0
    for domain, (name, status) in CONTACTED.items():
        if db.upsert_company(conn, domain, name, None, None, None, "seed:already-contacted"):
            db.set_status(conn, domain, status)
            n += 1
    conn.commit()
    conn.close()
    print(f"seeded {n} already-contacted companies (dedupe guard)")


if __name__ == "__main__":
    main()
