"""Import Canonical search results (JSON) into the companies table, deduped by domain.

Usage:
    python import_companies.py <results.json> "<source_query label>"

Accepts either:
  - a raw Canonical response object ({"results": [...]}) or a bare [...] list, or
  - the persisted MCP tool-result wrapper: [{"type":"text","text":"<json string>"}].

Also seeds contacts.founder_name from Canonical leadership when present, so the
email hunter has a name to work with.
"""
import json
import sys
import db


def load_results(path):
    with open(path) as f:
        raw = json.load(f)
    # MCP tool-result wrapper: [{"type":"text","text":"{...}"}]
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "text" in raw[0]:
        raw = json.loads(raw[0]["text"])
    if isinstance(raw, dict):
        return raw.get("results", [])
    return raw  # already a list of company dicts


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    path, source_query = sys.argv[1], sys.argv[2]
    results = load_results(path)

    db.init()
    conn = db.connect()
    added = skipped = 0
    for r in results:
        domain = (r.get("domain") or "").strip().lower()
        if not domain:
            continue
        is_new = db.upsert_company(
            conn, domain, r.get("name"), r.get("headquarters"),
            r.get("employee_count"), r.get("founding_year"), source_query,
        )
        if is_new:
            added += 1
        else:
            skipped += 1
    conn.commit()
    conn.close()
    print(f"imported: {added} new, {skipped} already-known (deduped) from {len(results)} results")


if __name__ == "__main__":
    main()
