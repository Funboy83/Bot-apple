// The watch loop: check stock, alert, and hand off to checkout.
import { withinCheckingHours } from './schedule.js';
import { EventEmitter } from 'node:events';
import { resolveParts, checkStock, httpGet } from './stock.js';
import { notifyAll } from './notify.js';
import { runCheckout } from './checkout.js';
import { CATALOG, targetLabel } from './settings.js';

const CHECKOUT_RETRY_MS = 2 * 60 * 1000;

export class Bot extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.timer = null;
    this.logs = [];
    this.reset();
  }

  reset() {
    this.parts = null;
    this.lastCheck = null;
    this.lastRows = [];
    this.lastError = null;
    this.retryAt = 0;
    this.waitingForHours = false;
    this.ordersPlaced = 0;
    this.orders = [];
    this.checkoutBusy = false;
    this.awaitingYou = null;
    this.nextCheckoutAt = 0;
    this.alerted = new Map();
  }

  log(msg, level = 'info') {
    const entry = { at: new Date().toISOString(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', entry);
    console.log(`[${entry.at}] ${msg}`);
  }

  status() {
    return {
      running: this.running,
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      retryAt: this.retryAt,
      waitingForHours: this.waitingForHours,
      parts: this.parts,
      rows: this.lastRows,
      ordersPlaced: this.ordersPlaced,
      orders: this.orders,
      checkoutBusy: this.checkoutBusy,
      awaitingYou: this.awaitingYou,
    };
  }

  start(settings, secrets) {
    if (this.running) return;
    const missing = [];
    if (!settings.pickup.zip) missing.push('pickup ZIP code');
    if (settings.checkout.mode !== 'alert-only') {
      const c = secrets.contact || {};
      if (!c.firstName || !c.lastName || !c.email || !c.phone) missing.push('your name, email and phone');
      const k = secrets.card || {};
      if (!k.number || !k.expMonth || !k.expYear || !k.cvv) missing.push('card details');
      if (!secrets.billing?.street || !secrets.billing?.zip) missing.push('billing address');
      if (settings.checkout.pickupBySomeoneElse && !secrets.pickupPerson?.firstName) missing.push('pickup person');
    }
    if (missing.length) throw Object.assign(new Error(`Missing: ${missing.join(', ')}`), { status: 400 });
    this.reset();
    this.settings = settings;
    this.secrets = secrets;
    this.get = httpGet;
    this.running = true;
    this.log(`Started. Watching ${settings.targets.map(targetLabel).join(', ')} near ${settings.pickup.zip}. Mode: ${settings.checkout.mode}.`);
    this.emit('status');
    this.tick();
  }

  stop(reason = 'Stopped') {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) this.log(reason);
    this.running = false;
    this.emit('status');
  }

  // Lets checkout run again after it stopped for you to press Place Order.
  resumeCheckout() {
    this.awaitingYou = null;
    this.nextCheckoutAt = 0;
    this.log('Auto-checkout resumed');
    this.emit('status');
  }

  schedule() {
    if (!this.running) return;
    const { intervalSec, jitterSec } = this.settings.check;
    const ms = (Math.max(60, Number(intervalSec) || 60) + Math.random() * Number(jitterSec || 0)) * 1000;
    this.timer = setTimeout(() => this.tick(), Math.max(ms, this.retryAt - Date.now()));
  }

  async alert(subject, text) {
    const results = await notifyAll(this.settings.alerts, this.secrets.alerts, subject, text);
    for (const [ch, r] of Object.entries(results)) if (r !== 'ok') this.log(`Alert by ${ch} failed: ${r}`, 'warn');
  }

  async tick() {
    if (!this.running) return;
    if (!withinCheckingHours(this.settings.check)) {
      this.waitingForHours = true;
      this.emit('status');
      this.timer = setTimeout(() => this.tick(), 60000);
      return;
    }
    this.waitingForHours = false;
    try {
      if (!this.parts) {
        const { resolved, problems } = await resolveParts(this.settings.targets, this.get);
        problems.forEach((p) => this.log(p, 'warn'));
        if (!resolved.length) throw new Error('No part numbers to check');
        this.parts = resolved;
        this.log(`Part numbers: ${resolved.map((t) => `${targetLabel(t)} = ${t.partNumber}`).join('; ')}`);
      }
      const rows = await checkStock(this.parts.map((t) => t.partNumber), this.settings.pickup, this.get);
      this.lastRows = rows;
      this.lastCheck = new Date().toISOString();
      this.lastError = rows.some((r) => r.status === 'unknown') ? 'Some inventory is unknown; see stock table' : null;
      this.retryAt = 0;
      const available = rows.filter((r) => r.available);
      this.emit('status');
      if (!available.length && !this.lastError) {
        this.log(`No pickup stock at ${new Set(rows.map((r) => r.storeNumber)).size} stores`);
      } else {
        await this.onStock(available);
      }
    } catch (err) {
      this.lastError = err.message;
      this.retryAt = err.retryAt || Date.now() + 300000;
      this.lastRows = this.lastRows.map((r) => ({ ...r, status: 'unknown', available: null, quote: `Unknown: ${err.message}` }));
      this.emit('status');
      this.log(`Check failed: ${err.message}`, 'error');
    }
    this.schedule();
  }

  async onStock(available) {
    // Best choice: first target in your priority order, then the closest store.
    let pick = null;
    for (const t of this.parts) {
      const rows = available.filter((r) => r.part === t.partNumber).sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
      if (rows.length) {
        pick = { target: t, store: rows[0], all: rows };
        break;
      }
    }
    if (!pick) return;
    const label = targetLabel(pick.target);
    const where = pick.all.slice(0, 5).map((r) => `${r.storeName} (${r.quote})`).join(', ');
    this.log(`IN STOCK: ${label} at ${where}`);

    const key = `${pick.target.partNumber}@${pick.store.storeNumber}`;
    const repeatMs = Number(this.settings.alerts.repeatMinutes || 10) * 60000;
    if (Date.now() - (this.alerted.get(key) || 0) > repeatMs) {
      this.alerted.set(key, Date.now());
      const model = CATALOG[pick.target.model];
      const link = `https://www.apple.com/shop/buy-iphone/${model?.page || ''}`;
      await this.alert(`In stock: ${label}`, `Pickup at ${where}.\n${link}`);
    }

    const mode = this.settings.checkout.mode;
    if (mode === 'alert-only' || this.checkoutBusy || this.awaitingYou || Date.now() < this.nextCheckoutAt) return;
    if (this.ordersPlaced >= Number(this.settings.checkout.maxOrders || 1)) return;

    this.checkoutBusy = true;
    this.emit('status');
    try {
      const result = await runCheckout({
        target: pick.target,
        store: pick.store,
        settings: this.settings,
        secrets: this.secrets,
        log: (m) => this.log(m),
        onNeedsYou: (m) => {
          this.log(m, 'warn');
          this.alert('Action needed', m);
        },
      });
      if (result.placed) {
        this.ordersPlaced++;
        this.orders.push({ at: new Date().toISOString(), label, store: pick.store.storeName, orderNumber: result.orderNumber });
        this.log(`ORDER PLACED: ${label} for pickup at ${pick.store.storeName}${result.orderNumber ? `, order ${result.orderNumber}` : ''}`);
        await this.alert(`Order placed: ${label}`, `Pickup at ${pick.store.storeName}. ${result.orderNumber ? `Order ${result.orderNumber}. ` : ''}Check your email from Apple.`);
        if (this.ordersPlaced >= Number(this.settings.checkout.maxOrders || 1)) this.stop('Reached the order limit, stopped');
      } else {
        this.awaitingYou = `${label} at ${pick.store.storeName}`;
      }
    } catch (err) {
      this.nextCheckoutAt = Date.now() + CHECKOUT_RETRY_MS;
      this.log(`Checkout failed at "${err.step || 'unknown'}": ${err.message}. Screenshot: ${err.screenshot || 'none'}. Retrying in 2 minutes.`, 'error');
      await this.alert(`Checkout failed: ${label}`, `Stopped at "${err.step || 'checkout'}". It's still in stock at ${pick.store.storeName}, buy it by hand now: https://www.apple.com/shop/bag`);
    } finally {
      this.checkoutBusy = false;
      this.emit('status');
    }
  }
}
