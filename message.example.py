"""Your outreach message — copy this file to `message.py` and edit it.

`message.py` is gitignored, so your name, pitch, and link stay LOCAL and private.
Placeholders {company} and {fn} (first name) are filled per contact; {slug} in LINK
becomes a per-company utm_content value so you can attribute clicks.

Keep it short, human, and honest. This example is the design-partner pitch used by
the author — rewrite it in your own voice.
"""

# Your call-to-action link. Point it wherever you want; keep the {slug} so each
# send gets its own utm_content. (Default points at Canonical, which sources the list.)
LINK = ("https://trycanonical.ai/?utm_source=outreach&utm_medium=email"
        "&utm_campaign=design_partner&utm_content={slug}")

SUBJECT = "found {company} while testing Canonical"

# Each item is one paragraph. Use "__CTA__" where the call-to-action should go.
PARAGRAPHS = [
    "Hi {fn},",
    ("Fun way to find you: I described my ideal customers in plain English to Canonical "
     "and it returned {company} in a verified, domain-keyed shortlist."),
    ("Canonical is a company-search tool — describe the companies you want in plain English "
     "and get back a verified list, including the long-tail accounts standard databases miss."),
    ("I'm taking on a few design partners: generous free credits, a direct line to me, and "
     "real input on the roadmap."),
    "__CTA__",
    "— Your Name",
]

CTA_PLAIN = "Feel free to explore on your own at trycanonical.ai — no need to book a demo."
CTA_HTML = ('Feel free to explore on your own at '
            '<a href="{link}">trycanonical.ai</a> — no need to book a demo.')
