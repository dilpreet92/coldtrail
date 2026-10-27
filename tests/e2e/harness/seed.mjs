// Deterministic fake workspace for the e2e suite. `buildPlan()` lays out every company, contact,
// draft, send, schedule, run and chat from a fixed-seed PRNG (so the same workspace comes out on
// every run), `SEED` summarizes that plan into the numbers specs assert, and `seed(home)` writes
// it into `<home>/outreach.db` (whose schema the coldtrail binary has already created).
//
// Times are stored relative to the moment of seeding (SQLite `datetime('now', <modifier>)`), so
// follow-up states, "sent today" counts and relative dates hold whenever the suite runs.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The company profile (`product.md`) for the `full` and `onboarded` seeds. */
export const PRODUCT_MD = `# Fieldnote

## What we do
Fieldnote turns a founder's call notes into a follow-up plan in minutes.

## Who we help
Seed-stage B2B founders who still run sales themselves.

## Pain
Leads go cold because follow-ups live in scattered notes and inboxes.

## Proof
40 design partners; their median reply rate went from 9% to 21%.

## Offer
A free 30-day pilot, set up together on one call.

## Call to Action
- Link: https://yourproduct.example/?utm_content={slug}

## Voice
Plain, warm and short. No buzzwords.
`;

/** Parked LinkedIn draft reason, exactly as `linkedin::send` stores it. */
export const PARKED_REASON =
  'LinkedIn asks for their email to connect — use Open in LinkedIn and enter it there, ' +
  'or delete this draft';

const XSS = {
  domain: 'xss.example',
  name: '<img src=x onerror=window.__xss=1>',
  founder: 'Mallory <script>window.__xss=2</script>',
  email: 'mallory@xss.example',
  subject: '<img src=x onerror=window.__xss=3> for you',
  body: 'Hi Mallory,\n\n<script>window.__xss=4</script> <b>not bold</b>\n\n— Dee',
};
// Newest-but-two, so the hostile name is on the first Pipeline page by default.
const XSS_POSITION = 2;

const PREFIXES = [
  'Acme', 'Alder', 'Beacon', 'Brightline', 'Cinder', 'Cobalt', 'Delta', 'Driftwood', 'Ember',
  'Evergreen', 'Fathom', 'Foxglove', 'Glacier', 'Granite', 'Harbor', 'Helix', 'Indigo', 'Ironleaf',
  'Jasper', 'Juniper', 'Kestrel', 'Keystone', 'Lark', 'Lumen', 'Meridian', 'Mosaic', 'Nimbus',
  'Northwind', 'Onyx', 'Orchid', 'Pioneer', 'Prism', 'Quarry', 'Quill', 'Redwood', 'Ripple',
  'Sable', 'Summit', 'Thistle', 'Tidal', 'Umbra', 'Upland', 'Vantage', 'Verve', 'Willow', 'Wren',
  'Xenia', 'Yarrow', 'Zenith', 'Zephyr',
];
// Suffix → what a company with that name works on (used in draft copy).
const SUFFIXES = [
  ['Robotics', 'warehouse robotics'], ['Health', 'remote patient monitoring'],
  ['Pay', 'B2B payments'], ['Logistics', 'freight visibility'],
  ['Analytics', 'product analytics'], ['Energy', 'battery storage'],
  ['Foods', 'plant-based foods'], ['Studio', 'design tooling'],
  ['Systems', 'industrial IoT'], ['Bio', 'lab automation'],
  ['Cloud', 'developer infrastructure'], ['Security', 'identity security'],
  ['Capital', 'SMB lending'], ['Works', 'construction software'],
  ['AI', 'AI agents for support teams'], ['Freight', 'cross-border shipping'],
  ['Learning', 'workforce training'], ['Mobility', 'EV fleet charging'],
  ['Data', 'data pipelines'], ['Networks', 'private 5G'],
  ['Materials', 'low-carbon cement'], ['Farms', 'vertical farming'],
  ['Media', 'creator tools'], ['Labs', 'applied research tooling'],
];
const CITIES = [
  'Berlin', 'London', 'Paris', 'Amsterdam', 'Stockholm', 'Lisbon', 'Toronto', 'Austin',
  'New York', 'San Francisco', 'Bangalore', 'Singapore',
];
const FIRST = [
  'Jane', 'Omar', 'Priya', 'Lukas', 'Sofia', 'Mateo', 'Aisha', 'Chen', 'Emma', 'Noah', 'Lea',
  'Arjun', 'Hana', 'Jonas', 'Maya', 'Diego', 'Ines', 'Kenji', 'Zara', 'Felix', 'Nora', 'Ravi',
  'Elena', 'Tom', 'Amara', 'Leon', 'Yuki', 'Sara', 'Ibrahim', 'Clara', 'Hugo', 'Mei', 'Anya',
  'Pablo', 'Freya', 'Sami', 'Lina', 'Marco', 'Ada', 'Theo',
];
const LAST = [
  'Roe', 'Haddad', 'Patel', 'Becker', 'Rossi', 'Garcia', 'Okafor', 'Wei', 'Larsen', 'Kim',
  'Dubois', 'Sharma', 'Sato', 'Weber', 'Cohen', 'Silva', 'Moreau', 'Tanaka', 'Ahmed', 'Novak',
  'Berg', 'Iyer', 'Popescu', 'Walsh', 'Mensah', 'Fischer', 'Mori', 'Lind', 'Hassan', 'Vogel',
  'Laurent', 'Lin', 'Petrova', 'Ortega', 'Nilsson', 'Aziz', 'Costa', 'Ricci', 'Lovelace', 'Grant',
];
const ROLES = ['CEO & co-founder', 'CTO & co-founder', 'Founder'];
const EMAIL_SOURCES = ['site-page', 'websearch', 'canonical', 'github'];

// Source queries and how many companies each one sourced (most first, no ties).
const QUERIES = [
  ['Q1', 400], ['Q2', 200], ['Q3', 150], ['Q4', 120], ['Q5', 100], ['Q6', 90], ['Q7', 80],
  ['Q8', 60],
];

// How many companies get each role in the plan (besides the hostile one and the follow-ups).
const KIND_COUNTS = {
  sourced: 590,
  named: 183,
  emailed: 300,
  draft_email: 11, // + the hostile company = 12 email drafts
  draft_linkedin: 40,
  skip: 60,
};
const SECOND_CONTACTS = 30; // the newest 30 `emailed` companies have a co-founder on file too
const SKIP_WITH_CONTACT = 20; // the newest 20 skipped companies were enriched before skipping

// Sent history: days since each send (oldest first), the channel, and the state
// `/api/followups` must derive from it (checked against its rule when the plan is built).
const FOLLOWUPS = [
  { state: 'due', days: [5] },
  { state: 'due', days: [6] },
  { state: 'due', days: [14, 9] },
  { state: 'due', days: [12] },
  { state: 'awaiting', days: [0] },
  { state: 'awaiting', days: [1] },
  { state: 'awaiting', days: [3] },
  { state: 'awaiting', days: [20, 15, 10] },
  { state: 'awaiting', days: [0], channel: 'linkedin' },
  { state: 'awaiting', days: [2], channel: 'linkedin' },
  { state: 'replied', days: [7] },
  { state: 'replied', days: [11] },
  { state: 'replied', days: [2] },
  { state: 'bounced', days: [6] },
  { state: 'bounced', days: [13] },
];
// Follow-up companies sit among the oldest (sourced ~21+ days ago, before their first send).
const FOLLOWUP_POSITIONS_FROM = 1000;

const SCHEDULES = {
  lunch: {
    id: 'a7f3c2e1-5b4d-4c8e-9f10-2d3e4f5a6b01',
    name: 'Lunch Source',
    enabled: true,
    freq: 'daily',
    time: '13:00',
    weekday: null,
    task_mode: 'agent',
    prompt: null,
  },
  weekly: {
    id: 'a7f3c2e1-5b4d-4c8e-9f10-2d3e4f5a6b02',
    name: 'Weekly custom',
    enabled: false,
    freq: 'weekly',
    time: '09:00',
    weekday: 1,
    task_mode: 'custom',
    prompt: 'Find 10 fintechs',
  },
};

const CHATS = {
  berlin: {
    id: 'c3d1e2f0-0000-4000-8000-000000000001',
    title: 'Find fintech founders in Berlin',
    minutesAgo: 60,
    messages: [
      ['user', 'Find fintech founders in Berlin'],
      ['tool', '$ coldtrail source "fintech startups in Berlin" "Berl…'],
      ['tool', '$ coldtrail find-emails 20'],
      [
        'assistant',
        'Sourced **24** fintech companies in Berlin and found **11** founder contacts.\n\n' +
          '- 9 email drafts are waiting in Drafts\n' +
          '- 2 LinkedIn notes are ready to send\n\n' +
          'One result was literally named <img src=x onerror=window.__xss=5>, so I skipped it.\n\n' +
          'Run `coldtrail find-emails 20` again to keep going, or read ' +
          '[the Canonical docs](https://trycanonical.ai/docs).',
      ],
    ],
  },
  scheduled: {
    id: 'c3d1e2f0-0000-4000-8000-000000000002',
    title: 'Scheduled run — Lunch Source',
    minutesAgo: 2 * 1440,
    messages: [
      ['user', 'Run the coldtrail loop: source, enrich, draft, then hand off.'],
      ['tool', '$ coldtrail source "B2B payments startups" "SMB lend…'],
      ['tool', '$ coldtrail find-emails 20'],
      ['tool', '$ coldtrail draft brightline-pay.example --subject…'],
      [
        'assistant',
        'Sourced **41** companies, found **19** contacts and wrote **16** drafts.\n\n' +
          '1. 12 email drafts are in Drafts\n' +
          '2. 4 LinkedIn notes are waiting for Open in LinkedIn\n\n' +
          'I worked 41 of 41; 22 remain un-enriched.',
      ],
    ],
  },
  notes: {
    id: 'c3d1e2f0-0000-4000-8000-000000000003',
    title: 'Draft LinkedIn notes for Q2',
    minutesAgo: 3 * 1440,
    messages: [
      ['user', 'Draft LinkedIn notes for the Q2 companies that only have a LinkedIn URL.'],
      ['assistant', 'Done — 6 LinkedIn notes are in Drafts, each under 240 characters.'],
    ],
  },
};

// Oldest first; the newest run failed, so Home has one thing that needs the human.
const RUNS = [
  { daysAgo: 5, status: 'ok', schedule: 'lunch', trigger: 'scheduled', counts: [38, 21, 17, 0] },
  { daysAgo: 4, status: 'ok', schedule: null, trigger: 'manual', counts: [12, 6, 5, 0] },
  { daysAgo: 3, status: 'ok', schedule: 'weekly', trigger: 'dry', counts: [10, 4, 4, 0] },
  {
    daysAgo: 2,
    status: 'ok',
    schedule: 'lunch',
    trigger: 'scheduled',
    counts: [41, 19, 16, 0],
    chat: 'scheduled',
  },
  {
    daysAgo: 1,
    status: 'error',
    schedule: 'lunch',
    trigger: 'scheduled',
    counts: [0, 0, 0, 0],
    note: 'opencode exited with status 1',
  },
];

/** mulberry32: a tiny fixed-seed PRNG, so the plan is identical on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
const repeat = (value, n) => Array.from({ length: n }, () => value);
const minutes = (n) => `-${n} minutes`;
const pick = (list, rand) => list[Math.floor(rand() * list.length)];

/** The workspace, company by company, in Pipeline order (newest first). */
function buildPlan() {
  const rand = prng(20261027);
  const total = QUERIES.reduce((n, [, c]) => n + c, 0);
  if (PREFIXES.length * SUFFIXES.length !== total) throw new Error('seed: name grid != companies');

  // Who is what: the hostile company and the follow-ups have fixed slots, the rest is shuffled.
  const kinds = new Array(total);
  kinds[XSS_POSITION] = 'xss';
  const fuSlots = shuffle(range(FOLLOWUP_POSITIONS_FROM, total), rand)
    .slice(0, FOLLOWUPS.length)
    .sort((a, b) => a - b);
  fuSlots.forEach((p, i) => (kinds[p] = { followup: FOLLOWUPS[i] }));
  const pool = shuffle(
    Object.entries(KIND_COUNTS).flatMap(([kind, n]) => repeat(kind, n)),
    rand,
  );
  for (let p = 0, k = 0; p < total; p++) if (kinds[p] === undefined) kinds[p] = pool[k++];
  if (kinds.some((k) => k === undefined) || pool.length + 1 + FOLLOWUPS.length !== total) {
    throw new Error('seed: kind counts do not add up to the company count');
  }

  const queries = shuffle(
    QUERIES.flatMap(([q, n]) => repeat(q, n)),
    rand,
  );
  const names = shuffle(range(0, total), rand);
  const person = () => ({ first: pick(FIRST, rand), last: pick(LAST, rand) });

  let named = 0;
  let emailed = 0;
  let skipped = 0;
  let linkedinDrafts = 0;
  const companies = [];
  for (let p = 0; p < total; p++) {
    const kind = kinds[p];
    const [suffix, blurb] = SUFFIXES[Math.floor(names[p] / PREFIXES.length)];
    let name = `${PREFIXES[names[p] % PREFIXES.length]} ${suffix}`;
    let domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example`;
    if (kind === 'xss') ({ name, domain } = XSS);
    const slug = domain.replace(/\.example$/, '');
    const minutesAgo = 60 + p * 30; // first_seen: p half-hours before the newest
    const c = {
      domain,
      name,
      hq: pick(CITIES, rand),
      employees: 3 + Math.floor(rand() * 240),
      founding_year: 2012 + Math.floor(rand() * 13),
      source_query: queries[p],
      minutesAgo,
      status: 'sourced',
      contacts: [],
      outreach: [],
    };
    const link = `https://yourproduct.example/?utm_content=${slug}`;
    const contact = (who, { email = true, linkedin = false, mx = 1, role } = {}) => {
      const rec = {
        founder_name: `${who.first} ${who.last}`,
        role: role ?? ROLES[c.contacts.length % ROLES.length],
        email: email ? `${who.first.toLowerCase()}@${domain}` : null,
        email_source: email ? EMAIL_SOURCES[(p + c.contacts.length) % EMAIL_SOURCES.length] : null,
        email_confidence: email ? (mx ? (p % 2 ? 'inferred' : 'direct') : 'inferred') : null,
        mx_ok: email ? mx : null,
        linkedin_url: linkedin
          ? `https://www.linkedin.com/in/${who.first}-${who.last}-${p}`.toLowerCase()
          : null,
      };
      c.contacts.push(rec);
      return { ...who, index: c.contacts.length - 1 };
    };
    const emailDraft = (who) =>
      c.outreach.push({
        contact: who.index,
        channel: 'email',
        subject: `Quick idea for ${name}`,
        body:
          `Hi ${who.first},\n\nSaw that ${name} is working on ${blurb} — that's where founders ` +
          `lose hours to follow-ups that live in scattered notes.\n\nFieldnote turns call notes ` +
          `into a follow-up plan in minutes. Worth a 15-minute call next week?\n\n— Dee\n${link}`,
        utm_url: link,
        gmail_draft_id: null,
        created: minutes(minutesAgo - 20),
        sent: null,
        status: 'draft_pending',
      });
    const note = (who) =>
      `Hi ${who.first},\n\nLoved what ${name} is doing in ${blurb}.\n\n` +
      `Would be glad to connect.\n\n— Dee\n${link}`;

    if (kind === 'named') {
      // Found a founder but no verified email: a LinkedIn profile, or an address that failed MX.
      const linkedinOnly = named++ % 2 === 0;
      contact(person(), { email: !linkedinOnly, linkedin: linkedinOnly, mx: 0 });
      c.status = 'named';
    } else if (kind === 'emailed') {
      contact(person(), { linkedin: p % 3 === 0 });
      if (emailed++ < SECOND_CONTACTS) {
        const second = person();
        if (emailed % 2) {
          c.contacts.push({
            founder_name: `${second.first} ${second.last}`,
            role: 'COO & co-founder',
            email: `${second.first}.${second.last}@${domain}`.toLowerCase(),
            email_source: 'site-page',
            email_confidence: 'inferred',
            mx_ok: 1,
            linkedin_url: null,
          });
        } else {
          contact(second, { email: false, linkedin: true, role: 'COO & co-founder' });
        }
      }
      c.status = 'emailed';
    } else if (kind === 'skip') {
      if (skipped++ < SKIP_WITH_CONTACT) contact(person());
      c.status = 'skip';
    } else if (kind === 'xss') {
      c.contacts.push({
        founder_name: XSS.founder,
        role: 'Founder',
        email: XSS.email,
        email_source: 'websearch',
        email_confidence: 'direct',
        mx_ok: 1,
        linkedin_url: null,
      });
      c.outreach.push({
        contact: 0,
        channel: 'email',
        subject: XSS.subject,
        body: XSS.body,
        utm_url: link,
        gmail_draft_id: null,
        created: minutes(minutesAgo - 20),
        sent: null,
        status: 'draft_pending',
      });
      c.status = 'drafted';
    } else if (kind === 'draft_email') {
      emailDraft(contact(person(), { linkedin: p % 2 === 0 }));
      c.status = 'drafted';
    } else if (kind === 'draft_linkedin') {
      const who = contact(person(), { email: false, linkedin: true });
      c.outreach.push({
        contact: who.index,
        channel: 'linkedin',
        subject: '',
        body: note(who),
        utm_url: null,
        gmail_draft_id: null,
        created: minutes(minutesAgo - 20),
        sent: null,
        status: 'draft_pending',
        // The third LinkedIn draft in the list is parked: LinkedIn wanted the member's email.
        auto_skip: linkedinDrafts++ === 2 ? PARKED_REASON : null,
      });
      c.status = 'drafted';
    } else if (kind.followup) {
      const fu = kind.followup;
      const channel = fu.channel ?? 'email';
      const who =
        channel === 'linkedin'
          ? contact(person(), { email: false, linkedin: true })
          : contact(person(), { linkedin: p % 2 === 0 });
      const rowStatus = { due: 'sent', awaiting: 'sent', replied: 'replied', bounced: 'bounced' }[
        fu.state
      ];
      fu.days.forEach((d, i) =>
        c.outreach.push({
          contact: who.index,
          channel,
          subject: channel === 'email' ? `${i ? 'Re: ' : ''}Quick idea for ${name}` : '',
          body: channel === 'email' ? `Hi ${who.first}, following up on Fieldnote.` : note(who),
          utm_url: link,
          gmail_draft_id: null,
          created: minutes(d * 1440 + 60),
          sent: d ? `-${d} days` : '+0 minutes',
          status: rowStatus,
          reply: fu.state === 'replied' ? 'Thanks — happy to chat next week.' : null,
        }),
      );
      c.status = rowStatus;
      c.followup = fu;
    }
    companies.push(c);
  }
  // The two oldest plain email drafts were already pushed into Gmail (status `drafted`).
  companies
    .filter((c) => c.outreach.some((o) => o.channel === 'email' && o.status === 'draft_pending'))
    .filter((c) => c.domain !== XSS.domain)
    .slice(-2)
    .forEach((c, i) => {
      c.outreach[0].status = 'drafted';
      c.outreach[0].gmail_draft_id = `r-seed-${i + 1}`;
    });
  return companies;
}

/** Counts per key, most common first; ties would make the API's order ambiguous, so none allowed. */
function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const out = [...counts].sort((a, b) => b[1] - a[1]);
  if (new Set(out.map(([, n]) => n)).size !== out.length) throw new Error('seed: tied tally');
  return out;
}

/** Whole days since an outreach row was sent (its `sent` modifier is `-N days` or now). */
const sentDaysAgo = (o) => (o.sent === '+0 minutes' ? 0 : parseInt(o.sent.slice(1), 10));

/** The same follow-up rule as `pipeline::followup_rows`. */
function followupState(rows) {
  if (rows.some((o) => o.status === 'replied')) return 'replied';
  if (rows.some((o) => o.status === 'bounced')) return 'bounced';
  const days = Math.min(...rows.map(sentDaysAgo));
  return days >= 4 && rows.length < 3 ? 'due' : 'awaiting';
}

function summarize(companies) {
  const outreach = companies.flatMap((c) => c.outreach.map((o) => ({ ...o, company: c })));
  const pending = outreach
    .filter((o) => o.status === 'draft_pending' || o.status === 'drafted')
    .sort((a, b) => a.company.minutesAgo - b.company.minutesAgo); // `/api/drafts`: newest first
  const sentRows = outreach.filter((o) => ['sent', 'replied', 'bounced'].includes(o.status));
  const fu = companies.filter((c) => c.followup);
  for (const c of fu) {
    const state = followupState(c.outreach);
    if (state !== c.followup.state) {
      throw new Error(`seed: ${c.domain} is ${state}, not ${c.followup.state}`);
    }
  }
  const reachable = (c) => c.contacts.some((k) => k.email || k.linkedin_url);
  const recipient = (o) => {
    const k = o.company.contacts[o.contact];
    return o.channel === 'linkedin' ? k.linkedin_url : k.email;
  };
  const sentWithin = (channel, days) =>
    sentRows.filter((o) => o.status === 'sent' && o.channel === channel && sentDaysAgo(o) <= days)
      .length;
  const parked = pending.find((o) => o.auto_skip);
  const repliedDomains = new Set(
    outreach.filter((o) => o.status === 'replied').map((o) => o.company.domain),
  );
  const runs = RUNS.map((r) => ({
    daysAgo: r.daysAgo,
    status: r.status,
    trigger: r.trigger,
    schedule_name: r.schedule ? SCHEDULES[r.schedule].name : null,
    chat_id: r.chat ? CHATS[r.chat].id : null,
    sourced: r.counts[0],
    enriched: r.counts[1],
    drafted: r.counts[2],
    sent: r.counts[3],
  }));

  return {
    companies: companies.length,
    contacts: companies.reduce((n, c) => n + c.contacts.length, 0),
    /** `GET /api/summary` → `counts`. */
    counts: {
      companies: companies.length,
      contacts: companies.reduce((n, c) => n + c.contacts.length, 0),
      drafts: pending.length,
      drafts_email: pending.filter((o) => o.channel === 'email').length,
      drafts_linkedin: pending.filter((o) => o.channel === 'linkedin').length,
      followups_due: fu.filter((c) => c.followup.state === 'due').length,
      replied: outreach.filter((o) => o.status === 'replied').length,
      sent: sentRows.length,
    },
    /** `GET /api/summary` → `funnel`. */
    funnel: [
      ['sourced', companies.length],
      ['contact_found', companies.filter(reachable).length],
      ['drafted', companies.filter((c) => c.outreach.length).length],
      ['sent', new Set(sentRows.map((o) => o.company.domain)).size],
      ['replied', repliedDomains.size],
    ],
    /** `GET /api/companies` → `stages` (company status counts) and `queries`, unfiltered. */
    stages: tally(companies.map((c) => c.status)),
    queries: tally(companies.map((c) => c.source_query)),
    drafts: {
      email: pending.filter((o) => o.channel === 'email').length,
      linkedin: pending.filter((o) => o.channel === 'linkedin').length,
      /** LinkedIn drafts the bulk sender would queue (not parked). */
      linkedinSendable: pending.filter((o) => o.channel === 'linkedin' && !o.auto_skip).length,
      parked: { domain: parked.company.domain, reason: parked.auto_skip },
      /** Domains in `/api/drafts` order (newest first). */
      order: pending.map((o) => o.company.domain),
    },
    emailDrafts: pending
      .filter((o) => o.channel === 'email')
      .map((o) => ({
        domain: o.company.domain,
        name: o.company.name,
        to: recipient(o),
        subject: o.subject,
        status: o.status,
      })),
    linkedinDrafts: pending
      .filter((o) => o.channel === 'linkedin')
      .map((o) => ({
        domain: o.company.domain,
        name: o.company.name,
        to: recipient(o),
        body: o.body,
        parked: Boolean(o.auto_skip),
      })),
    /** `GET /api/followups` rows per `state`. */
    followups: Object.fromEntries(tally(fu.map((c) => c.followup.state))),
    /** Sends the daily / rolling-7-day caps count (`status = 'sent'` rows only). */
    capUsage: {
      emailToday: sentWithin('email', 0),
      linkedinToday: sentWithin('linkedin', 0),
      linkedin7d: sentWithin('linkedin', 7),
    },
    xss: { ...XSS },
    schedules: structuredClone(SCHEDULES),
    /** Oldest first, as inserted (`/api/runs` lists newest first). */
    runs,
    chats: {
      /** `/api/chats` order: most recently updated first. */
      list: Object.values(CHATS)
        .sort((a, b) => a.minutesAgo - b.minutesAgo)
        .map(({ id, title }) => ({ id, title })),
      berlin: { id: CHATS.berlin.id, title: CHATS.berlin.title },
      scheduled: { id: CHATS.scheduled.id, title: CHATS.scheduled.title },
      notes: { id: CHATS.notes.id, title: CHATS.notes.title },
    },
  };
}

const PLAN = buildPlan();

/**
 * Every company in Pipeline order (newest first) with its contacts and outreach, for specs that
 * need a specific record (e.g. a company with two contacts, or one with a sent history).
 */
export const COMPANIES = PLAN.map(({ minutesAgo, followup, outreach, ...c }) => ({
  ...c,
  contacts: c.contacts.map((k) => ({ ...k })),
  outreach: outreach.map(({ contact, created, sent, ...o }) => ({ ...o })),
  followup: followup ? followup.state : null,
}));

/** The numbers and records the `full` seed guarantees. */
export const SEED = summarize(PLAN);

/** Write the `full` workspace into `<home>/outreach.db` (schema must already exist). */
export function seed(home) {
  const db = new DatabaseSync(join(home, 'outreach.db'));
  // Every time column is `datetime('now', <modifier>)`; a NULL modifier gives NULL (unsent rows).
  const insert = (table, columns, timeColumns = []) =>
    db.prepare(
      `INSERT INTO ${table} (${[...columns, ...timeColumns].join(', ')}) VALUES (` +
        [...columns.map(() => '?'), ...timeColumns.map(() => "datetime('now', ?)")].join(', ') +
        ')',
    );
  try {
    db.exec('BEGIN');
    const company = insert(
      'companies',
      ['domain', 'name', 'hq', 'employees', 'founding_year', 'source_query', 'status'],
      ['first_seen'],
    );
    const contact = insert(
      'contacts',
      ['domain', 'founder_name', 'role', 'linkedin_url', 'email', 'email_source',
        'email_confidence', 'mx_ok'],
      ['found_at'],
    );
    const outreach = insert(
      'outreach',
      ['domain', 'contact_id', 'channel', 'subject', 'body', 'utm_url', 'gmail_draft_id', 'status',
        'reply', 'auto_skip'],
      ['created_at', 'sent_at'],
    );
    for (const c of PLAN) {
      const { domain } = c;
      company.run(
        domain, c.name, c.hq, c.employees, c.founding_year, c.source_query, c.status,
        minutes(c.minutesAgo),
      );
      const ids = c.contacts.map(
        (k) =>
          contact.run(
            domain, k.founder_name, k.role, k.linkedin_url, k.email, k.email_source,
            k.email_confidence, k.mx_ok, minutes(c.minutesAgo - 10),
          ).lastInsertRowid,
      );
      for (const o of c.outreach) {
        outreach.run(
          domain, ids[o.contact], o.channel, o.subject, o.body, o.utm_url, o.gmail_draft_id,
          o.status, o.reply ?? null, o.auto_skip ?? null, o.created, o.sent,
        );
      }
    }

    const schedule = insert(
      'schedules',
      ['id', 'name', 'enabled', 'freq', 'time', 'weekday', 'task_mode', 'prompt'],
      ['created_at', 'updated_at'],
    );
    Object.values(SCHEDULES).forEach((s, i) => {
      const when = minutes((10 - i) * 1440); // the Lunch schedule is the older one
      schedule.run(
        s.id, s.name, s.enabled ? 1 : 0, s.freq, s.time, s.weekday, s.task_mode, s.prompt,
        when, when,
      );
    });

    const chat = insert(
      'chat_sessions',
      ['id', 'agent_session_id', 'title', 'running'],
      ['created_at', 'updated_at'],
    );
    const message = insert('chat_messages', ['session_id', 'role', 'content'], ['created_at']);
    Object.values(CHATS).forEach((ch, i) => {
      const startedAgo = ch.minutesAgo + ch.messages.length;
      chat.run(ch.id, `ses_seed_${i + 1}`, ch.title, 0, minutes(startedAgo), minutes(ch.minutesAgo));
      ch.messages.forEach(([role, content], j) =>
        message.run(ch.id, role, content, minutes(startedAgo - j - 1)),
      );
    });

    const run = insert(
      'scheduled_runs',
      ['status', 'sourced', 'enriched', 'drafted', 'sent', 'chat_id', 'note', 'schedule_id',
        'trigger'],
      ['started_at', 'finished_at'],
    );
    for (const r of RUNS) {
      const started = r.daysAgo * 1440;
      run.run(
        r.status, ...r.counts, r.chat ? CHATS[r.chat].id : null, r.note ?? null,
        r.schedule ? SCHEDULES[r.schedule].id : null, r.trigger,
        minutes(started), minutes(started - 6),
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}
