/**
 * Builds CognitiveTerrain-Voice-Emma.zip, the optional voice pack.
 * Runs in GitHub Actions (needs npm and huggingface.co). Output in ./out.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'pack.json'), 'utf8'));
const out = path.join(here, 'out'), pack = path.join(out, 'pack');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(pack, { recursive: true });
// Package folders (some packages do not export package.json, so look on disk).
const pkgDir = (name, from = here) => {
  for (let d = from; ; d = path.dirname(d)) {
    const c = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(c, 'package.json'))) {
      return c;
    }
    if (d === path.dirname(d)) {
      throw new Error('package not found: ' + name);
    }
  }
};
const ver = name => JSON.parse(fs.readFileSync(path.join(pkgDir(name), 'package.json'), 'utf8')).version;

// kokoro-js may carry its own copy of transformers.js; use that one everywhere,
// so the settings made in engine.mjs reach the copy that loads the model.
const kokoroDir = pkgDir('kokoro-js');
const tfDir = pkgDir('@huggingface/transformers', kokoroDir);
const kpj = JSON.parse(fs.readFileSync(path.join(kokoroDir, 'package.json'), 'utf8'));
console.log('kokoro-js', JSON.stringify({ main: kpj.main, module: kpj.module, browser: kpj.browser, exports: kpj.exports, deps: kpj.dependencies }), fs.readdirSync(path.join(kokoroDir, 'dist')).join(' '));
const oneTransformers = {
  name: 'one-transformers',
  setup(b) {
    // kokoro-js's browser file has its own copy of transformers.js built in; use its plain module instead.
    b.onResolve({ filter: /^kokoro-js$/ }, () => ({ path: path.join(kokoroDir, 'dist/kokoro.js') }));
    b.onResolve({ filter: /^@huggingface\/transformers$/ }, a => a.pluginData === 'inner' ? undefined
      : b.resolve(a.path, { resolveDir: kokoroDir, kind: a.kind, pluginData: 'inner' }));
  }
};


// 1. Bundle the engine (kokoro-js + transformers.js + onnxruntime-web + phonemizer) into one file.
const res = await build({
  entryPoints: [path.join(here, 'engine.mjs')], bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', minify: true, outfile: path.join(pack, 'engine.js'), metafile: true, legalComments: 'none', logLevel: 'warning', plugins: [oneTransformers]
});
const js = fs.readFileSync(path.join(pack, 'engine.js'), 'utf8');
console.log('engine.js', (js.length / 1e6).toFixed(2), 'MB', 'espeak inside:', /espeak/i.test(js), 'versions seen:', [...new Set(js.match(/\b3\.\d+\.\d+\b/g) || [])].slice(0, 12).join(' '));

// 2. The onnxruntime-web files the bundle asks for.
const ortDir = pkgDir('onnxruntime-web', tfDir);
const ortVer = JSON.parse(fs.readFileSync(path.join(ortDir, 'package.json'), 'utf8')).version;
const named = [...new Set(js.match(/ort-wasm[\w.-]*?\.(?:wasm|mjs)/g) || [])];
console.log('onnxruntime-web', ortVer, 'names in bundle:', named.join(', ') || '(none)');
console.log('dist files:', fs.readdirSync(path.join(ortDir, 'dist')).filter(f => /\.(wasm|mjs)$/.test(f) && f.startsWith('ort-wasm')).join(', '));
const wasmNames = named.filter(n => n.endsWith('.wasm'));
if (wasmNames.length !== 1) {
  throw new Error('Expected exactly one ORT wasm name in the bundle, found: ' + wasmNames.join(', '));
}
const ort = { wasm: 'ort/' + wasmNames[0] };
const mjsName = wasmNames[0].replace(/\.wasm$/, '.mjs');
fs.mkdirSync(path.join(pack, 'ort'));
fs.copyFileSync(path.join(ortDir, 'dist', wasmNames[0]), path.join(pack, ort.wasm));
if (fs.existsSync(path.join(ortDir, 'dist', mjsName))) {
  ort.mjs = 'ort/' + mjsName;
  fs.copyFileSync(path.join(ortDir, 'dist', mjsName), path.join(pack, ort.mjs));
}

// 3. The model at a fixed revision: config, tokenizer, the 8-bit model and one voice.
const api = await (await fetch(`https://huggingface.co/api/models/${cfg.model}${cfg.revision ? '/revision/' + cfg.revision : ''}`)).json();
const rev = api.sha;
const want = api.siblings.map(s => s.rfilename).filter(f =>
  (!f.includes('/') && /\.(json|txt)$/.test(f)) || f === `onnx/${cfg.onnx}` || f === `voices/${cfg.voice}.bin`);
for (const f of want) {
  const r = await fetch(`https://huggingface.co/${cfg.model}/resolve/${rev}/${f}`);
  if (!r.ok) {
    throw new Error(`download ${f}: ${r.status}`);
  }
  const dst = path.join(pack, 'model', f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
  console.log('model', f, fs.statSync(dst).size);
}
if (!want.includes(`onnx/${cfg.onnx}`) || !want.includes(`voices/${cfg.voice}.bin`)) {
  throw new Error('model or voice file missing upstream');
}

// 4. Licences for everything bundled, plus the model's.
const pkgs = new Set();
for (const f of Object.keys(res.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(f);
  if (m) {
    pkgs.add(m[1]);
  }
}
fs.mkdirSync(path.join(pack, 'LICENSES'));
const licences = {};
for (const p of [...pkgs].sort()) {
  const dir = pkgDir(p, tfDir);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  licences[p] = { version: pj.version, licence: pj.license || '(see file)', repository: (pj.repository && (pj.repository.url || pj.repository)) || '' };
  const lf = fs.readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const dst = path.join(pack, 'LICENSES', p.replace('/', '__') + '.txt');
  if (lf) {
    fs.copyFileSync(path.join(dir, lf), dst);
  } else if (pj.license === 'MIT' && p.startsWith('onnxruntime')) {
    fs.writeFileSync(dst, fs.readFileSync(path.join(here, 'MIT-onnxruntime.txt'), 'utf8'));
  }
  for (const x of ['README.md', 'package.json']) {
    const t = fs.existsSync(path.join(dir, x)) ? fs.readFileSync(path.join(dir, x), 'utf8') : '';
    const hit = t.split('\n').filter(l => /espeak|gpl/i.test(l)).slice(0, 6);
    if (hit.length) console.log('licence note', p, x, hit.join(' | '));
  }
  console.log('bundled', p, pj.version, pj.license, lf || '(no licence file)');
}
const apache = fs.readdirSync(path.join(pack, 'LICENSES')).find(f => f.startsWith('kokoro-js'));
fs.copyFileSync(apache ? path.join(pack, 'LICENSES', apache) : path.join(here, 'APACHE-2.0.txt'), path.join(pack, 'LICENSES', 'Kokoro-82M-model.txt'));
for (const extra of cfg.extraLicences || []) {
  fs.copyFileSync(path.join(here, extra.file), path.join(pack, 'LICENSES', extra.as));
}
fs.writeFileSync(path.join(pack, 'README.txt'), fs.readFileSync(path.join(here, 'README.txt'), 'utf8')
  .replace('{{MODEL}}', `${cfg.model} @ ${rev.slice(0, 12)} (${cfg.onnx}, voice ${cfg.voice})`)
  .replace('{{PACKAGES}}', Object.entries(licences).map(([p, l]) => `  ${p} ${l.version}  ${l.licence}  ${l.repository}`).join('\n')));

// 5. Manifest with a fingerprint for every file. The game knows the manifest's own fingerprint.
const sha = b => createHash('sha256').update(b).digest('hex');
const files = {};
const walk = d => fs.readdirSync(path.join(pack, d)).sort().forEach(f => {
  const rel = d ? d + '/' + f : f, abs = path.join(pack, rel);
  if (fs.statSync(abs).isDirectory()) {
    walk(rel);
  } else {
    const b = fs.readFileSync(abs);
    files[rel] = { size: b.length, sha256: sha(b) };
  }
});
walk('');
const manifest = {
  format: 1, id: cfg.id, title: 'Cognitive Terrain · Immersive Edition voice pack', voice: cfg.voice, voiceName: cfg.voiceName,
  engine: 'engine.js', model: { id: cfg.model, revision: rev, dtype: cfg.dtype }, ort,
  versions: { 'kokoro-js': ver('kokoro-js'), '@huggingface/transformers': ver('@huggingface/transformers'), 'onnxruntime-web': ortVer },
  files
};
const mtxt = JSON.stringify(manifest, null, 1) + '\n';
fs.writeFileSync(path.join(pack, 'manifest.json'), mtxt);

// 6. Zip without compression (the model does not compress, and stored zips load fastest).
for (const f of [...Object.keys(files), 'manifest.json']) {
  fs.utimesSync(path.join(pack, f), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
}
const zipName = cfg.zip;
execFileSync('zip', ['-0', '-X', '-q', '-r', path.join(out, zipName), 'manifest.json', ...Object.keys(files)], { cwd: pack });
const total = fs.statSync(path.join(out, zipName)).size;
const summary = { zip: zipName, bytes: total, manifestSha256: sha(Buffer.from(mtxt)), zipSha256: sha(fs.readFileSync(path.join(out, zipName))), ort, revision: rev, versions: manifest.versions };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
