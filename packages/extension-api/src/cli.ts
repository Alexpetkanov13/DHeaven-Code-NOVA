import fs from 'node:fs/promises';
import path from 'node:path';
import { readArchive, packFiles } from './archive';
import { readFolder } from './fsutil';
import { MANIFEST_FILE, validateManifest } from './manifest';

const usage = `nova-ext — DHeaven Code: NOVA extension tool
  nova-ext validate <folder|file.novaext>   validate manifest, referenced files, archive integrity
  nova-ext pack <folder> [-o out.novaext]    validate and write <publisher>.<name>-<version>.novaext + .sha256`;

async function main(argv: string[]) {
  const [cmd, target, ...rest] = argv;
  if (!cmd || !target || cmd === '-h' || cmd === '--help') { console.log(usage); return cmd ? 0 : 1; }
  if (cmd === 'validate') {
    if (target.endsWith('.novaext')) {
      const r = readArchive(await fs.readFile(target));
      for (const w of r.warnings) console.log(`warning: ${w}`);
      console.log(`OK ${r.manifest.publisher}.${r.manifest.name}@${r.manifest.version} — ${r.files.size} files, sha256 ${r.archiveSha256}`);
      return 0;
    }
    const files = await readFolder(target);
    const raw = files.get(MANIFEST_FILE); if (!raw) throw new Error(`missing ${MANIFEST_FILE}`);
    const v = validateManifest(JSON.parse(new TextDecoder().decode(raw)));
    if (!v.ok) { for (const e of v.errors) console.error(`error: ${e}`); return 1; }
    packFiles(files); // also checks referenced files
    for (const w of v.warnings) console.log(`warning: ${w}`);
    console.log(`OK ${v.manifest.publisher}.${v.manifest.name}@${v.manifest.version}`);
    return 0;
  }
  if (cmd === 'pack') {
    const files = await readFolder(target);
    const { data, manifest, sha256 } = packFiles(files);
    const oi = rest.indexOf('-o');
    const out = oi >= 0 && rest[oi + 1] ? rest[oi + 1]! : path.join(process.cwd(), `${manifest.publisher}.${manifest.name}-${manifest.version}.novaext`);
    await fs.writeFile(out, data);
    await fs.writeFile(`${out}.sha256`, `${sha256}  ${path.basename(out)}\n`);
    console.log(`Packed ${out} (${files.size} files, ${data.length} bytes)\nsha256 ${sha256}`);
    return 0;
  }
  console.error(usage); return 1;
}
main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`error: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
