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

// Legacy callers use the same ordinary HTTP getter and cooldown.
export function browserGetter() { return httpGet; }
import { httpGet } from './stock.js';
