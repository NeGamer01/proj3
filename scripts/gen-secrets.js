// node scripts/gen-secrets.js  -> paste into .env
const c = require('crypto');
console.log(`SESSION_SECRET=${c.randomBytes(32).toString('hex')}
PROVIDER_MASTER_KEY=${c.randomBytes(32).toString('hex')}
ADMIN_PASSWORD=${c.randomBytes(9).toString('base64url')}`);
