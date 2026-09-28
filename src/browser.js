// One shared browser window with its own profile, so an Apple ID sign-in and cookies stick around.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { DATA_DIR } from './settings.js';

let context = null;
let launching = null;

export async function getBrowser(opts = {}) {
  if (context) return context;
  if (launching) return launching;
  const profile = path.join(DATA_DIR, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const base = {
    headless: !!opts.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  };
  launching = (async () => {
    try {
      if (opts.browser === 'chrome') {
        try {
          return await chromium.launchPersistentContext(profile, { ...base, channel: 'chrome' });
        } catch {
          // Google Chrome isn't installed; fall back to Playwright's Chromium.
        }
      }
      return await chromium.launchPersistentContext(profile, base);
    } finally {
      launching = null;
    }
  })();
  context = await launching;
  context.on('close', () => {
    context = null;
  });
  return context;
}

export async function closeBrowser() {
  const c = context;
  context = null;
  if (c) await c.close().catch(() => {});
}

export async function newPage(opts) {
  const ctx = await getBrowser(opts);
  return ctx.newPage();
}

// Fetches a URL from inside apple.com, so it carries the browser's cookies and fingerprint.
export function browserGetter(opts) {
  let page = null;
  return async (url) => {
    if (!page || page.isClosed()) {
      page = await newPage(opts);
      await page.goto('https://www.apple.com/shop/buy-iphone', { waitUntil: 'domcontentloaded' });
    }
    const { status, text } = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, text: await r.text() };
    }, url);
    if (status >= 400) throw new Error(`Apple returned HTTP ${status} in the browser`);
    return text;
  };
}
