"""SQLite helpers for the outreach pipeline. Dedupe key = company domain."""
import sqlite3
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "outreach.db")
SCHEMA_PATH = os.path.join(HERE, "schema.sql")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init():
    conn = connect()
    with open(SCHEMA_PATH) as f:
        conn.executescript(f.read())
    conn.commit()
    conn.close()


def upsert_company(conn, domain, name, hq, employees, founding_year, source_query):
    """Insert a company if its domain is new. Returns True if newly added."""
    cur = conn.execute("SELECT 1 FROM companies WHERE domain = ?", (domain,))
    if cur.fetchone():
        return False
    conn.execute(
        "INSERT INTO companies (domain, name, hq, employees, founding_year, source_query) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (domain, name, hq, employees, founding_year, source_query),
    )
    return True


def set_status(conn, domain, status):
    conn.execute("UPDATE companies SET status = ? WHERE domain = ?", (status, domain))


if __name__ == "__main__":
    init()
    print(f"initialized {DB_PATH}")
