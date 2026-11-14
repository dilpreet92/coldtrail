// The README demo's workspace: a credible, entirely fictional B2B workspace for `record.mjs`.
//
// Ledgerlane (an invented reconciliation product for fintech finance teams) has been running
// coldtrail for a few weeks: ~40 companies across every stage, a few sends, replies and drafts,
// two schedules and some runs. The scripted agent (bin/opencode) then "sources" 24 more during the
// recording: its three batches (new companies, the founders it found, the drafts it wrote) are
// written here as SQL files it applies between steps, so the sidebar counts, Pipeline and Drafts
// really change after the run.
//
// Everything is invented: company and person names, and every domain is on the reserved
// `.example` TLD. Times are relative to the moment of seeding (SQLite `datetime('now', ...)`).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** What `opencode models` lists, and the model the workspace is pinned to. */
export const MODELS = ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.1', 'opencode/deepseek-v4.1-flash-free'];
export const MODEL = MODELS[0];

export const CONFIG_TOML = `agent = "opencode"\nopencode_model = "${MODEL}"\n`;

// A stored (fake) Canonical token is what makes the workspace count as connected. It is never
// used: nothing in the demo sources for real, and its endpoint is unresolvable (.invalid).
export const SECRETS_TOML = `[tokens.canonical]
access = "demo-canonical-access-token"
token_endpoint = "https://canonical.invalid/oauth/token"
client_id = "coldtrail-demo"
`;

const CTA = 'https://ledgerlane.example/audit?utm_content=';
const link = (domain) => `${CTA}${domain.replace(/\.example$/, '')}`;

/** The company profile: every checklist section filled, the CTA a real (fictional) link. */
export const PRODUCT_MD = `# Ledgerlane — company profile

## What we do
Ledgerlane matches every payout, fee and refund to the bank line it landed on, so fintech finance teams close the month without spreadsheets.

## Who we help
Seed to Series B fintechs in Europe (payments, lending, embedded finance) where one or two people in finance or ops still reconcile by hand.

## The pain / value
Money settles across several PSPs and banks, in several currencies. Every month someone spends days matching CSV exports line by line, and small breaks slip through until an auditor or a partner bank finds them.

## Proof / differentiator
- 31 fintech teams use Ledgerlane; their median month-end close went from 9 days to 2.
- Connects to the main European PSPs and banks in an afternoon, without an engineering ticket.
- Flags a break the day it happens, not at month end.

## Offer
A free reconciliation audit: we run one month of your payouts through Ledgerlane and show you every unmatched line.

## Call to Action
- Link: ${CTA}{slug}

## Voice & sign-off
Plain, specific and short: one real observation about their company, one line on what we do, one easy ask. No buzzwords, no fake urgency.
Sign off as Maya, co-founder of Ledgerlane.
`;

/** The line record.mjs types into the profile ("Who we help"), so it visibly saves. */
export const PROFILE_ADDITION = ' Best fit: teams paying out to 1,000+ merchants a month.';
export const PROFILE_ANCHOR = 'still reconcile by hand.';

const sign = (domain) => `Maya\nCo-founder, Ledgerlane\n${link(domain)}`;

// ---------------------------------------------------------------------------------------------
// Companies already in the workspace, newest first. `days`: days since it was sourced.

const Q_UK = 'payments infrastructure, UK + Ireland';
const Q_LEND = 'SME lending platforms, Europe';
const Q_SPEND = 'spend management startups, EU';

const li = (full) => `https://www.linkedin.com/in/${full.toLowerCase().replace(/[^a-z]+/g, '-')}`;

/**
 * Each company: domain, name, hq, employees, founded, query, days, status, contacts, outreach.
 * Contact: [name, role, { email?, linkedin?, source?, confidence?, mx? }].
 * Outreach: { channel, subject, body, status, created (days ago), sent (days ago), reply? }.
 */
const EXISTING = [];
function company(c) {
  EXISTING.push({ contacts: [], outreach: [], ...c });
}

// --- In Gmail / pending drafts (sourced a few days ago) ---
company({
  domain: 'selvane.example', name: 'Selvane', hq: 'Zurich', employees: 16, founded: 2022,
  query: Q_SPEND, days: 2.1, status: 'emailed',
  contacts: [['Luca Meier', 'CEO & co-founder', { email: 'luca@selvane.example', source: 'site-page' }]],
  outreach: [{
    channel: 'email', status: 'draft_pending', created: 2.0,
    subject: 'Month-end with 14 currency accounts',
    body:
      'Hi Luca,\n\nSelvane gives exporters an account in 14 currencies, which I imagine means your own ' +
      'finance team matches inbound FX, fees and payouts across a lot of banks every month.\n\n' +
      'Ledgerlane does that matching automatically and flags a break the day it happens. Teams like ' +
      'yours went from a 9-day close to 2.\n\nWould a free audit of one month of payouts be useful? ' +
      'We send back every line that does not match.\n\n' + sign('selvane.example'),
  }],
});
company({
  domain: 'brisacredit.example', name: 'Brisa Credit', hq: 'Porto', employees: 10, founded: 2023,
  query: Q_LEND, days: 2.3, status: 'emailed',
  contacts: [['Rui Almeida', 'Founder', { email: 'rui@brisacredit.example', source: 'canonical' }]],
  outreach: [{
    channel: 'email', status: 'draft_pending', created: 2.2,
    subject: 'Repayments landing in three places',
    body:
      'Hi Rui,\n\nWith revenue-based financing, Brisa collects a slice of each merchant\'s Shopify and ' +
      'Stripe payouts, so a single repayment can arrive split across processors and days.\n\n' +
      'Ledgerlane ties each of those pieces back to the advance it belongs to and shows what is still ' +
      'outstanding, without the spreadsheet.\n\nOpen to a free audit of one month? It takes us a day ' +
      'and you keep the report.\n\n' + sign('brisacredit.example'),
  }],
});
company({
  domain: 'corvana.example', name: 'Corvana', hq: 'Vienna', employees: 25, founded: 2021,
  query: Q_LEND, days: 2.6, status: 'emailed',
  contacts: [['Teresa Huber', 'CEO & co-founder', { email: 'teresa@corvana.example', source: 'site-page' }]],
  outreach: [{
    channel: 'email', status: 'draft_pending', created: 2.5,
    subject: 'Corvana\'s wholesale settlements',
    body:
      'Hi Teresa,\n\nCongrats on the Austrian wholesaler rollout. Paying suppliers upfront and collecting ' +
      'from buyers 60 days later is exactly where reconciliation quietly gets expensive.\n\n' +
      'Ledgerlane matches both sides to your bank lines automatically and flags anything that does not ' +
      'net out, the day it happens.\n\nWorth a 20-minute look? I can run one month of your data through ' +
      'it first.\n\n' + sign('corvana.example'),
  }],
});
company({
  domain: 'haldenpay.example', name: 'Halden Pay', hq: 'Helsinki', employees: 18, founded: 2022,
  query: Q_SPEND, days: 2.9, status: 'emailed',
  contacts: [['Mikko Laine', 'CEO & co-founder', { email: 'mikko@haldenpay.example', source: 'websearch' }]],
  outreach: [{
    channel: 'email', status: 'draft_pending', created: 2.8,
    subject: 'Failed retries at Halden',
    body:
      'Hi Mikko,\n\nRecurring B2B billing means retries, partial payments and refunds, and each one lands ' +
      'on the bank statement as its own line.\n\nLedgerlane matches those back to the right invoice ' +
      'automatically, so month-end stops being a week of CSVs. Our customers close in 2 days on median.\n\n' +
      'Happy to run a free audit on one month of Halden\'s payouts if that is useful.\n\n' +
      sign('haldenpay.example'),
  }],
});
company({
  domain: 'larkspurledger.example', name: 'Larkspur Ledger', hq: 'Ghent', employees: 7, founded: 2024,
  query: Q_SPEND, days: 3.2, status: 'named',
  contacts: [['Hanne Peeters', 'Founder', { linkedin: li('Hanne Peeters') }]],
  outreach: [{
    channel: 'linkedin', status: 'draft_pending', created: 3.1, subject: '',
    body:
      'Hi Hanne, I liked your post on why accounting APIs still stop at the invoice. We match payouts to ' +
      'bank lines for fintech finance teams. Would be glad to connect and compare notes.\n' +
      link('larkspurledger.example'),
  }],
});
company({
  domain: 'ostwindfinance.example', name: 'Ostwind Finance', hq: 'Hamburg', employees: 8, founded: 2024,
  query: Q_LEND, days: 3.4, status: 'named',
  contacts: [['Finn Petersen', 'CEO & co-founder', { linkedin: li('Finn Petersen') }]],
  outreach: [{
    channel: 'linkedin', status: 'draft_pending', created: 3.3, subject: '',
    body:
      'Hi Finn, earned-wage access looks simple until payroll and advances settle on different days. ' +
      'I help fintech finance teams reconcile that automatically. Would be good to connect.\n' +
      link('ostwindfinance.example'),
  }],
});
company({
  domain: 'linnetspend.example', name: 'Linnet Spend', hq: 'Oslo', employees: 13, founded: 2023,
  query: Q_SPEND, days: 4.1, status: 'drafted',
  contacts: [['Sigrid Haugen', 'CEO & co-founder', { email: 'sigrid@linnetspend.example', source: 'site-page' }]],
  outreach: [{
    channel: 'email', status: 'drafted', gmail: 'r-demo-1', created: 3.9,
    subject: 'Card spend on construction sites',
    body:
      'Hi Sigrid,\n\nLinnet puts cards in the hands of site foremen, which means hundreds of small ' +
      'transactions a week to match against receipts and the settlement account.\n\n' +
      'Ledgerlane matches settlements to bank lines automatically and flags breaks the same day.\n\n' +
      'Would a free audit of one month be useful?\n\n' + sign('linnetspend.example'),
  }],
});
company({
  domain: 'torvane.example', name: 'Torvane', hq: 'Copenhagen', employees: 21, founded: 2022,
  query: Q_SPEND, days: 4.3, status: 'drafted',
  contacts: [['Mads Kjeldsen', 'CEO & co-founder', { email: 'mads@torvane.example', source: 'canonical' }]],
  outreach: [{
    channel: 'email', status: 'drafted', gmail: 'r-demo-2', created: 4.0,
    subject: 'Torvane\'s agency card float',
    body:
      'Hi Mads,\n\nAgencies on Torvane pre-fund cards for client media spend, so your float moves every ' +
      'hour and the bank statement rarely lines up with the card ledger.\n\nLedgerlane reconciles the two ' +
      'continuously. Our customers close in 2 days instead of 9.\n\nOpen to a free audit of one month?\n\n' +
      sign('torvane.example'),
  }],
});

// --- Contact found / name only, no draft yet ---
company({
  domain: 'dunmorecredit.example', name: 'Dunmore Credit', hq: 'Glasgow', employees: 33, founded: 2020,
  query: Q_LEND, days: 5.0, status: 'emailed',
  contacts: [['Fiona Baird', 'CEO & co-founder', { email: 'fiona@dunmorecredit.example', source: 'site-page' }]],
});
company({
  domain: 'fjellpay.example', name: 'Fjellpay', hq: 'Bergen', employees: 12, founded: 2023,
  query: Q_SPEND, days: 5.2, status: 'emailed',
  contacts: [['Henrik Aasen', 'Founder', { email: 'henrik@fjellpay.example', source: 'github' }]],
});
company({
  domain: 'tessaro.example', name: 'Tessaro', hq: 'Turin', employees: 20, founded: 2021,
  query: Q_LEND, days: 5.4, status: 'emailed',
  contacts: [['Giulia Ferraresi', 'CEO & co-founder', { email: 'giulia@tessaro.example', source: 'websearch' }]],
});
company({
  domain: 'ivylinefinance.example', name: 'Ivyline Finance', hq: 'Antwerp', employees: 9, founded: 2023,
  query: Q_LEND, days: 5.6, status: 'named',
  contacts: [['Bram Janssens', 'Founder', { linkedin: li('Bram Janssens') }]],
});
company({
  domain: 'callowaypay.example', name: 'Calloway Pay', hq: 'Liverpool', employees: 6, founded: 2024,
  query: Q_UK, days: 5.8, status: 'named',
  contacts: [['Ruth Calloway', 'Founder', { linkedin: li('Ruth Calloway') }]],
});

// --- Sourced, not enriched yet ---
for (const [domain, name, hq, employees, founded, query, days] of [
  ['vantorpay.example', 'Vantor Pay', 'Prague', 17, 2022, Q_SPEND, 6.0],
  ['elmstead.example', 'Elmstead', 'Cambridge', 7, 2024, Q_UK, 6.1],
  ['quorracredit.example', 'Quorra Credit', 'Warsaw', 26, 2021, Q_LEND, 6.2],
  ['tarnbypay.example', 'Tarnby Pay', 'Malmö', 13, 2022, Q_SPEND, 6.3],
  ['bellmoor.example', 'Bellmoor', 'Oxford', 10, 2023, Q_UK, 6.4],
  ['grisell.example', 'Grisell', 'Tallinn', 14, 2023, Q_SPEND, 6.5],
  ['montclairpay.example', 'Montclair Pay', 'Lyon', 19, 2022, Q_LEND, 6.6],
  ['sorrelfinance.example', 'Sorrel Finance', 'Brighton', 8, 2024, Q_UK, 6.7],
  ['vireolending.example', 'Vireo Lending', 'Dublin', 30, 2020, Q_LEND, 6.8],
  ['noordpay.example', 'Noordpay', 'Utrecht', 22, 2021, Q_SPEND, 6.9],
  ['albispay.example', 'Albis Pay', 'Zurich', 11, 2023, Q_SPEND, 7.0],
  ['rookwoodtreasury.example', 'Rookwood Treasury', 'London', 15, 2022, Q_UK, 7.1],
]) {
  company({ domain, name, hq, employees, founded, query, days, status: 'sourced' });
}

// --- Skipped (out of profile) ---
company({
  domain: 'holliswealth.example', name: 'Hollis Wealth', hq: 'Geneva', employees: 85, founded: 2015,
  query: Q_SPEND, days: 7.5, status: 'skip',
});
company({
  domain: 'greyfieldinsure.example', name: 'Greyfield Insurance', hq: 'London', employees: 120, founded: 2016,
  query: Q_UK, days: 7.6, status: 'skip',
});

// --- Sent, replied, bounced (the oldest searches) ---
const sentEmail = (domain, first, subject, opener, sent, extra = {}) => ({
  channel: 'email', status: 'sent', created: sent + 0.05, sent, subject,
  body:
    `Hi ${first},\n\n${opener}\n\nLedgerlane matches every payout, fee and refund to the bank line ` +
    'it landed on, and flags breaks the day they happen. Our customers close the month in 2 days ' +
    'instead of 9.\n\nWould a free audit of one month of payouts be useful?\n\n' + sign(domain),
  ...extra,
});
company({
  domain: 'ashgrovepay.example', name: 'Ashgrove Pay', hq: 'Belfast', employees: 11, founded: 2023,
  query: Q_UK, days: 9.0, status: 'sent',
  contacts: [['Ciara Byrne', 'CEO & co-founder', { email: 'ciara@ashgrovepay.example', source: 'site-page' }]],
  outreach: [sentEmail('ashgrovepay.example', 'Ciara', 'Ashgrove\'s school-fee payouts',
    'Collecting school fees for hundreds of schools means a lot of small payouts to reconcile each term.', 0)],
});
company({
  domain: 'pellwood.example', name: 'Pellwood', hq: 'Cardiff', employees: 14, founded: 2022,
  query: Q_UK, days: 9.2, status: 'sent',
  contacts: [['Owen Pryce', 'Founder', { linkedin: li('Owen Pryce') }]],
  outreach: [{
    channel: 'linkedin', status: 'sent', created: 2.1, sent: 2, subject: '',
    body: 'Hi Owen, saw Pellwood now settles rent payments for 300 letting agents. I help fintech finance teams reconcile payouts automatically. Would be glad to connect.\n' + link('pellwood.example'),
  }],
});
company({
  domain: 'kestrelledger.example', name: 'Kestrel Ledger', hq: 'London', employees: 9, founded: 2024,
  query: Q_UK, days: 9.4, status: 'sent',
  contacts: [['Amelia Croft', 'CTO & co-founder', { linkedin: li('Amelia Croft') }]],
  outreach: [{
    channel: 'linkedin', status: 'sent', created: 0.1, sent: 0, subject: '',
    body: 'Hi Amelia, enjoyed your talk on ledger design for payment flows. We match payouts to bank lines for fintech finance teams. Would be good to connect.\n' + link('kestrelledger.example'),
  }],
});
company({
  domain: 'velloro.example', name: 'Velloro', hq: 'Barcelona', employees: 17, founded: 2023,
  query: Q_LEND, days: 10.0, status: 'sent',
  contacts: [['Marta Soler', 'CEO & co-founder', { email: 'marta@velloro.example', source: 'canonical' }]],
  outreach: [sentEmail('velloro.example', 'Marta', 'Velloro\'s merchant advances',
    'Advancing cash to Spanish restaurants and collecting from card takings is a reconciliation puzzle every single day.', 3)],
});
company({
  domain: 'oakhurstpay.example', name: 'Oakhurst Pay', hq: 'Bristol', employees: 31, founded: 2020,
  query: Q_UK, days: 10.3, status: 'sent',
  contacts: [['James Whitlock', 'CEO & co-founder', { email: 'james@oakhurstpay.example', source: 'site-page' }]],
  outreach: [sentEmail('oakhurstpay.example', 'James', 'Payouts across Oakhurst\'s two PSPs',
    'Running payouts through two PSPs for redundancy is smart, and it doubles the matching work at month end.', 1)],
});
company({
  domain: 'saffifinance.example', name: 'Saffi Finance', hq: 'Madrid', employees: 15, founded: 2022,
  query: Q_LEND, days: 10.6, status: 'sent',
  contacts: [['Lucía Navarro', 'Founder', { email: 'lucia@saffifinance.example', source: 'websearch' }]],
  outreach: [sentEmail('saffifinance.example', 'Lucía', 'Saffi\'s instalment collections',
    'Instalment plans for clinics mean partial payments, early settlements and refunds all landing as separate lines.', 2)],
});
company({
  domain: 'brackencredit.example', name: 'Bracken Credit', hq: 'Leeds', employees: 23, founded: 2021,
  query: Q_LEND, days: 15.0, status: 'sent',
  contacts: [['Tom Ashworth', 'CEO & co-founder', { email: 'tom@brackencredit.example', source: 'canonical' }]],
  outreach: [
    sentEmail('brackencredit.example', 'Tom', 'Bracken\'s loan book at month end',
      'Lending to trades businesses with weekly repayments makes for a busy bank statement.', 12),
    {
      channel: 'email', status: 'sent', created: 7.05, sent: 7, subject: 'Re: Bracken\'s loan book at month end',
      body: 'Hi Tom,\n\nOne more thought: the audit is free and takes us a day. If month-end is calm at Bracken, ignore this.\n\n' + sign('brackencredit.example'),
    },
  ],
});
company({
  domain: 'quillon.example', name: 'Quillon', hq: 'Edinburgh', employees: 12, founded: 2023,
  query: Q_UK, days: 15.2, status: 'sent',
  contacts: [['Isla Grant', 'Founder', { email: 'isla@quillon.example', source: 'site-page' }]],
  outreach: [sentEmail('quillon.example', 'Isla', 'Quillon\'s charity payouts',
    'Paying out donations to 2,000 charities means a lot of small transfers to match every week.', 5)],
});
company({
  domain: 'ferropayments.example', name: 'Ferro Payments', hq: 'Milan', employees: 27, founded: 2021,
  query: Q_LEND, days: 15.5, status: 'sent',
  contacts: [['Davide Conti', 'CEO & co-founder', { email: 'davide@ferropayments.example', source: 'site-page' }]],
  outreach: [sentEmail('ferropayments.example', 'Davide', 'Ferro\'s marketplace settlements',
    'Settling to thousands of Italian sellers across two acquirers means a lot of fees to explain at month end.', 6)],
});
company({
  domain: 'marlowecredit.example', name: 'Marlowe Credit', hq: 'Birmingham', employees: 28, founded: 2019,
  query: Q_LEND, days: 16.0, status: 'bounced',
  contacts: [['Priya Raman', 'CEO & co-founder', { email: 'priya@marlowecredit.example', source: 'websearch', confidence: 'inferred' }]],
  outreach: [{ ...sentEmail('marlowecredit.example', 'Priya', 'Marlowe\'s repayment matching',
    'Invoice finance for manufacturers means repayments that rarely match the invoice amount exactly.', 8), status: 'bounced' }],
});
company({
  domain: 'mintrail.example', name: 'Mintrail', hq: 'Dublin', employees: 19, founded: 2022,
  query: Q_UK, days: 18.0, status: 'replied',
  contacts: [['Sean Gallagher', 'CEO & co-founder', { email: 'sean@mintrail.example', source: 'canonical' }]],
  outreach: [{ ...sentEmail('mintrail.example', 'Sean', 'Mintrail\'s payroll float',
    'Funding payroll for Irish SMEs a day early means your float and the bank never quite agree.', 11),
    status: 'replied', reply: 'Hi Maya, this is very real for us. Can you do Tuesday at 10?' }],
});
company({
  domain: 'tidewelllending.example', name: 'Tidewell Lending', hq: 'Manchester', employees: 41, founded: 2020,
  query: Q_LEND, days: 18.5, status: 'replied',
  contacts: [['Hannah Okoro', 'COO & co-founder', { email: 'hannah@tidewelllending.example', source: 'site-page' }]],
  outreach: [{ ...sentEmail('tidewelllending.example', 'Hannah', 'Tidewell\'s month-end',
    'Your COO post about a 7-day month-end close stuck with me.', 9),
    status: 'replied', reply: 'Happy to try the audit. Who should I send the October exports to?' }],
});
company({
  domain: 'harrowgatepay.example', name: 'Harrowgate Pay', hq: 'London', employees: 34, founded: 2021,
  query: Q_UK, days: 19.0, status: 'replied',
  contacts: [
    ['Imogen Hartley', 'CEO & co-founder', { email: 'imogen@harrowgatepay.example', source: 'site-page' }],
    ['Daniel Osei', 'CTO & co-founder', { linkedin: li('Daniel Osei') }],
  ],
  outreach: [{ ...sentEmail('harrowgatepay.example', 'Imogen', 'Harrowgate\'s marketplace payouts',
    'Paying out to 4,000 UK marketplace sellers every day is a lot of lines to match.', 13),
    status: 'replied', reply: 'Timing is good, we are rebuilding month-end now. Does Thursday work?' }],
});

// ---------------------------------------------------------------------------------------------
// What the scripted run adds, in the order it works (bin/opencode applies the three batches).

export const ANGLES = [
  'seed-stage fintech, Europe',
  'embedded finance APIs, EU',
  'B2B payments, DACH + Nordics',
];
const [A1, A2, A3] = ANGLES;

/**
 * The run's 24 companies. `founder`: [name, role, email?] (email null = LinkedIn only); `draft`:
 * { subject, body } for email, or { note } for LinkedIn. No founder = left as Sourced.
 */
const RUN_LIST = [
  { domain: 'eiderpay.example', name: 'Eiderpay', hq: 'Kiel', employees: 8, founded: 2024, query: A3 },
  { domain: 'tesselpay.example', name: 'Tessel Pay', hq: 'Aarhus', employees: 9, founded: 2024, query: A3 },
  {
    domain: 'birchway.example', name: 'Birchway', hq: 'Helsinki', employees: 10, founded: 2024, query: A3,
    founder: ['Aino Virtanen', 'Founder', null],
    draft: { note: 'Hi Aino, Birchway\'s supplier-payment flows for Finnish SMEs caught my eye. I help fintech finance teams reconcile payouts automatically. Would be glad to connect.' },
  },
  { domain: 'vellumpay.example', name: 'Vellum Pay', hq: 'Hamburg', employees: 16, founded: 2023, query: A3 },
  {
    domain: 'halvard.example', name: 'Halvard', hq: 'Gothenburg', employees: 14, founded: 2023, query: A3,
    founder: ['Oskar Lindgren', 'CEO & co-founder', null],
    draft: { note: 'Hi Oskar, congrats on Halvard\'s launch in Norway. Cross-border B2B payouts are exactly what we reconcile for fintech finance teams. Would be good to connect.' },
  },
  {
    domain: 'alpwise.example', name: 'Alpwise', hq: 'Zurich', employees: 21, founded: 2022, query: A3,
    founder: ['Nico Brunner', 'CEO & co-founder', 'nico@alpwise.example'],
    draft: {
      subject: 'Alpwise\'s supplier runs in CHF and EUR',
      body:
        'Hi Nico,\n\nAlpwise pays Swiss SMEs\' suppliers in CHF and EUR from one balance, so every payment ' +
        'run leaves an FX leg and a fee line to explain at month end.\n\nLedgerlane matches each one to ' +
        'the bank line it landed on and flags anything that does not net out the same day. Fintech ' +
        'teams on it close in 2 days instead of 9.\n\nWould a free audit of one month of payment runs ' +
        'be useful? You get every unmatched line back.\n\n' + sign('alpwise.example'),
    },
  },
  {
    domain: 'skerrypay.example', name: 'Skerry Pay', hq: 'Oslo', employees: 17, founded: 2022, query: A3,
    founder: ['Ingrid Solberg', 'CEO & co-founder', 'ingrid@skerrypay.example'],
    draft: {
      subject: 'Skerry\'s invoice payments at month end',
      body:
        'Hi Ingrid,\n\nSkerry lets Norwegian wholesalers get paid by invoice link, so a single invoice ' +
        'can settle in two or three partial payments, days apart.\n\nLedgerlane matches those back to ' +
        'the right invoice and bank line automatically, so month-end stops being a week of CSVs.\n\n' +
        'Happy to run one month of Skerry\'s payouts through it for free. Worth a look?\n\n' +
        sign('skerrypay.example'),
    },
  },
  { domain: 'coastlinepay.example', name: 'Coastline Pay', hq: 'Lisbon', employees: 11, founded: 2023, query: A2 },
  { domain: 'wrenfield.example', name: 'Wrenfield', hq: 'Leeds', employees: 7, founded: 2024, query: A2 },
  {
    domain: 'ferrow.example', name: 'Ferrow', hq: 'Brussels', employees: 12, founded: 2023, query: A2,
    founder: ['Pieter Claes', 'Founder', 'pieter@ferrow.example'],
    draft: {
      subject: 'VAT-ready payouts at Ferrow',
      body:
        'Hi Pieter,\n\nFerrow pays Belgian freelancers and holds back VAT for them, which means every ' +
        'payout is really two or three movements to reconcile.\n\nLedgerlane matches each of them to ' +
        'the bank line and flags a break the day it happens, not at quarter end.\n\nOpen to a free ' +
        'audit of one month? It takes us a day.\n\n' + sign('ferrow.example'),
    },
  },
  { domain: 'nimbalo.example', name: 'Nimbalo', hq: 'Milan', employees: 9, founded: 2024, query: A2 },
  {
    domain: 'stellwerk.example', name: 'Stellwerk', hq: 'Vienna', employees: 13, founded: 2024, query: A2,
    founder: ['Matthias Gruber', 'CTO & co-founder', null],
    draft: { note: 'Hi Matthias, Stellwerk\'s card-issuing API looks clean. We reconcile card settlements to bank lines for fintech finance teams. Would be good to connect.' },
  },
  {
    domain: 'amberleypay.example', name: 'Amberley Pay', hq: 'Paris', employees: 15, founded: 2023, query: A2,
    founder: ['Camille Rousseau', 'CEO & co-founder', 'camille@amberleypay.example'],
    draft: {
      subject: 'Creator payouts at Amberley',
      body:
        'Hi Camille,\n\nAmberley pays out to creators in 30 countries every Friday, and I would guess ' +
        'the returned and resent payouts are what eat Monday.\n\nLedgerlane matches every payout, fee ' +
        'and return to its bank line automatically, so you only look at the ones that broke.\n\n' +
        'Would a free audit of one month be useful?\n\n' + sign('amberleypay.example'),
    },
  },
  {
    domain: 'kontora.example', name: 'Kontora', hq: 'Munich', employees: 19, founded: 2023, query: A2,
    founder: ['Lea Hoffmann', 'CEO & co-founder', 'lea@kontora.example'],
    draft: {
      subject: 'Kontora\'s sub-accounts at month end',
      body:
        'Hi Lea,\n\nKontora gives vertical SaaS tools business accounts for their customers, so your ' +
        'own finance team must be watching thousands of sub-accounts settle into a few pooled ones.\n\n' +
        'Ledgerlane matches each movement to the pooled bank line automatically and flags anything ' +
        'that does not net out the same day.\n\nWorth a free audit of one month?\n\n' + sign('kontora.example'),
    },
  },
  {
    domain: 'railyardfinance.example', name: 'Railyard Finance', hq: 'Berlin', employees: 24, founded: 2022, query: A2,
    founder: ['Jonas Albrecht', 'CEO & co-founder', 'jonas@railyardfinance.example'],
    draft: {
      subject: 'Reconciling Railyard\'s marketplace loans',
      body:
        'Hi Jonas,\n\nRailyard now runs lending inside a dozen B2B marketplaces, so I imagine ' +
        'disbursements and repayments settle through each marketplace\'s PSP as well as your own ' +
        'bank accounts.\n\nThat is where month-end gets painful: someone matching five CSV exports line ' +
        'by line. Ledgerlane matches every payout, fee and repayment to its bank line automatically, ' +
        'and flags a break the day it happens. Teams like yours went from a 9-day close to 2.\n\n' +
        'Happy to run one month of Railyard\'s payouts through it for free and show you every ' +
        'unmatched line. Worth a look?\n\n' + sign('railyardfinance.example'),
    },
  },
  {
    domain: 'kovalo.example', name: 'Kovalo', hq: 'Tallinn', employees: 10, founded: 2023, query: A1,
    founder: ['Kadri Tamm', 'Founder', 'kadri@kovalo.example'],
    draft: {
      subject: 'Kovalo\'s payroll runs across the Baltics',
      body:
        'Hi Kadri,\n\nRunning payroll for Baltic startups across three countries means three tax ' +
        'authorities, three banks and a lot of transfers to match every month.\n\nLedgerlane matches ' +
        'them to the bank lines automatically, so the close is a check, not a project.\n\nWould a free ' +
        'audit of one month of payroll runs be useful?\n\n' + sign('kovalo.example'),
    },
  },
  { domain: 'tanneryfinance.example', name: 'Tannery Finance', hq: 'Bristol', employees: 8, founded: 2024, query: A1 },
  { domain: 'pallaspay.example', name: 'Pallas Pay', hq: 'Athens', employees: 12, founded: 2023, query: A1 },
  { domain: 'quaystone.example', name: 'Quaystone', hq: 'Rotterdam', employees: 16, founded: 2023, query: A1 },
  {
    domain: 'orrinledger.example', name: 'Orrin Ledger', hq: 'London', employees: 11, founded: 2024, query: A1,
    founder: ['Tobias Reed', 'CEO & co-founder', null],
    draft: { note: 'Hi Tobias, Orrin\'s ledger API is close to what we build on top of. We reconcile payouts to bank lines for fintech finance teams. Would be glad to connect.' },
  },
  {
    domain: 'northmint.example', name: 'Northmint', hq: 'Stockholm', employees: 22, founded: 2022, query: A1,
    founder: ['Elin Bergström', 'CEO & co-founder', 'elin@northmint.example'],
    draft: {
      subject: 'Northmint\'s card settlements',
      body:
        'Hi Elin,\n\nNorthmint issues cards for Nordic expense tools, so every settlement file has to ' +
        'be matched against the program\'s funding account, often across two schemes.\n\nLedgerlane ' +
        'does that matching automatically and flags breaks the same day. Our customers close in 2 days ' +
        'instead of 9.\n\nOpen to a free audit of one month?\n\n' + sign('northmint.example'),
    },
  },
  {
    domain: 'lumiofinance.example', name: 'Lumio Finance', hq: 'Lisbon', employees: 18, founded: 2023, query: A1,
    founder: ['Inês Carvalho', 'CEO & co-founder', 'ines@lumiofinance.example'],
    draft: {
      subject: 'Invoice advances at Lumio',
      body:
        'Hi Inês,\n\nLumio advances cash against invoices for Portuguese and Spanish SMEs, so each ' +
        'invoice ends in a repayment that rarely matches the advance to the cent.\n\nLedgerlane ties ' +
        'every repayment, fee and shortfall back to its advance and bank line automatically.\n\n' +
        'Would a free audit of one month be useful?\n\n' + sign('lumiofinance.example'),
    },
  },
  {
    domain: 'fennickpay.example', name: 'Fennick Pay', hq: 'Dublin', employees: 9, founded: 2024, query: A1,
    founder: ['Ciarán Dolan', 'Founder', 'ciaran@fennickpay.example'],
    draft: {
      subject: 'Instant payouts and the month-end tail',
      body:
        'Hi Ciarán,\n\nInstant payouts to gig workers are great until month end, when thousands of ' +
        'small transfers, returns and fees all need a home.\n\nLedgerlane matches each one to the bank ' +
        'line it landed on and flags breaks the day they happen.\n\nHappy to run a free audit on one ' +
        'month of Fennick\'s payouts. Worth a look?\n\n' + sign('fennickpay.example'),
    },
  },
  {
    domain: 'brightvault.example', name: 'Brightvault', hq: 'Amsterdam', employees: 14, founded: 2023, query: A1,
    founder: ['Sanne de Wit', 'CEO & co-founder', 'sanne@brightvault.example'],
    draft: {
      subject: 'Brightvault\'s safeguarded balances',
      body:
        'Hi Sanne,\n\nHolding marketplace funds in four currencies means a daily safeguarding ' +
        'reconciliation that someone on your team probably still does by hand.\n\nLedgerlane matches ' +
        'every movement to its bank line automatically, and keeps the safeguarding report ready.\n\n' +
        'Would a free audit of one month be useful?\n\n' + sign('brightvault.example'),
    },
  },
];

// Pipeline order after the run (newest first): angles interleave, as the parallel searches'
// union comes back, with a few strong fits on the first screen.
const RUN_ORDER = [
  'kontora', 'railyardfinance', 'stellwerk', 'eiderpay', 'alpwise', 'amberleypay', 'halvard',
  'tesselpay', 'skerrypay', 'northmint', 'ferrow', 'nimbalo', 'birchway', 'lumiofinance',
  'quaystone', 'kovalo', 'vellumpay', 'fennickpay', 'coastlinepay', 'orrinledger', 'pallaspay',
  'brightvault', 'wrenfield', 'tanneryfinance',
];
export const RUN = RUN_ORDER.map((slug) => {
  const c = RUN_LIST.find((x) => x.domain === `${slug}.example`);
  if (!c) throw new Error(`demo seed: no run company ${slug}`);
  return c;
});
if (RUN.length !== RUN_LIST.length) throw new Error('demo seed: RUN_ORDER misses a company');

/** What the run summary and the demo agent quote, computed from RUN. */
export const RUN_STATS = (() => {
  const withFounder = RUN.filter((c) => c.founder);
  const emails = withFounder.filter((c) => c.founder[2]).length;
  return {
    sourced: RUN.length,
    founders: withFounder.length,
    drafts: withFounder.length,
    emails,
    notes: withFounder.length - emails,
  };
})();

// ---------------------------------------------------------------------------------------------
// Schedules, runs and earlier conversations.

const SCHEDULES = [
  {
    id: 'd3e0b9a4-1c55-4c1e-8f0a-5d1e9b2a7c01', name: 'Morning sourcing', enabled: 1, freq: 'daily',
    time: '08:30', weekday: null, task_mode: 'agent', prompt: null, age: 14,
  },
  {
    id: 'd3e0b9a4-1c55-4c1e-8f0a-5d1e9b2a7c02', name: 'Friday follow-ups', enabled: 1, freq: 'weekly',
    time: '10:00', weekday: 5, task_mode: 'custom',
    prompt: 'Draft a short follow-up for everyone who hasn\'t replied in 5 days. Never resend the same pitch.',
    age: 12,
  },
];

const CHATS = [
  {
    id: 'e7c4a2f1-0000-4000-8000-00000000d001', title: 'Scheduled run — Morning sourcing', hoursAgo: 30,
    messages: [
      ['user', 'Run the coldtrail loop: source, enrich, draft, then hand off.'],
      ['tool', '$ coldtrail source "spend management startups, EU"'],
      ['tool', '$ coldtrail find-emails 20'],
      ['tool', '$ coldtrail draft haldenpay.example --subject "Failed'],
      ['assistant', 'Sourced **14** spend-management companies, found founders for **8** and wrote **6** drafts.\n\n- 4 emails and 2 LinkedIn notes are waiting in Drafts\n- 2 were out of profile (wealth and insurance), so I skipped them'],
    ],
  },
  {
    id: 'e7c4a2f1-0000-4000-8000-00000000d002', title: 'Who replied this week?', hoursAgo: 52,
    messages: [
      ['user', 'Who replied this week, and what do they want?'],
      ['assistant', '**3** replies this week:\n\n1. **Harrowgate Pay**: Imogen wants a call on Thursday\n2. **Tidewell Lending**: Hannah asked where to send the October exports\n3. **Mintrail**: Sean proposed Tuesday at 10'],
    ],
  },
  {
    id: 'e7c4a2f1-0000-4000-8000-00000000d003', title: 'Scheduled run — Morning sourcing', hoursAgo: 78,
    messages: [
      ['user', 'Run the coldtrail loop: source, enrich, draft, then hand off.'],
      ['tool', '$ coldtrail source "SME lending platforms, Europe"'],
      ['tool', '$ coldtrail find-emails 20'],
      ['assistant', 'Sourced **12** lending platforms and found founders for **7**. 4 drafts are in Drafts.'],
    ],
  },
  {
    id: 'e7c4a2f1-0000-4000-8000-00000000d004', title: 'LinkedIn notes for the UK payments list', hoursAgo: 150,
    messages: [
      ['user', 'Write LinkedIn notes for the UK payments companies that only have a LinkedIn profile.'],
      ['assistant', 'Done: 3 LinkedIn notes are in Drafts, each under 240 characters.'],
    ],
  },
];

// Oldest first. [hours ago, schedule index or null, trigger, status, [sourced, enriched, drafted, sent], chat]
const RUNS = [
  [6 * 24 + 15.5, 0, 'scheduled', 'ok', [16, 9, 7, 0], null],
  [5 * 24 + 15.5, 0, 'scheduled', 'ok', [11, 6, 5, 0], null],
  [4 * 24 + 13, 1, 'scheduled', 'ok', [0, 0, 3, 0], null],
  [78, 0, 'scheduled', 'ok', [12, 7, 4, 0], CHATS[2].id],
  [30, 0, 'scheduled', 'ok', [14, 8, 6, 0], CHATS[0].id],
];

// ---------------------------------------------------------------------------------------------
// Writing it

const ago = (days) => `-${Math.round(days * 24 * 60)} minutes`;
const hoursAgo = (h) => `-${Math.round(h * 60)} minutes`;

/** Create the workspace schema with the real binary (any DB-touching subcommand does it). */
function initSchema(bin, env, home) {
  const init = spawnSync(bin, ['send-pending', 'email'], { env, cwd: home, encoding: 'utf8', timeout: 30_000 });
  if (init.status !== 0) {
    throw new Error(`schema init failed (${init.error?.message ?? init.status}):\n${init.stdout}\n${init.stderr}`);
  }
}

/**
 * Seed the demo workspace into `home` (an empty temp COLDTRAIL_HOME) and its secrets dir.
 * `env` is the server's environment (COLDTRAIL_HOME etc.); `bin` the coldtrail binary.
 */
export function seedDemo({ home, secretsDir, userHome, bin, env }) {
  writeFileSync(join(home, 'config.toml'), CONFIG_TOML);
  // The opencode CLI counts as signed in when its auth file exists in the (sandbox) HOME.
  mkdirSync(join(userHome, '.local/share/opencode'), { recursive: true });
  writeFileSync(join(userHome, '.local/share/opencode/auth.json'), '{}\n');
  initSchema(bin, env, home);
  writeFileSync(join(home, 'product.md'), PRODUCT_MD);
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, 'secrets.toml'), SECRETS_TOML, { mode: 0o600 });

  const db = new DatabaseSync(join(home, 'outreach.db'));
  const insert = (table, columns, timeColumns = []) =>
    db.prepare(
      `INSERT INTO ${table} (${[...columns, ...timeColumns].join(', ')}) VALUES (` +
        [...columns.map(() => '?'), ...timeColumns.map(() => "datetime('now', ?)")].join(', ') +
        ')',
    );
  try {
    db.exec('BEGIN');
    const company = insert('companies', ['domain', 'name', 'hq', 'employees', 'founding_year', 'source_query', 'status'], ['first_seen']);
    const contact = insert(
      'contacts',
      ['domain', 'founder_name', 'role', 'linkedin_url', 'email', 'email_source', 'email_confidence', 'mx_ok'],
      ['found_at'],
    );
    const outreach = insert(
      'outreach',
      ['domain', 'contact_id', 'channel', 'subject', 'body', 'utm_url', 'gmail_draft_id', 'status', 'reply'],
      ['created_at', 'sent_at'],
    );
    for (const c of EXISTING) {
      company.run(c.domain, c.name, c.hq, c.employees, c.founded, c.query, c.status, ago(c.days));
      const ids = c.contacts.map(([name, role, k]) =>
        contact.run(
          c.domain, name, role, k.linkedin ?? null, k.email ?? null,
          k.email ? k.source ?? 'site-page' : null,
          k.email ? k.confidence ?? 'direct' : null,
          k.email ? k.mx ?? 1 : null,
          ago(c.days - 0.02),
        ).lastInsertRowid,
      );
      for (const o of c.outreach) {
        const who = ids[o.channel === 'linkedin' ? c.contacts.findIndex(([, , k]) => k.linkedin) : c.contacts.findIndex(([, , k]) => k.email)];
        outreach.run(
          c.domain, who ?? null, o.channel, o.subject, o.body, link(c.domain), o.gmail ?? null, o.status,
          o.reply ?? null, ago(o.created), o.sent == null ? null : o.sent === 0 ? '-30 minutes' : ago(o.sent),
        );
      }
    }

    const schedule = insert('schedules', ['id', 'name', 'enabled', 'freq', 'time', 'weekday', 'task_mode', 'prompt'], ['created_at', 'updated_at']);
    for (const s of SCHEDULES) {
      schedule.run(s.id, s.name, s.enabled, s.freq, s.time, s.weekday, s.task_mode, s.prompt, ago(s.age), ago(s.age));
    }

    const chat = insert('chat_sessions', ['id', 'agent_session_id', 'title', 'running'], ['created_at', 'updated_at']);
    const message = insert('chat_messages', ['session_id', 'role', 'content'], ['created_at']);
    CHATS.forEach((ch, i) => {
      const startMin = ch.hoursAgo * 60 + ch.messages.length * 2;
      chat.run(ch.id, `ses_demo_${i + 1}`, ch.title, 0, `-${startMin} minutes`, hoursAgo(ch.hoursAgo));
      ch.messages.forEach(([role, content], j) => message.run(ch.id, role, content, `-${startMin - (j + 1) * 2} minutes`));
    });

    const run = insert(
      'scheduled_runs',
      ['status', 'sourced', 'enriched', 'drafted', 'sent', 'chat_id', 'note', 'schedule_id', 'trigger'],
      ['started_at', 'finished_at'],
    );
    for (const [h, sched, trigger, status, counts, chatId] of RUNS) {
      run.run(status, ...counts, chatId, null, sched == null ? null : SCHEDULES[sched].id, trigger, hoursAgo(h), hoursAgo(h - 0.12));
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }

  writeRunBatches(home);
}

// ---------------------------------------------------------------------------------------------
// The run's batches, as SQL the demo agent applies with sqlite3 between its steps.

const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** Where the demo agent finds its batches (inside the temp workspace). */
export const RUN_DIR = '.demo-run';

function writeRunBatches(home) {
  const dir = join(home, RUN_DIR);
  mkdirSync(dir, { recursive: true });
  // Pipeline and Drafts list newest first: RUN[0] is the newest, the last one the oldest.
  const source = RUN.map(
    (c, i) =>
      'INSERT OR IGNORE INTO companies (domain, name, hq, employees, founding_year, source_query, status, first_seen) ' +
      `VALUES (${[c.domain, c.name, c.hq, c.employees, c.founded, c.query, 'sourced'].map(q).join(', ')}, datetime('now', '-${i * 3 + 20} seconds'));`,
  );
  const enrich = [];
  const draft = [];
  RUN.forEach((c, i) => {
    if (!c.founder) return;
    const [name, role, mail] = c.founder;
    const lin = mail ? null : li(name);
    enrich.push(
      'INSERT INTO contacts (domain, founder_name, role, linkedin_url, email, email_source, email_confidence, mx_ok, found_at) ' +
        `VALUES (${[c.domain, name, role, lin, mail, mail ? (i % 3 ? 'site-page' : 'canonical') : null, mail ? 'direct' : null, mail ? 1 : null].map(q).join(', ')}, datetime('now'));`,
      `UPDATE companies SET status = ${q(mail ? 'emailed' : 'named')} WHERE domain = ${q(c.domain)};`,
    );
    const contactId = `(SELECT id FROM contacts WHERE domain = ${q(c.domain)} ORDER BY id DESC LIMIT 1)`;
    const body = c.draft.note ? `${c.draft.note}\n${link(c.domain)}` : c.draft.body;
    draft.push(
      'INSERT INTO outreach (domain, contact_id, channel, subject, body, utm_url, status, created_at) ' +
        `VALUES (${q(c.domain)}, ${contactId}, ${q(mail ? 'email' : 'linkedin')}, ${q(c.draft.subject ?? '')}, ${q(body)}, ` +
        `${q(link(c.domain))}, 'draft_pending', datetime('now', '-${i + 1} seconds'));`,
    );
  });
  const wrap = (lines) => `BEGIN;\n${lines.join('\n')}\nCOMMIT;\n`;
  writeFileSync(join(dir, '1-source.sql'), wrap(source));
  writeFileSync(join(dir, '2-enrich.sql'), wrap(enrich));
  writeFileSync(join(dir, '3-draft.sql'), wrap(draft));
  // The domains the agent drafts for, in order (the demo agent prints one step per draft).
  writeFileSync(
    join(dir, 'drafts.tsv'),
    RUN.filter((c) => c.founder)
      .reverse()
      .map((c) => `${c.founder[2] ? 'email' : 'linkedin'}\t${c.domain}\t${c.draft.subject ?? '-'}\t${c.founder[0]}`)
      .join('\n') + '\n',
  );
  writeFileSync(join(dir, 'stats.env'), Object.entries(RUN_STATS).map(([k, v]) => `RUN_${k.toUpperCase()}=${v}`).join('\n') + '\n');
}
