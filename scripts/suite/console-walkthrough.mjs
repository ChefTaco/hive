#!/usr/bin/env node
// Walks every console screen in a real browser and fails unless each one settles.
// A view passes only after requests have started and finished, loading indicators
// are gone and no unexpected failure was observed. Read-only: it never submits a
// mutation, so it is safe against restored data.
//
//   node scripts/suite/console-walkthrough.mjs --credentials FILE --output DIR
//     [--origin URL] [--matrix desktop-dark,desktop-light,mobile-dark,mobile-light]
//     [--pages hive,chat] [--fault /api/hivemem] [--ui-dist HiveXUI/dist]
//
// --ui-dist serves the console's static files from a local build while API requests
// still reach the real stack, so a UI change can be tested without activating an image.
// --fault answers matching API paths with HTTP 500. It is a negative control: a run
// using it must report findings, proving the harness can actually fail.
//
// FILE is JSON holding {origin, username, password}. TLS verification is relaxed
// only for the browser under test, and only for the explicit origin's certificate.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    credentials: { type: 'string' },
    output: { type: 'string' },
    origin: { type: 'string' },
    matrix: { type: 'string', default: 'desktop-dark,mobile-dark' },
    pages: { type: 'string' },
    fault: { type: 'string' },
    'ui-dist': { type: 'string' },
    'playwright-from': { type: 'string' },
    'settle-timeout': { type: 'string', default: '45000' },
    'quiet-ms': { type: 'string', default: '900' },
    products: { type: 'string' },
    'deep-links': { type: 'string' },
  },
});
if (!args.credentials || !args.output) {
  console.error('--credentials and --output are required');
  process.exit(2);
}
const credentials = JSON.parse(readFileSync(args.credentials, 'utf8'));
const origin = args.origin ?? credentials.origin;
const output = resolve(args.output);
mkdirSync(output, { recursive: true, mode: 0o700 });
const require = createRequire(resolve(args['playwright-from'] ?? process.cwd()) + '/');
const { chromium } = require('@playwright/test');

const productSets = (args.products ?? 'all').split(';').map((entry) => {
  const [name, list] = entry.split('=');
  return { name, products: list === undefined ? null : list.split(',') };
});
let activeProducts = null;
const VIEWPORTS = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };
const SETTLE_TIMEOUT = Number(args['settle-timeout']);
const QUIET_MS = Number(args['quiet-ms']);
// Text that means a screen has not finished, including ProductAccess and Suspense.
const LOADING_TEXT = /^(loading|checking|syncing)\b/i;
const SUBNAV = {
  security: ['Cases', 'Events', 'Entities', 'Sources', 'Evidence', 'Policies', 'Audit'],
};
// Expected responses on these paths are part of the sign-in and consent protocol.
const expectedFailure = (response) => {
  if (response.body?.error === 'CONSENT_REQUIRED' || response.body?.error === 'STEP_UP_REQUIRED') return true;
  if (response.status === 401 && /\/(auth\/me|oauth\/authorize|browser\/session)$/.test(new URL(response.url).pathname) && response.beforeLogin) return true;
  return false;
};

// One context and one sign-in serve the whole matrix: the identity product limits
// sign-in attempts, and viewport and color scheme can change within a session.
async function createSession(browser) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, reducedMotion: 'reduce', ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const state = { inflight: new Map(), lastActivity: Date.now(), loggedIn: false };
  const events = { responses: [], pageErrors: [], consoleErrors: [], networkFailures: [], offOrigin: new Set() };
  const stepUps = [];
  if (args['ui-dist']) {
    const root = resolve(args['ui-dist']);
    await context.route(`${origin}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname === '/runtime.json') return route.fallback();
      const file = join(root, pathname === '/' ? 'index.html' : pathname);
      return route.fulfill({ path: file.startsWith(root) && existsSync(file) && !statSync(file).isDirectory() ? file : join(root, 'index.html') });
    });
  }
  await context.route(`${origin}/runtime.json`, async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    if (activeProducts) {
      config.products = Object.fromEntries(Object.entries(config.products).filter(([name]) => activeProducts.includes(name)));
      config.identity.clients = Object.fromEntries(Object.entries(config.identity.clients).filter(([name]) => activeProducts.includes(name)));
    }
    return route.fulfill({ response, json: config, headers: { ...response.headers(), 'cache-control': 'no-store' } });
  });
  if (args.fault)
    await context.route(`**${args.fault}/**`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"INJECTED_FAULT"}' }));
  page.on('pageerror', (error) => events.pageErrors.push(String(error)));
  page.on('console', (message) => {
    // Browsers log every failed fetch; those are classified by the response handler.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text()))
      events.consoleErrors.push(message.text().slice(0, 400));
  });
  const apiCalls = new Set();
  page.on('request', (request) => {
    // A document being replaced can never report completion of its in-flight requests.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) { state.inflight.clear(); }
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) apiCalls.add(pathname.split('/').slice(0, 3).join('/'));
    state.inflight.set(request, { url: request.url(), at: Date.now() });
    state.lastActivity = Date.now();
  });
  const finished = (request) => {
    state.inflight.delete(request);
    state.lastActivity = Date.now();
  };
  page.on('requestfailed', (request) => {
    finished(request);
    const text = request.failure()?.errorText ?? 'failed';
    if (text !== 'net::ERR_ABORTED') events.networkFailures.push({ url: request.url(), error: text });
  });
  page.on('requestfinished', finished);
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.startsWith('data:') && !url.startsWith(origin)) events.offOrigin.add(new URL(url).origin);
    if (response.status() < 400) return;
    const entry = { url, method: response.request().method(), status: response.status(), beforeLogin: !state.loggedIn };
    try {
      entry.body = await response.json();
    } catch {
      entry.body = null;
    }
    events.responses.push(entry);
  });
  // A connection left open on purpose (chat realtime) must not hold the quiet period.
  // A request the old document made just before a reload can die with it and never report an end.
  // Once the new document commits, nothing issued before that moment can still be answered.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const committed = Date.now();
    for (const [request, entry] of state.inflight) if (entry.at < committed) state.inflight.delete(request);
  });
  const pendingRequests = () => [...state.inflight.keys()].filter((request) => request.resourceType() !== 'websocket' && request.resourceType() !== 'eventsource' && !/\/stream(\/|$|\?)/.test(new URL(request.url()).pathname));

  async function answerPrompts() {
    const consent = page.getByRole('dialog', { name: 'Review access', exact: true });
    if (await consent.isVisible().catch(() => false)) {
      await consent.getByRole('button', { name: /approve|allow|continue/i }).first().click();
      return true;
    }
    const verify = page.getByRole('dialog', { name: 'Verify your identity', exact: true });
    if (await verify.isVisible().catch(() => false)) {
      stepUps.push(page.url());
      await verify.getByRole('textbox', { name: /password/i }).fill(credentials.password);
      await verify.getByRole('button', { name: /verify|continue|confirm/i }).first().click();
      return true;
    }
    return false;
  }
  // Loading text, spinners and skeletons in the content; the topbar sync pip is excluded.
  const loadingIndicators = () =>
    page.evaluate((pattern) => {
      const expression = new RegExp(pattern, 'i');
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      };
      const found = [];
      for (const element of document.querySelectorAll('[role="status"]'))
        if (visible(element) && (element.getAttribute('aria-label') === 'Loading' || expression.test((element.textContent ?? '').trim())))
          found.push((element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60));
      for (const element of document.querySelectorAll('.center-load, .page-content .spinner, .page-body .spinner, .skeleton'))
        if (visible(element)) found.push(element.className.toString().slice(0, 60));
      return found;
    }, LOADING_TEXT.source);

  async function settle() {
    const started = Date.now();
    // Give effects a chance to issue their first requests before judging quiet.
    await page.waitForTimeout(350);
    let quietSince = 0;
    while (Date.now() - started < SETTLE_TIMEOUT) {
      if (await answerPrompts()) {
        quietSince = 0;
        await page.waitForTimeout(150);
        continue;
      }
      const busy = pendingRequests().length > 0 || Date.now() - state.lastActivity < QUIET_MS;
      const indicators = busy ? ['requests'] : await loadingIndicators();
      if (indicators.length === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= QUIET_MS) return { settled: true, ms: Date.now() - started };
      } else quietSince = 0;
      await page.waitForTimeout(100);
    }
    return { settled: false, ms: Date.now() - started, stuck: await loadingIndicators(), pending: pendingRequests().map((r) => r.url()).slice(0, 5) };
  }

  async function capture(name, theme, label, navigateAction) {
    const mark = { responses: events.responses.length, pageErrors: events.pageErrors.length, consoleErrors: events.consoleErrors.length, networkFailures: events.networkFailures.length };
    const startedAt = Date.now();
    await navigateAction();
    const settled = await settle();
    const facts = await page.evaluate(() => ({
      title: document.querySelector('.topbar .title')?.textContent?.trim() ?? document.querySelector('h1')?.textContent?.trim() ?? '',
      nav: [...document.querySelectorAll('nav.nav .nav-group')].map((group) => [group.querySelector('.nav-group-label')?.textContent?.trim(), ...[...group.querySelectorAll('.nav-item span:first-of-type')].map((item) => item.textContent?.trim())].join(': ')),
      url: location.pathname + location.search,
      alerts: [...document.querySelectorAll('[role="alert"], .error-banner, .sync-warning')].map((element) => element.textContent?.trim().slice(0, 300)).filter(Boolean),
      unavailable: [...document.querySelectorAll('h2, h3, .panel-title')].map((element) => element.textContent?.trim()).filter((text) => /unconfigured|unavailable|not configured/i.test(text ?? '')),
      mains: document.querySelectorAll('main').length,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      text: (document.querySelector('main')?.innerText ?? document.body.innerText ?? '').replace(/\s+/g, ' ').trim().length,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      contentText: document.querySelector('main')?.innerText ?? '',
      // A control another element covers cannot be used, however well it renders.
      obstructed: [...document.querySelectorAll('button, a[href], input, select, textarea')].flatMap((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        if (!element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) || !box.width || !box.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return [];
        // Scrolled out of its own list or panel: reachable by scrolling, not covered.
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY === 'visible' && getComputedStyle(parent).overflowX === 'visible') continue;
          const frame = parent.getBoundingClientRect();
          if (y < frame.top || y > frame.bottom || x < frame.left || x > frame.right) return [];
        }
        const top = document.elementFromPoint(x, y);
        // A visually hidden input is operated through its label.
        if (!top || element === top || element.contains(top) || top.contains(element) || element.closest('label')?.contains(top)) return [];
        return [`${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 30)}" under ${top.tagName.toLowerCase()}.${String(top.className).slice(0, 30)}`];
      }),
    }));
    const { contentText, ...visible } = facts;
    const garbage = contentText.match(/(^|\s)(-\d+[smhd] ago|undefined|NaN|\[object Object\]|Invalid Date)(\s|$)/m)?.[2];
    const file = `${name}-${label}.png`.replace(/[^a-z0-9.-]+/gi, '_');
    await page.screenshot({ path: join(output, file), fullPage: false });
    const newResponses = events.responses.slice(mark.responses);
    const row = {
      label,
      ...settled,
      durationMs: Date.now() - startedAt,
      ...visible,
      screenshot: file,
      unexpected: newResponses.filter((entry) => !expectedFailure(entry)).map((entry) => ({ method: entry.method, status: entry.status, path: new URL(entry.url).pathname, error: entry.body?.error ?? entry.body?.message ?? null })),
      pageErrors: events.pageErrors.slice(mark.pageErrors),
      consoleErrors: events.consoleErrors.slice(mark.consoleErrors),
      networkFailures: events.networkFailures.slice(mark.networkFailures),
    };
    row.findings = [
      ...(row.settled ? [] : [`did not settle: ${JSON.stringify(row.stuck)} pending ${JSON.stringify(row.pending)}`]),
      ...(row.mains === 1 ? [] : [`expected one main landmark, found ${row.mains}`]),
      ...(row.overflow ? ['horizontal overflow'] : []),
      ...(row.text > 0 ? [] : ['empty content']),
      ...(row.text > 60000 ? [`oversized content: ${row.text} characters`] : []),
      ...(row.colorScheme === 'dark' ? [] : [`color-scheme is ${row.colorScheme}, expected dark`]),
      ...(garbage ? [`garbage text: ${garbage}`] : []),
      ...row.obstructed.map((text) => `obstructed: ${text}`),
      ...row.alerts.map((text) => `alert: ${text}`),
      ...row.unexpected.map((entry) => `${entry.method} ${entry.path} -> ${entry.status} ${entry.error ?? ''}`.trim()),
      ...row.pageErrors.map((text) => `page error: ${text}`),
      ...row.consoleErrors.map((text) => `console: ${text}`),
      ...row.networkFailures.map((entry) => `network: ${entry.url} ${entry.error}`),
    ];
    console.log(`${name} ${label}: ${row.findings.length ? 'FINDINGS ' + row.findings.length : 'ok'} (${row.durationMs}ms, ${row.text} chars)`);
    return row;
  }

  async function signIn() {
    await page.goto(origin + '/');
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill(credentials.username);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: /sign in/i }).first().click();
    await page.locator('nav.nav').waitFor({ state: 'attached', timeout: 30000 });
    state.loggedIn = true;
  }

  async function walk(name) {
    const [form, theme] = name.split('-');
    const rows = [];
    try {
      await page.setViewportSize(VIEWPORTS[form]);
      await page.emulateMedia({ colorScheme: theme });
      // A leftover choice from when there was a theme control must not matter.
      await page.evaluate(() => localStorage.setItem('hivexui-theme', 'light'));
      await page.reload();
      await page.locator('nav.nav').waitFor({ state: 'attached', timeout: 30000 });

      // Theme: one dark theme, no control, whatever the OS prefers or the browser remembers.
      const appearance = () => page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
      const themeCheck = { noToggle: (await page.locator('button.theme-toggle').count()) === 0, attribute: await page.evaluate(() => document.documentElement.dataset.theme ?? null) };
      const shown = { [theme]: await appearance() };
      const other = theme === 'dark' ? 'light' : 'dark';
      await page.emulateMedia({ colorScheme: other });
      await page.waitForTimeout(150);
      shown[other] = await appearance();
      await page.emulateMedia({ colorScheme: theme });
      themeCheck.appearance = shown;
      themeCheck.dark = Object.values(shown).every((look) => look.scheme === 'dark' && look.background === 'rgb(0, 0, 0)');
      themeCheck.ignoresStored = await page.evaluate(() => localStorage.getItem('hivexui-theme') === 'light');
      await page.evaluate(() => localStorage.removeItem('hivexui-theme'));
      const nav = page.locator('nav.nav button.nav-item');
      // Product and section headings collapse: open them all, so every screen can be reached by index.
      const expandNav = async () => {
        const closed = page.locator('nav.nav button[aria-expanded="false"]');
        while (await closed.count()) await closed.first().click();
      };
      const openNav = async () => {
        if (form === 'mobile') {
          const menu = page.getByRole('button', { name: 'Toggle navigation', exact: true });
          if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
        }
        await expandNav();
      };
      await openNav();
      const labels = await nav.evaluateAll((elements) => elements.map((element) => element.querySelector('span')?.textContent?.trim() ?? ''));
      const only = args.pages?.split(',');
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index];
        if (only && !only.includes(label.toLowerCase())) continue;
        rows.push(await capture(name, theme, label, async () => {
          await openNav();
          await nav.nth(index).click();
        }));
        for (const tab of SUBNAV[label === 'Cindertrace' ? 'security' : ''] ?? []) {
          const region = page.getByRole('navigation', { name: 'Security Fusion' });
          if (!(await region.count())) break;
          rows.push(await capture(name, theme, `${label}/${tab}`, () => region.getByRole('link', { name: tab, exact: true }).click()));
        }
      }
      return { name, themeCheck, rows, offOrigin: [...events.offOrigin] };
    } catch (error) {
      await page.screenshot({ path: join(output, `${name}-crash.png`) }).catch(() => {});
      return { name, crash: String(error), rows, offOrigin: [...events.offOrigin] };
    }
  }
  async function deepLink(name, theme, url) {
    return capture(name, theme, 'link' + url, () => page.goto(origin + url));
  }
  return { signIn, walk, deepLink, stepUps, apiCalls, close: () => context.close() };
}

// Pages fulfilled by --ui-dist have no network address space, so Chromium would treat
// their same-origin WebSocket as a local network request. Real deployments are unaffected.
const browser = await chromium.launch({ headless: true, args: args['ui-dist'] ? ['--disable-features=LocalNetworkAccessChecks'] : [] });
const session = await createSession(browser);
await session.signIn();
const results = [];
const sets = [];
for (const set of productSets) {
  activeProducts = set.products;
  session.apiCalls.clear();
  for (const name of args.matrix.split(',')) {
    const run = await session.walk(name);
    run.name = `${set.name}-${name}`;
    for (const row of run.rows) { const from = join(output, row.screenshot); const to = `${set.name}-${row.screenshot}`; renameSync(from, join(output, to)); row.screenshot = to; }
    results.push(run);
    const [, theme] = name.split('-');
    for (const url of args['deep-links']?.split(',') ?? []) {
      const row = await session.deepLink(`${set.name}-${name}`, theme, url);
      run.rows.push(row);
    }
  }
  sets.push({ set: set.name, products: set.products, apiCalls: [...session.apiCalls].sort() });
}
await session.close();
await browser.close();

const findings = results.flatMap((run) => [
  ...(run.crash ? [{ run: run.name, label: '(crash)', finding: run.crash }] : []),
  ...(run.themeCheck && !(run.themeCheck.noToggle && run.themeCheck.dark && run.themeCheck.ignoresStored && run.themeCheck.attribute === null) ? [{ run: run.name, label: '(theme)', finding: JSON.stringify(run.themeCheck) }] : []),
  ...run.offOrigin.map((value) => ({ run: run.name, label: '(off-origin)', finding: value })),
  ...run.rows.flatMap((row) => row.findings.map((finding) => ({ run: run.name, label: row.label, finding }))),
]);
const summary = {
  result: findings.length ? 'findings' : 'passed',
  origin,
  checkedAt: new Date().toISOString(),
  views: results.reduce((total, run) => total + run.rows.length, 0),
  findings,
  stepUps: session.stepUps.length,
  sets,
  runs: results,
};
writeFileSync(join(output, 'walkthrough.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
console.log(`\n${summary.result}: ${summary.views} views, ${findings.length} findings`);
const grouped = new Map();
for (const item of findings) grouped.set(item.finding, [...(grouped.get(item.finding) ?? []), `${item.run}:${item.label}`]);
for (const [finding, where] of grouped) console.log(`- ${finding.slice(0, 220)}\n    (${where.length}x) ${where.slice(0, 4).join(', ')}`);
process.exit(findings.length ? 1 : 0);
