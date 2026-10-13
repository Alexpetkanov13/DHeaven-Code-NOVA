import { useEffect, useState } from 'react';
import { call } from '../lib/ipc';

/** Status-bar branch + ahead/behind of the upstream (trusted workspaces only; refreshed on SCM changes and every 15 s). */
export function GitTrackingItem({ refreshKey }: { refreshKey: number }) {
  const [t, setT] = useState<{ branch: string | null; upstream: string | null; ahead: number; behind: number } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void call('git.tracking.v1', {}).then((r) => { if (live) setT(r); }, () => { if (live) setT(null); });
    load();
    const iv = setInterval(load, 15_000);
    window.addEventListener('nova-git-changed', load);
    return () => { live = false; clearInterval(iv); window.removeEventListener('nova-git-changed', load); };
  }, [refreshKey]);
  if (!t?.branch) return null;
  return (
    <span aria-label="Git branch status" title={t.upstream ? `Tracking ${t.upstream}` : 'No upstream'}>
      ⎇ {t.branch}{t.upstream ? ` ↑${t.ahead} ↓${t.behind}` : ''}
    </span>
  );
}
