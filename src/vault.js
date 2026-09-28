// Encrypts private details (card, contact info, alert passwords) at rest.
// The passphrase is never written to disk; it only lives in memory while the app runs.
import crypto from 'node:crypto';
import fs from 'node:fs';

const ALGO = 'aes-256-gcm';

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encrypt(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decrypt(blob, passphrase) {
  const decipher = crypto.createDecipheriv(
    ALGO,
    deriveKey(passphrase, Buffer.from(blob.salt, 'base64')),
    Buffer.from(blob.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  try {
    const out = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    throw new Error('Wrong passphrase');
  }
}

export class Vault {
  constructor(file) {
    this.file = file;
    this.passphrase = null;
    this.secrets = null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  get unlocked() {
    return this.secrets !== null;
  }

  // First unlock creates the vault with this passphrase.
  unlock(passphrase) {
    if (!passphrase || passphrase.length < 6) throw new Error('Passphrase must be at least 6 characters');
    this.secrets = this.exists() ? decrypt(JSON.parse(fs.readFileSync(this.file, 'utf8')), passphrase) : {};
    this.passphrase = passphrase;
    if (!this.exists()) this.save({});
    return this.secrets;
  }

  lock() {
    this.passphrase = null;
    this.secrets = null;
  }

  save(secrets) {
    if (!this.passphrase) throw new Error('Vault is locked');
    this.secrets = secrets;
    fs.writeFileSync(this.file, JSON.stringify(encrypt(secrets, this.passphrase)), { mode: 0o600 });
  }

  reset() {
    this.lock();
    if (this.exists()) fs.unlinkSync(this.file);
  }
}
