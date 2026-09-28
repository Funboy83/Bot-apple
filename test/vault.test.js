import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, encrypt, decrypt } from '../src/vault.js';

test('round-trips and rejects a wrong passphrase', () => {
  const blob = encrypt({ card: { number: '4111111111111111' } }, 'correct horse');
  assert.ok(!JSON.stringify(blob).includes('4111'));
  assert.equal(decrypt(blob, 'correct horse').card.number, '4111111111111111');
  assert.throws(() => decrypt(blob, 'wrong pass'), /Wrong passphrase/);
});

test('vault file is encrypted on disk and reopens with the passphrase', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'secrets.enc');
  const v = new Vault(file);
  v.unlock('secret123');
  v.save({ contact: { phone: '5551234567' } });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('5551234567'));
  const again = new Vault(file);
  assert.throws(() => again.unlock('nope123'), /Wrong passphrase/);
  assert.equal(again.unlock('secret123').contact.phone, '5551234567');
});
