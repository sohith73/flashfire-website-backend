import crypto from 'crypto';
import { IntegrationKeyModel } from '../Schema_Models/IntegrationKey.js';

// Key check for scripts that call us (Apps Script and the like). No env var is needed: the first key of 32+
// characters a script presents is enrolled and only its SHA-256 hash is stored (collection integrationkeys); after
// that only that key is accepted. If the env var named in `envVar` is set, it wins over the enrolled key.

const MIN_KEY_CHARS = 32;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

export function makeKeyCheck({ name, envVar, Model = IntegrationKeyModel }) {
  return async function keyOk(given) {
    if (typeof given !== 'string' || given.length < MIN_KEY_CHARS) return false;
    const fromEnv = envVar ? process.env[envVar] || '' : '';
    if (fromEnv) return crypto.timingSafeEqual(sha256(given), sha256(fromEnv));

    let doc = await Model.findOne({ name }).lean();
    if (!doc) {
      try {
        await Model.create({ name, keyHash: sha256(given).toString('hex') });
        console.log(`[integrationKey] enrolled the ${name} key (first use)`);
        return true;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        doc = await Model.findOne({ name }).lean(); // a parallel first call enrolled it
      }
    }
    return crypto.timingSafeEqual(sha256(given), Buffer.from(doc.keyHash, 'hex'));
  };
}
