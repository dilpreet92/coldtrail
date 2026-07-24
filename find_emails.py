"""Systematic founder-email hunt for companies in the DB that lack one.

Per company:
  1. Use the founder name if seeded (from Canonical leadership / websearch); else
     best-effort resolve it via search.
  2. Run several ddgs query patterns (name+company, site:domain name, "@domain", ...).
  3. Scan result snippets AND fetch on-domain candidate pages (/about /team /contact);
     regex-extract emails that match the company domain.
  4. Prefer a founder-name-matching local part; skip generic (info@/sales@/...).
  5. Verify: syntax + MX record (kills the bounce problem). Store to contacts.

Usage:  python find_emails.py [max_companies]
Only touches companies without a verified founder email yet. Safe to re-run.
"""
import re
import sys
import time
import db

from ddgs import DDGS
import requests
import dns.resolver

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
GENERIC = {"info", "sales", "contact", "hello", "support", "admin", "team",
           "marketing", "help", "careers", "jobs", "press", "media", "office",
           "enquiries", "inquiries", "hi", "ask", "hey", "book", "demo", "no-reply",
           "noreply", "privacy", "legal", "billing"}
# Example/placeholder locals that appear on "email format" explainer pages — never real.
PLACEHOLDER = {"jane", "janedoe", "jane.doe", "john", "johndoe", "john.doe", "jdoe",
               "jsmith", "j.doe", "j.smith", "joe", "joesmith", "example", "name",
               "firstname", "lastname", "first", "last", "first.last", "fname",
               "flast", "user", "username", "test", "email", "youremail", "yourname",
               "your.name", "sample", "demo", "foo", "bar", "abc", "xyz",
               "name.surname", "firstname.lastname", "first.lastname"}
TITLE_WORDS = re.compile(r"\b(Executive|Partner|Officer|Chief|Manager|Director|"
                         r"Founder|CEO|President|Head|Sales|Marketing|Team|Owner)\b", re.I)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
CANDIDATE_PATHS = ["", "/about", "/about-us", "/team", "/our-team", "/contact", "/contact-us"]


def mx_ok(domain):
    try:
        if list(dns.resolver.resolve(domain, "MX", lifetime=8)):
            return True
    except Exception:
        pass
    try:
        dns.resolver.resolve(domain, "A", lifetime=6)
        return True
    except Exception:
        return False


def ddg(query, max_results=8):
    try:
        with DDGS() as d:
            return list(d.text(query, max_results=max_results))
    except Exception as e:
        print(f"    ddg error: {e}")
        return []


def fetch(url):
    try:
        r = requests.get(url, timeout=12, headers=UA)
        if r.status_code == 200:
            return r.text
    except Exception:
        pass
    return ""


def domain_emails(text, domain):
    hits = set()
    for m in EMAIL_RE.findall(text or ""):
        m = m.strip().strip(".").lower()
        if m.endswith("@" + domain):
            hits.add(m)
    return hits


def resolve_founder(company, domain):
    for q in (f"{company} {domain} founder CEO", f'"{company}" founder'):
        for r in ddg(q, 6):
            blob = f"{r.get('title','')} {r.get('body','')}"
            # crude: two capitalized words near founder/CEO
            for pat in (r"([A-Z][a-z]+ [A-Z][a-z]+)[^.]{0,30}(?:founder|CEO|co-founder)",
                        r"(?:founder|CEO|co-founder)[^.]{0,20}?([A-Z][a-z]+ [A-Z][a-z]+)"):
                m = re.search(pat, blob)
                if m and not TITLE_WORDS.search(m.group(1)):
                    return m.group(1)
        time.sleep(1)
    return None


def score(email, founder):
    local = email.split("@")[0].lower()
    if local in GENERIC or local in PLACEHOLDER:
        return None  # skip generic + example/placeholder addresses
    if "doe" in local or "smith" in local:
        return None  # john/jane doe, j.smith — format-example junk
    if founder and not TITLE_WORDS.search(founder):
        parts = [p.lower() for p in re.split(r"\s+", founder) if len(p) > 1]
        if any(p in local for p in parts):
            return "direct"
    return "inferred"


def hunt(domain, company, founder):
    queries = []
    if founder:
        queries += [
            f'"{founder}" "{company}" email',
            f"site:{domain} {founder}",
            f'"{founder}" "@{domain}"',
            f"{founder} {company} founder email",
        ]
    queries += [f"{company} founder email {domain}", f"site:{domain} founder contact"]

    candidates = {}  # email -> (confidence, source)
    domain_urls = set()

    for q in queries:
        for r in ddg(q, 8):
            blob = f"{r.get('title','')} {r.get('body','')}"
            for e in domain_emails(blob, domain):
                conf = score(e, founder)
                if conf and e not in candidates:
                    candidates[e] = (conf, "ddg-snippet")
            href = r.get("href", "")
            if domain in href:
                domain_urls.add(href.split("?")[0])
        time.sleep(1.2)

    # fetch the company's own pages + any on-domain result URLs
    for path in CANDIDATE_PATHS:
        domain_urls.add(f"https://{domain}{path}")
    for url in list(domain_urls)[:8]:
        for e in domain_emails(fetch(url), domain):
            conf = score(e, founder)
            if conf and e not in candidates:
                candidates[e] = (conf, "site-page")

    # Accept a direct (founder-name) match from anywhere; accept inferred ONLY from a
    # real on-domain page (snippet-only inferred = where placeholder junk comes from).
    usable = {e: v for e, v in candidates.items()
              if v[0] == "direct" or v[1] == "site-page"}
    if not usable:
        return None
    best = sorted(usable.items(), key=lambda kv: 0 if kv[1][0] == "direct" else 1)[0]
    email, (conf, src) = best
    return {"email": email, "confidence": conf, "source": src}


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    db.init()
    conn = db.connect()
    rows = conn.execute(
        """SELECT c.domain, c.name FROM companies c
           WHERE c.status IN ('sourced','named')
             AND NOT EXISTS (SELECT 1 FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL AND k.mx_ok=1)
           ORDER BY c.first_seen LIMIT ?""",
        (limit,),
    ).fetchall()
    print(f"hunting emails for {len(rows)} companies\n")

    for row in rows:
        domain, company = row["domain"], row["name"]
        crow = conn.execute(
            "SELECT founder_name FROM contacts WHERE domain=? AND founder_name IS NOT NULL LIMIT 1", (domain,)
        ).fetchone()
        founder = crow["founder_name"] if crow else None
        if not founder:
            founder = resolve_founder(company, domain)
        print(f"- {company} ({domain}) founder={founder or '?'}")

        res = hunt(domain, company, founder)
        if not res:
            print("    no founder email found")
            db.set_status(conn, domain, "named" if founder else "sourced")
            conn.commit()
            continue

        ok = mx_ok(domain)
        conn.execute(
            "INSERT OR IGNORE INTO contacts (domain, founder_name, email, email_source, email_confidence, mx_ok) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (domain, founder, res["email"], res["source"], res["confidence"], 1 if ok else 0),
        )
        db.set_status(conn, domain, "emailed" if ok else "named")
        conn.commit()
        print(f"    {res['email']}  [{res['confidence']}, {res['source']}]  mx_ok={ok}")

    conn.close()


if __name__ == "__main__":
    main()
