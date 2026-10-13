// Verifies Windows release artifacts: NSIS setup, portable exe, zip (containing the app exe + novad.exe).
// Writes SHA256SUMS.txt next to them. Usage: node scripts/verify-artifacts.mjs <release dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';

const dir = path.resolve(process.argv[2] ?? 'apps/desktop/release');
const files = fs.readdirSync(dir).filter((f) => /^DHeaven-Code-NOVA-.*\.(exe|zip)$/.test(f));
const need = { setup: /-setup-x64\.exe$/, portable: /-portable-x64\.exe$/, zip: /-win-x64\.zip$/ };
const errs = [];
for (const [k, re] of Object.entries(need)) if (!files.some((f) => re.test(f))) errs.push(`missing ${k} artifact (${re})`);
const zip = files.find((f) => need.zip.test(f));
if (zip) {
  const names = Object.keys(unzipSync(fs.readFileSync(path.join(dir, zip)), { filter: (f) => /\.exe$/i.test(f.name) }));
  console.log(`exe entries in ${zip}:`, names);
  if (!names.some((n) => /(^|\/)dheaven-code-nova\.exe$/i.test(n))) errs.push('zip lacks dheaven-code-nova.exe');
  if (!names.some((n) => /(^|\/)resources\/novad\.exe$/i.test(n))) errs.push('zip lacks resources/novad.exe');
}
const sums = files.sort().map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
for (const f of files) console.log(`${f}  ${(fs.statSync(path.join(dir, f)).size / 1e6).toFixed(1)} MB`);
console.log(sums.join('\n'));
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log('artifacts OK');
