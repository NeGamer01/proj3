// Static verification for the landing page (no DB needed).
const express = require('express');
const path = require('path');
const app = express();
const pub = path.join(__dirname, '..', 'public');
app.use('/assets', express.static(path.join(pub, 'assets')));
app.get('/landing.css', (_q, r) => r.sendFile(path.join(pub, 'landing.css')));
app.get('/', (_q, r) => r.sendFile(path.join(pub, 'landing.html')));

const srv = app.listen(3111, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:3111';
  const checks = [
    ['GET / (landing.html)', '/', (s) => s.includes('Terima pembayaran') && s.includes('QRISPay')],
    ['GET /landing.css', '/landing.css', (s) => s.includes('--accent') && s.includes('.hero')],
    ['GET /assets/logo.svg', '/assets/logo.svg', (s) => s.trimStart().startsWith('<svg')],
    ['GET /assets/app.css', '/assets/app.css', (s) => s.includes(':root')],
    ['title tag', '/', (s) => /<title>QRISPay/.test(s)],
    ['lang=id', '/', (s) => /<html lang="id">/.test(s)],
    ['all /assets/ refs resolve', '/', null, ''], // handled below
  ];
  const idx = checks.findIndex((c) => c[2] === null);
  {
    const html = await (await fetch(base + '/')).text();
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const uniq = [...new Set(refs)];
    let missing = 0;
    for (const r of uniq) {
      const st = (await fetch(base + r)).status;
      if (st !== 200) { missing += 1; console.log(`  MISSING ${r} -> HTTP ${st}`); }
    }
    checks[idx][2] = () => missing === 0 && uniq.length > 0;
    checks[idx][3] = `${uniq.length} refs`;
  }
  let ok = 0;
  for (const [name, p, test] of checks) {
    const res = await fetch(base + p);
    const txt = await res.text();
    const pass = res.ok && test(txt);
    ok += pass ? 1 : 0;
    console.log(`${(pass ? 'PASS' : 'FAIL').padEnd(5)} ${name.padEnd(30)} HTTP ${res.status}  ${txt.length} bytes`);
  }
  console.log(`\n${ok}/${checks.length} checks passed`);
  srv.close();
  process.exit(ok === checks.length ? 0 : 1);
});
