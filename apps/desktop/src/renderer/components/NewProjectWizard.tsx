import { useEffect, useMemo, useState } from 'react';
import type { TemplateInfo, TemplateResolution } from '@nova/ipc-contract';
import { call } from '../lib/ipc';

interface Jdk { home: string; version: string; major: number; source: string }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^[^a-z]+/, '').slice(0, 64);

/** Core, template-agnostic New Project wizard. Templates come from extensions; versions from core resolvers. */
export function NewProjectWizard({ onClose, onCreated }: { onClose(): void; onCreated(root: string, open: boolean): void }) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [key, setKey] = useState('');
  const [res, setRes] = useState<TemplateResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [mc, setMc] = useState('');
  const [jdks, setJdks] = useState<Jdk[]>([]);
  const [jdk, setJdk] = useState('');
  const [name, setName] = useState('My Project');
  const [modId, setModId] = useState(''); const [modIdTouched, setModIdTouched] = useState(false);
  const [pkg, setPkg] = useState(''); const [pkgTouched, setPkgTouched] = useState(false);
  const [author, setAuthor] = useState('Me');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ root: string; files: string[]; source: string } | null>(null);

  useEffect(() => {
    void call('template.list.v1', {}).then((t) => { setTemplates(t); if (t[0]) setKey(t[0].key); }).catch((e) => setError(String(e?.message ?? e)));
    void call('jdk.list.v1', {}).then((j) => setJdks(j.jdks)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!key) return;
    setRes(null); setResolving(true); setError(null);
    void call('template.resolve.v1', { key }).then((r) => { setRes(r); setMc(r.versions[0]?.minecraft ?? ''); }).catch((e) => setError(String(e?.message ?? e))).finally(() => setResolving(false));
  }, [key]);
  const effModId = modIdTouched ? modId : slug(name);
  const effPkg = pkgTouched ? pkg : `com.example.${effModId.replace(/-/g, '_') || 'project'}`;
  const version = res?.versions.find((v) => v.minecraft === mc) ?? null;
  const javaReq = version?.javaMajor ?? null;
  const okJdks = useMemo(() => jdks.filter((j) => javaReq === null || j.major >= javaReq), [jdks, javaReq]);
  useEffect(() => { if (!okJdks.some((j) => j.home === jdk)) setJdk(okJdks[0]?.home ?? ''); }, [okJdks, jdk]);
  const tpl = templates?.find((t) => t.key === key);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await call('template.generate.v1', { key, minecraft: version?.minecraft ?? null, parentDir: location, folderName: effModId, javaHome: jdk || null, options: { name, modId: effModId, package: effPkg, author, description } });
      setDone(r);
    } catch (e) { setError(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };

  return (
    <div className="palette-backdrop">
      <div className="palette confirm wizard" role="dialog" aria-label="New Project">
        <h3>New Project</h3>
        {done ? (
          <div aria-label="Project created">
            <p>Created <b data-testid="created-root">{done.root}</b> ({done.files.length} files{done.source === 'offline-fallback' ? ', offline fallback versions' : ''}).</p>
            <div className="row-btns"><button className="btn" onClick={() => onCreated(done.root, false)}>Close</button><button className="btn primary" autoFocus onClick={() => onCreated(done.root, true)}>Open Project</button></div>
          </div>
        ) : (<>
          {templates && !templates.length && <p className="small">No project templates are installed. Templates are contributed by extensions (e.g. the bundled Minecraft Developer Pack — check it is enabled).</p>}
          <div className="wizard-templates" role="radiogroup" aria-label="Template">
            {templates?.map((t) => (
              <label key={t.key} className={`wizard-template ${t.key === key ? 'sel' : ''}`}>
                <input type="radio" name="tpl" checked={t.key === key} onChange={() => setKey(t.key)} /> <b>{t.label}</b>
                <div className="small">{t.description} <i>({t.extName})</i></div>
              </label>
            ))}
          </div>
          {tpl && tpl.resolver !== 'none' && (
            <div className="wizard-grid">
              <label>Minecraft version
                <select aria-label="Minecraft version" value={mc} onChange={(e) => setMc(e.target.value)} disabled={resolving || !res}>
                  {res?.versions.map((v) => <option key={v.minecraft} value={v.minecraft}>{v.minecraft} (Java {v.javaMajor}+)</option>)}
                </select>
              </label>
              <label>JDK
                <select aria-label="JDK" value={jdk} onChange={(e) => setJdk(e.target.value)}>
                  {okJdks.map((j) => <option key={j.home} value={j.home}>JDK {j.major} — {j.home}</option>)}
                  {!okJdks.length && <option value="">No JDK {javaReq}+ found (project still created)</option>}
                </select>
              </label>
              <div className="small wizard-source" data-testid="version-source" data-source={res?.source ?? ''} data-resolver={res?.resolver ?? ''}>
                {resolving ? 'Resolving current versions from official sources…' : res ? <>
                  <span className={`badge ${res.source === 'live' ? 'ok' : 'warn'}`}>{res.source === 'live' ? 'live' : 'OFFLINE FALLBACK (pinned)'}</span> {res.note}
                  {version && <div>{Object.entries({ ...res.shared, ...version.deps }).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
                  {res.errors.length > 0 && <div>Why: {res.errors.join('; ')}</div>}
                  {jdks.some((j) => javaReq !== null && j.major < javaReq) && <div>JDKs older than Java {javaReq} are hidden: Minecraft {mc} requires Java {javaReq}.</div>}
                </> : null}
                {res && <button className="btn link" onClick={() => { setResolving(true); void call('template.resolve.v1', { key, refresh: true }).then((r) => { setRes(r); setMc(r.versions[0]?.minecraft ?? ''); }).finally(() => setResolving(false)); }}>Refresh</button>}
              </div>
            </div>
          )}
          <div className="wizard-grid">
            <label>Name<input aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Mod / plugin id<input aria-label="Mod id" value={effModId} onChange={(e) => { setModIdTouched(true); setModId(e.target.value); }} /></label>
            <label>Java package<input aria-label="Java package" value={effPkg} onChange={(e) => { setPkgTouched(true); setPkg(e.target.value); }} /></label>
            <label>Author<input aria-label="Author" value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
            <label className="wide">Description<input aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
            <label className="wide">Location
              <span className="wiz-row"><input aria-label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="/path/to/parent folder" />
                <button className="btn" onClick={() => void call('template.pickLocation.v1', {}).then((p) => p && setLocation(p))}>Browse…</button></span>
              {location && <span className="small">Creates {location.replace(/[\\/]+$/, '')}/{effModId}</span>}
            </label>
          </div>
          {error && <div className="wizard-error" role="alert">{error}</div>}
          <div className="row-btns">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !key || !location || resolving} onClick={() => void create()}>{busy ? 'Creating…' : 'Create'}</button>
          </div>
        </>)}
      </div>
    </div>
  );
}
