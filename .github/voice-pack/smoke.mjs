// Serves out/ locally, loads the pack into a page, goes offline, and checks it speaks.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const here = path.dirname(new URL(import.meta.url).pathname), root = path.join(here, 'out');
fs.copyFileSync(path.join(here, 'smoke.html'), path.join(root, 'smoke.html'));
const srv = http.createServer((q, s) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(s);
}).listen(0, '127.0.0.1');
await new Promise(r => srv.on('listening', r));
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', m => console.log('[page]', m.text()));
await page.goto(`http://127.0.0.1:${srv.address().port}/smoke.html`);
console.log('files', await page.evaluate(() => window.prepare()));
await ctx.setOffline(true);
const text = 'This is the week in review. Blue held its nerve, and the next crisis comes in two weeks.';
const log = await page.evaluate(t => window.run(t), text);
console.log(JSON.stringify(log, null, 1));
await browser.close();
srv.close();
const a = log.find(x => x.t === 'audio');
const ok = a && a.n / a.rate > 2 && a.peak > 0.01;
const sum = JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
Object.assign(sum, { smoke: ok ? 'pass' : 'fail', loadMs: Math.round((log.find(x => x.t === 'ready') || {}).ms || 0), speakMs: a ? Math.round(a.ms) : 0, seconds: a ? +(a.n / a.rate).toFixed(2) : 0, misses: (a || log.find(x => x.t === 'ready') || {}).misses || [], error: (log.find(x => x.t === 'err') || {}).m || '' });
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(sum, null, 1));
if (!ok) { console.error('SMOKE TEST FAILED'); process.exit(1); }
console.log('SMOKE TEST PASSED');
