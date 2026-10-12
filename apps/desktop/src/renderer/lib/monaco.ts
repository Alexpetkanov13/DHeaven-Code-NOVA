import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// Workers are bundled locally by Vite and served from the nova:// origin — no CDN.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('nova-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6B7399', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'B48CFF' },
    { token: 'string', foreground: '7FF0C8' },
    { token: 'number', foreground: 'FFB86B' },
    { token: 'type', foreground: '3FE0FF' },
    { token: 'identifier', foreground: 'E6E9F5' },
  ],
  colors: {
    'editor.background': '#0B0F1E',
    'editor.foreground': '#E6E9F5',
    'editorLineNumber.foreground': '#3A4470',
    'editorLineNumber.activeForeground': '#3FE0FF',
    'editorCursor.foreground': '#3FE0FF',
    'editor.selectionBackground': '#2A1B5C',
    'editor.lineHighlightBackground': '#121834',
    'editorIndentGuide.background1': '#1A2142',
    'minimap.background': '#0B0F1E',
  },
});

export { monaco };

// Read-only diagnostics hook used by E2E tests (marker texts only; exposes no capabilities).
(window as unknown as { __novaMarkers: () => string[] }).__novaMarkers = () => monaco.editor.getModelMarkers({}).map((m) => `${m.resource.path.split('/').pop()}:${m.startLineNumber} [${m.source ?? m.owner}] ${m.message}`);
(window as unknown as { __novaModelText: (suffix: string) => string | null }).__novaModelText = (suffix) => monaco.editor.getModels().find((m) => m.uri.path.endsWith(suffix))?.getValue() ?? null;
