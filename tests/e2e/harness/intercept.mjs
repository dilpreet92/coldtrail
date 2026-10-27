// Page-level intercepts for the routes that would leave the machine or open a real window:
// OAuth/connect flows, the Gmail app-password IMAP check, LinkedIn (which launches Chrome) and
// the OSINT installers. Each gets a canned 200 in the route's documented success shape and is
// recorded in `calls`, so specs assert what the UI sent instead of letting it run.
//
// Routes registered later take precedence in Playwright, so a spec can still override any of
// these for one test (e.g. to return an error shape) with its own `page.route`.

/** Every intercepted route: method, path pattern, an example path, and the canned response. */
export const SIDE_EFFECT_ROUTES = [
  {
    method: 'POST',
    pattern: /^\/api\/discovery\/canonical\/connect$/,
    sample: '/api/discovery/canonical/connect',
    response: { ok: true, message: null },
  },
  {
    method: 'POST',
    pattern: /^\/api\/destination\/gmail\/connect$/,
    sample: '/api/destination/gmail/connect',
    response: { ok: true, message: null },
  },
  {
    method: 'POST',
    pattern: /^\/api\/destination\/gmail\/app-password$/,
    sample: '/api/destination/gmail/app-password',
    response: { ok: true, message: null },
  },
  {
    method: 'POST',
    pattern: /^\/api\/destination\/linkedin\/connect$/,
    sample: '/api/destination/linkedin/connect',
    response: { status: 'waiting' },
  },
  {
    method: 'POST',
    pattern: /^\/api\/drafts\/[^/]+\/linkedin\/assist$/,
    sample: '/api/drafts/acme-robotics.example/linkedin/assist',
    response: { staged: true },
  },
  {
    method: 'POST',
    pattern: /^\/api\/drafts\/[^/]+\/linkedin\/send$/,
    sample: '/api/drafts/acme-robotics.example/linkedin/send',
    response: { sending: true },
  },
  {
    method: 'POST',
    pattern: /^\/api\/drafts\/linkedin\/send-all$/,
    sample: '/api/drafts/linkedin/send-all',
    response: { sending: true },
  },
  {
    method: 'POST',
    pattern: /^\/api\/onboarding\/osint\/install$/,
    sample: '/api/onboarding/osint/install',
    response: { ok: true, message: 'installed' },
  },
];

const ruleFor = (method, pathname) =>
  SIDE_EFFECT_ROUTES.find((r) => r.method === method && r.pattern.test(pathname));

function bodyOf(request) {
  const raw = request.postData();
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Answer the side-effect routes on `page` with canned responses.
 * @returns {Promise<{ calls: { method: string, path: string, body: unknown }[] }>} every
 *   intercepted request, in order (`body` is parsed JSON, the raw text, or null).
 */
export async function interceptSideEffects(page) {
  const calls = [];
  await page.route(
    (url) => SIDE_EFFECT_ROUTES.some((r) => r.pattern.test(url.pathname)),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const rule = ruleFor(request.method(), pathname);
      if (!rule) return route.fallback();
      calls.push({ method: request.method(), path: pathname, body: bodyOf(request) });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rule.response),
      });
    },
  );
  return { calls };
}
