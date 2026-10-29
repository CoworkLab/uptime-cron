import crypto from 'node:crypto';

const ALPHA = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function genId(prefix, len = 12) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return prefix + s;
}

export function genApiKey() {
  return 'uc_user_' + crypto.randomBytes(24).toString('hex');
}

export function genDevKey() {
  return 'uc_dev_' + crypto.randomBytes(24).toString('hex');
}
