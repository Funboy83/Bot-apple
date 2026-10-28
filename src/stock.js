// Finds part numbers on Apple's buy page and asks Apple which stores can hand them over.
import { CATALOG } from './settings.js';

const APPLE = 'https://www.apple.com';

// Shared across scheduled and manual checks; switching settings cannot skip cooldown.
export function createInventoryGetter({ fetcher = fetch, now = Date.now } = {}) {
  let failures = 0, nextAt = 0, busy = false;
  return async (url) => {
    if (busy || now() < nextAt) {
      throw Object.assign(new Error('Inventory unknown: checks are cooling down'), { retryAt: nextAt });
    }
    busy = true;
    try {
      const res = await fetcher(url, {
        headers: { Accept: 'application/json,text/html;q=0.9', 'User-Agent': 'Bot-apple/0.1 inventory monitor' },
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      if (!res.ok) {
        const retry = res.headers.get('retry-after');
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now();
        throw Object.assign(new Error(`Inventory unknown: Apple returned HTTP ${res.status} for ${new URL(url).pathname}`), {
          statusCode: res.status, retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : 0,
        });
      }
      const text = await res.text();
      if (new URL(url).pathname.endsWith('/pickup-message')) {
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('Inventory unknown: Apple returned a web page or bot check'); }
        parseAvailability(data, [...new URL(url).searchParams].filter(([k]) => k.startsWith('parts.')).map(([, v]) => v));
      }
      failures = 0;
      nextAt = new URL(url).pathname.endsWith('/pickup-message') ? now() + 30000 : 0;
      return text;
    } catch (err) {
      failures++;
      nextAt = now() + Math.max(Math.min(3600000, 300000 * 2 ** Math.min(failures - 1, 4)), [403, 541].includes(err.statusCode) ? 3600000 : 0, err.retryAfterMs || 0);
      err.retryAt = nextAt;
      throw err;
    } finally { busy = false; }
  };
}

export const httpGet = createInventoryGetter();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Pulls every flat JSON object with a partNumber out of the page's embedded data.
export function parseProducts(html) {
  const products = new Map();
  const re = /\{[^{}]*"partNumber"\s*:\s*"[A-Z0-9]+\/[A-Z]"[^{}]*\}/g;
  for (const match of html.matchAll(re)) {
    let obj;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      continue;
    }
    if (!obj.partNumber) continue;
    const prev = products.get(obj.partNumber) || {};
    products.set(obj.partNumber, { ...prev, ...obj });
  }
  // Current buy pages put nested product data in a JSON metrics script.
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root;
    try { root = JSON.parse(match[1]); } catch { continue; }
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (/^[A-Z0-9]+\/[A-Z]$/.test(value.partNumber || '')) {
        const name = String(value.name || '');
        const named = /^(iPhone .+?)\s+(\d+\s*(?:GB|TB))\s+(.+)$/i.exec(name);
        const product = { ...value };
        if (named) {
          product.modelName = named[1];
          product.dimensionCapacity ||= named[2].replace(/\s/g, '');
          product.dimensionColor ||= named[3];
        }
        products.set(value.partNumber, { ...product, ...(products.get(value.partNumber) || {}) });
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(root);
  }
  return [...products.values()];
}

function isUnlocked(p) {
  const carrier = norm(p.carrierModel || p.carrier || p.dimensionCarrier);
  return !carrier || carrier.includes('unlocked') || carrier.includes('connectonyourownlater');
}

export function findPart(products, target) {
  const model = CATALOG[target.model];
  if (!model) return null;
  const wantScreen = norm(model.screen).replace('inch', '');
  const wantCap = norm(target.capacity);
  const wantColor = norm(target.color);
  const candidates = products.filter((p) => {
    const screen = norm(p.dimensionScreensize);
    return (
      (!p.modelName || norm(p.modelName) === norm(model.label)) &&
      (!screen || screen.includes(wantScreen)) &&
      norm(p.dimensionCapacity) === wantCap &&
      isUnlocked(p)
    );
  });
  const color = (p) => norm(p.dimensionColor);
  const hit =
    candidates.find((p) => color(p) === wantColor) ||
    candidates.find((p) => color(p).includes(wantColor) || (color(p) && wantColor.includes(color(p))));
  return hit ? hit.partNumber : null;
}

// Fills in missing part numbers. Returns [{...target, partNumber}] and a list of problems.
export async function resolveParts(targets, get = httpGet) {
  const pages = new Map();
  const resolved = [];
  const problems = [];
  for (const t of targets) {
    if (t.partNumber) {
      resolved.push(t);
      continue;
    }
    const model = CATALOG[t.model];
    if (!model) {
      problems.push(`Unknown model ${t.model}`);
      continue;
    }
    if (!pages.has(model.page)) {
      pages.set(model.page, parseProducts(await get(`${APPLE}/shop/buy-iphone/${model.page}`)));
    }
    const part = findPart(pages.get(model.page), t);
    if (part) resolved.push({ ...t, partNumber: part });
    else problems.push(`Couldn't find the part number for ${model.label} ${t.capacity} ${t.color} on apple.com. Paste it into settings.`);
  }
  return { resolved, problems };
}

export function fulfillmentUrl(parts, zip) {
  const q = new URLSearchParams({ pl: 'true', 'mts.0': 'regular', searchNearby: 'true', location: zip });
  [...new Set(parts)].forEach((p, i) => q.set(`parts.${i}`, p));
  return `${APPLE}/shop/retail/pickup-message?${q}`;
}

function distanceMiles(store) {
  const raw = store.storeDistanceWithUnit ?? store.storedistance ?? store.storeDistanceVoText;
  const n = parseFloat(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Turns Apple's fulfillment response into one row per (store, part).
export function parseAvailability(json, parts) {
  const stores = json?.body?.stores;
  if (!Array.isArray(stores) || !stores.length || (json?.head?.status && String(json.head.status) !== '200')) {
    const msg = json?.body?.content?.pickupMessage?.errorMessage || json?.head?.status;
    throw new Error(`Unexpected stock response from Apple${msg ? `: ${msg}` : ''}`);
  }
  const rows = [];
  for (const s of stores) {
    for (const part of parts) {
      const a = s.partsAvailability?.[part];
      const display = a?.pickupDisplay;
      const status = display === 'available' ? 'available' : display === 'unavailable' ? 'unavailable' : 'unknown';
      rows.push({
        part,
        storeNumber: s.storeNumber,
        storeName: s.storeName,
        city: [s.city, s.state].filter(Boolean).join(', '),
        distance: distanceMiles(s),
        status,
        available: status === 'unknown' ? null : status === 'available',
        quote: status === 'unknown' ? `Unknown: ${display || 'missing availability'}` : (a.pickupSearchQuote || a.messageTypes?.regular?.storePickupQuote || display),
      });
    }
  }
  return rows;
}

export function filterRows(rows, pickup) {
  const allowed = new Set((pickup.storeNumbers || []).map((s) => s.toUpperCase()));
  return rows.filter(
    (r) =>
      (allowed.size === 0 || allowed.has(String(r.storeNumber).toUpperCase())) &&
      (r.distance === null || !pickup.maxDistanceMiles || r.distance <= Number(pickup.maxDistanceMiles)),
  );
}

export async function checkStock(parts, pickup, get = httpGet) {
  const text = await get(fulfillmentUrl(parts, pickup.zip));
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Apple sent a web page instead of stock data (likely a bot check). Checks will back off; check Apple manually.');
  }
  return filterRows(parseAvailability(json, parts), pickup);
}
