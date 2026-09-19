// node scripts/create-admin.js email@domain password
const db = require('../src/db'); const users = require('../src/services/users');
const [email, password] = process.argv.slice(2);
if (!email || !password) { console.log('Usage: node scripts/create-admin.js <email> <password>'); process.exit(1); }
db.migrate().then(() => users.register({ email, password, name: 'Admin', role: 'admin' })).then((u) => { console.log('admin created:', u.email); return db.close(); }).catch((e) => { console.error(e.message); process.exit(1); });
