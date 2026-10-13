import * as monaco from 'monaco-editor';
import { Adapter } from 'monaco-editor/languages/features/typescript/tsMode.js';

/**
 * Lets NOVA switch Monaco's bundled TypeScript worker off while typescript-language-server serves TS/JS, and on again
 * when it stops. Monaco registers the worker's providers once (setModeConfiguration after setup has no effect), so each
 * built-in provider (an instance of the TS mode's Adapter class) is wrapped at registration time; while the gate is
 * closed its provideX/resolveX methods return nothing. Other providers for TS/JS (NOVA's LSP bridge, extension
 * snippets) are not touched. Must be imported before the first TS/JS model is created (monaco.ts does).
 */
let builtinOn = true;
const LANGS = new Set(['typescript', 'javascript']);
type Selector = string | { language?: string } | (string | { language?: string })[];
const hits = (s: Selector): boolean => (Array.isArray(s) ? s.some(hits) : typeof s === 'string' ? LANGS.has(s) : !!s?.language && LANGS.has(s.language));

function gate<T extends object>(provider: T): T {
  return new Proxy(provider, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver) as unknown;
      if (typeof v === 'function' && typeof key === 'string' && /^(provide|resolve)/.test(key)) {
        return (...args: unknown[]) => (builtinOn ? (v as (...a: unknown[]) => unknown).apply(target, args) : undefined);
      }
      return v;
    },
  });
}

const L = monaco.languages as unknown as Record<string, unknown>;
for (const key of Object.keys(L)) {
  if (!/^register\w*Provider$/.test(key) || typeof L[key] !== 'function') continue;
  const orig = L[key] as (sel: Selector, provider: object, ...rest: unknown[]) => monaco.IDisposable;
  L[key] = (sel: Selector, provider: object, ...rest: unknown[]) =>
    orig(sel, provider instanceof Adapter && hits(sel) ? gate(provider) : provider, ...rest);
}

let savedDiagnostics: { ts: monaco.typescript.DiagnosticsOptions; js: monaco.typescript.DiagnosticsOptions } | null = null;
/** Opens/closes the gate. Diagnostics use the worker's own options: changing them re-validates and clears its markers. */
export function setBuiltinTypeScript(on: boolean) {
  if (on === builtinOn) return;
  builtinOn = on;
  const ts = monaco.typescript.typescriptDefaults, js = monaco.typescript.javascriptDefaults;
  if (!on) {
    savedDiagnostics = { ts: ts.getDiagnosticsOptions(), js: js.getDiagnosticsOptions() };
    const off = { noSyntaxValidation: true, noSemanticValidation: true, noSuggestionDiagnostics: true };
    ts.setDiagnosticsOptions({ ...savedDiagnostics.ts, ...off });
    js.setDiagnosticsOptions({ ...savedDiagnostics.js, ...off });
  } else if (savedDiagnostics) {
    ts.setDiagnosticsOptions(savedDiagnostics.ts);
    js.setDiagnosticsOptions(savedDiagnostics.js);
    savedDiagnostics = null;
  }
}
export const builtinTypeScriptOn = () => builtinOn;
