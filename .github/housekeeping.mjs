// Creates the version tags and GitHub Releases listed in housekeeping.json
// (files taken from the repo history at each version's commit) and deletes
// old branches. Safe to run again: anything that already exists is skipped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt }).trim();
const ok = (cmd, args) => { try { sh(cmd, args); return true; } catch { return false; } };
const cfg = JSON.parse(fs.readFileSync('.github/housekeeping.json', 'utf8'));
for (const b of cfg.deleteBranches || []) {
  console.log(ok('git', ['push', 'origin', '--delete', b]) ? `deleted branch ${b}` : `branch ${b} already gone`);
}
for (const r of cfg.releases) {
  if (cfg.moveTags && ok('git', ['rev-parse', `refs/tags/${r.tag}`])) {
    // History was re-signed: point the existing tag at the new commit
    const want = sh('git', ['rev-parse', `${r.commit}^{commit}`]);
    if (sh('git', ['rev-parse', `refs/tags/${r.tag}^{commit}`]) !== want) {
      sh('git', ['tag', '-f', r.tag, want]);
      sh('git', ['push', '-f', 'origin', `refs/tags/${r.tag}`]);
      console.log(`${r.tag}: moved to ${want.slice(0, 7)}`);
    }
  }
  if (ok('gh', ['release', 'view', r.tag])) {
    // Keep notes and the "latest" flag in step with the files in this repo
    if (cfg.updateNotes) sh('gh', ['release', 'edit', r.tag, '--notes-file', `.github/release-notes/${r.tag}.md`, `--latest=${r.latest ? 'true' : 'false'}`]);
    console.log(`${r.tag}: release exists${cfg.updateNotes ? ', notes updated' : ''}`);
    continue;
  }
  const sha = sh('git', ['rev-parse', `${r.commit}^{commit}`]);
  if (!ok('git', ['rev-parse', `refs/tags/${r.tag}`])) {
    sh('git', ['tag', r.tag, sha]);
    sh('git', ['push', 'origin', `refs/tags/${r.tag}`]);
  }
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'rel-'));
  const files = sh('git', ['ls-tree', '-r', '--name-only', sha, '--', r.files]).split('\n').filter(Boolean);
  const out = files.map(f => {
    const dest = path.join(dir, path.basename(f));
    fs.writeFileSync(dest, execFileSync('git', ['show', `${sha}:${f}`], { maxBuffer: 1 << 30 }));
    return dest;
  });
  const v = r.tag.replace(/^v/, '').replace(/\.0$/, '');
  sh('gh', ['release', 'create', r.tag, ...out, '--verify-tag', '--title', `Cognitive Terrain ${v}`,
    '--notes-file', `.github/release-notes/${r.tag}.md`, `--latest=${r.latest ? 'true' : 'false'}`]);
  console.log(`${r.tag}: released with ${out.length} files`);
}
