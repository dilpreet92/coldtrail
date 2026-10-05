# Enrichment playbook — finding a founder's email or LinkedIn (free, honest)

coldtrail's provider-agnostic guide for step 2 of the loop. Goal: **one real founder /
decision-maker contact per company, with provenance** — an MX-verified email, a LinkedIn
profile URL, or both. Prefer an *observed* email address (seen in a real artifact) over a
*guessed* pattern. Never fabricate. If nothing verifies, store nothing and say so — a
missing contact is fine; an invented one is not.

**A LinkedIn URL alone is enough to make a company reachable** — it doesn't need an email
too. Capture it wherever you find one: Canonical's company details often carry the founder's
LinkedIn already (check there first), and a web search (`site:linkedin.com/in <name>
<company>`) is the fallback. Work the email ladder below regardless — email still wins when
both exist (the one-touch rule prefers it) — but don't skip a company just because the email
rungs come up empty if you have a LinkedIn URL for them.

Work down this ladder and stop as soon as you have a verified address. Use whatever tools
your runtime actually has (shell/web on the CLI backends; coldtrail's own commands
everywhere) — skip a rung you can't run rather than stalling.

## The ladder

0. **Capture the LinkedIn URL first — it's usually already sitting there.** Check Canonical's
   company details for the founder's `linkedin_url` before searching anything; when it's absent,
   a web search `site:linkedin.com/in <name> <company>` almost always finds it. Do this
   regardless of how the email rungs below turn out — a LinkedIn URL is its own reachable
   contact, not a fallback for a failed email search.

1. **OSINT tools, if installed** (check PATH first — they may not be present):
   - `theHarvester -d <domain> -b all` — emails / names / subdomains across many sources.
   - `spiderfoot -s <domain> -m sfp_hunter,sfp_emailrep,sfp_names -o json` — deeper graph.

2. **GitHub commit metadata** — often the highest-signal free source for technical founders.
   Find the founder's GitHub (their name + company, or the company org), then read a public
   commit's *author email* (the real address they committed with) via the commit `.patch` or
   the API (`commit.author.email`). A `…@users.noreply.github.com` address does not count.
   An address found this way is **observed, not guessed** — the strongest kind.

3. **Certificate transparency (crt.sh)** — widen the surface with real hosts/subdomains:
   `https://crt.sh/?q=%25.<domain>&output=json`.

4. **WHOIS / DNS** — registrant/admin contact when not privacy-masked; MX records reveal the
   mail host and confirm the domain accepts mail.

5. **On-domain + web** — about / team / contact pages, and a web search for
   "<founder> <company> email". **If your runtime has its own web tools, use them for this rung** —
   Claude Code's `WebSearch` + `WebFetch`, Codex's built-in `web_search`, or opencode's
   `websearch` + `webfetch`. They return ranked,
   real results and extract far better than HTML scraping. `coldtrail find-emails` is the
   **fallback** for backends with no web tool (BYOK / local models): it automates a DuckDuckGo +
   on-domain scan, but it's slower and lower-signal (snippet noise, throttling), so reach for your
   native search first whenever you have it.

6. **Pattern — last resort, and only when confirmed.** If aggregators report a house pattern
   (e.g. `{first}@domain`), treat it as a *hypothesis*. Confirm it against at least one
   observed address from steps 1–5 before trusting it. A pattern alone, unconfirmed, is a
   guess — do not store it.

## Cross-verify, then store

- Trust an address that appears in ≥2 independent places, or one observed artifact that
  matches a reported pattern (that match is what makes it "observed, not guessed").
- Store with provenance:
  `coldtrail add-contact <domain> "<Full Name>" [email] --linkedin <url> <source>`
  — source e.g. `github-commit-metadata`, `crt.sh`, `whois`, `site-team-page`, `theHarvester`,
  `canonical`, `websearch`. Email and `--linkedin` are each optional but at least one is
  required; pass whichever (or both) you found.
- `add-contact` MX-verifies any email supplied and rejects generic (`info@`, `sales@`, …) and
  placeholder addresses — don't work around it. A LinkedIn URL is recorded as-is (no email
  verification applies to it).

## Honesty rules (non-negotiable)

- Never invent a name or address. **Observed > guessed**, always.
- Cite where each address came from — in the stored `source` and in your summary to the user.
- If nothing verifiable turns up, store nothing and say so plainly.

_Keep adding techniques here as you discover them — this file is coldtrail's growing tradecraft._
