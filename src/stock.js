// Finds part numbers on Apple's buy page and asks Apple which stores can hand them over.
import { CATALOG } from './settings.js';

const APPLE = 'https://www.apple.com';

export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${APPLE}/shop/buy-iphone`,
};

// Plain HTTP fetcher. The browser-backed one in browser.js has the same shape.
export async function httpGet(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`Apple returned HTTP ${res.status} for ${new URL(url).pathname}`);
  return res.text();
}

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
      (!screen || screen.includes(wantScreen)) &&
      norm(p.dimensionCapacity) === wantCap &&
      isUnlocked(p)
    );
  });
  const color = (p) => norm(p.dimensionColor);
  const hit =
    candidates.find((p) => color(p) === wantColor) ||
    candidates.find((p) => color(p).includes(wantColor) || wantColor.includes(color(p)));
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
  const q = new URLSearchParams({ fae: 'true', pl: 'true', 'mts.0': 'regular', 'mts.1': 'compact', searchNearby: 'true', location: zip });
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  return `${APPLE}/shop/fulfillment-messages?${q}`;
}

function distanceMiles(store) {
  const raw = store.storeDistanceWithUnit ?? store.storedistance ?? store.storeDistanceVoText;
  const n = parseFloat(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Turns Apple's fulfillment response into one row per (store, part).
export function parseAvailability(json, parts) {
  const stores = json?.body?.content?.pickupMessage?.stores;
  if (!Array.isArray(stores)) {
    const msg = json?.body?.content?.pickupMessage?.errorMessage || json?.head?.status;
    throw new Error(`Unexpected stock response from Apple${msg ? `: ${msg}` : ''}`);
  }
  const rows = [];
  for (const s of stores) {
    for (const part of parts) {
      const a = s.partsAvailability?.[part];
      if (!a) continue;
      rows.push({
        part,
        storeNumber: s.storeNumber,
        storeName: s.storeName,
        city: [s.city, s.state].filter(Boolean).join(', '),
        distance: distanceMiles(s),
        available: a.pickupDisplay === 'available',
        quote: a.pickupSearchQuote || a.messageTypes?.regular?.storePickupQuote || a.pickupDisplay,
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
    throw new Error('Apple sent a web page instead of stock data (likely a bot check). Try "Check stock in a real browser".');
  }
  return filterRows(parseAvailability(json, parts), pickup);
}
