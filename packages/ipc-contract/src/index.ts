/**
 * NOVA IPC contract — single source of truth for renderer <-> main messages.
 * Channel names: <domain>.<action>.v<N>. Every request and response is validated with zod.
 */
import { z } from 'zod';

export const RelPath = z
  .string()
  .max(4096)
  .refine((p) => !p.includes('\0'), 'NUL not allowed');

export const DirEntry = z.object({
  name: z.string(),
  rel: z.string(),
  kind: z.enum(['file', 'dir']),
});
export type DirEntry = z.infer<typeof DirEntry>;

export const WorkspaceInfo = z.object({ root: z.string(), name: z.string() });
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>;

export const RecentEntry = z.object({ root: z.string(), name: z.string(), openedAt: z.number() });
export type RecentEntry = z.infer<typeof RecentEntry>;

export const Settings = z.object({
  version: z.literal(1).default(1),
  editorFontSize: z.number().int().min(8).max(40).default(14),
  editorTabSize: z.number().int().min(1).max(16).default(2),
  editorWordWrap: z.boolean().default(false),
  editorMinimap: z.boolean().default(true),
  mode: z.enum(['focus', 'nova', 'spectra']).default('nova'),
  sidebarWidth: z.number().int().min(160).max(800).default(260),
  panelHeight: z.number().int().min(80).max(800).default(180),
  javaHome: z.string().max(4096).nullable().default(null),
  colorTheme: z.string().max(256).default('nova-dark'),
  terminalProfile: z.string().max(64).nullable().default(null),
  restoreSession: z.boolean().default(true),
  /** Executable chosen per external language server (set only through the main-process file picker, never by a renderer patch). */
  lspServerPaths: z.record(z.string().max(64), z.string().max(4096)).default({}),
});
export type Settings = z.infer<typeof Settings>;

/** Hot-exit session per workspace: editor layout, per-group view states and unsaved buffers (drafts). */
export const SessionDraft = z.object({ rel: z.string().min(1).max(4096), content: z.string().max(5 * 1024 * 1024), baseMtimeMs: z.number() });
export type SessionDraft = z.infer<typeof SessionDraft>;
export const SessionState = z.object({ layout: z.unknown(), views: z.unknown(), drafts: z.array(SessionDraft).max(100), savedAt: z.number() });
export type SessionState = z.infer<typeof SessionState>;
export const SettingsPatch = Settings.partial().omit({ version: true, lspServerPaths: true });

const ExtId = z.string().max(256).regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/);
export const GitFile = z.object({ path: z.string(), index: z.string(), worktree: z.string() });
export type GitFile = z.infer<typeof GitFile>;
export const GitStatus = z.object({ isRepo: z.boolean(), branch: z.string().nullable(), files: z.array(GitFile) });
export type GitStatus = z.infer<typeof GitStatus>;

export const SearchMatch = z.object({ rel: z.string(), line: z.number(), start: z.number(), end: z.number(), text: z.string() });
export type SearchMatch = z.infer<typeof SearchMatch>;

export interface LspDiagnostic { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string; severity?: number; source?: string; code?: string | number }

/** Events pushed main -> renderer. */
export interface Events {
  'fs.changed.v1': { rels: string[] };
  'search.matches.v1': { searchId: number; matches: SearchMatch[] };
  'search.done.v1': { searchId: number; total: number; truncated: boolean; cancelled: boolean };
  'terminal.data.v1': { ptyId: number; data: string };
  'terminal.exit.v1': { ptyId: number; code: number | null };
  'lsp.status.v1': { servers: ServerStatus[] };
  'lsp.diagnostics.v1': { serverId: string; uri: string; diagnostics: LspDiagnostic[] };
  'lsp.install.v1': { serverId: string; message: string; done?: boolean; error?: boolean };
  'gradle.output.v1': { runId: number; data: string };
  'gradle.exit.v1': { runId: number; code: number | null; signal: string | null; killed: boolean; problems: GradleProblem[] };
  'debug.status.v1': DebugStatus;
  'debug.event.v1': { sessionId: number; event: string; body: Record<string, unknown> };
  'debug.output.v1': { sessionId: number; category: string; output: string };
  'debug.install.v1': { message: string; done?: boolean; error?: boolean };
  'tests.output.v1': { runId: number; data: string };
  'tests.done.v1': { runId: number; code: number | null; killed: boolean; results: TestCase[]; error: string | null; debugPort: number | null };
  'tests.debugReady.v1': { runId: number; port: number };
  'daemon.status.v1': { state: 'starting' | 'ready' | 'restarting' | 'failed'; message?: string };
  'ai.token.v1': { requestId: string; token: string };
  'ai.status.v1': { requestId: string; message: string };
  'ai.done.v1': AiDone;
  'ext.changed.v1': Record<string, never>;
  'ext.host.v1': ExtHostInfo;
  'ext.output.v1': { key: string; extId: string; extName: string; name: string; text: string; show: boolean };
  'ext.status.v1': ExtStatusItem[];
  'ext.message.v1': { extId: string; extName: string; level: string; message: string };
  'ext.treeChanged.v1': { viewId: string };
  'ext.permissionRequest.v1': { requestId: number; extId: string; extName: string; permission: string; description: string };
}
export interface AiProviderInfo { id: string; kind: 'ollama' | 'openai'; label: string; baseUrl: string; model: string; temperature?: number; seed?: number; hasKey: boolean; local: boolean }
export interface AiConfigInfo { enabled: boolean; activeProvider: string; providers: AiProviderInfo[]; timeoutMs: number; idleTimeoutMs: number; retries: number; includeHistory: boolean; keychain: { available: boolean; backend: string; reason: string | null } }
export interface AiPreview {
  id: string; action: string; provider: { id: string; label: string; kind: string; baseUrl: string; model: string; local: boolean };
  messages: { role: string; content: string }[];
  included: { source: string; chars: number; redactions: { kind: string; count: number }[] }[];
  excluded: { rel: string; reason: string; detail: string }[];
}
export interface AiDone { requestId: string; text: string; error: string | null; cancelled: boolean; code: string | null; commands: string[]; model: string; usage: { prompt: number | null; completion: number | null } | null }
export interface AiHistoryEntry { id: string; at: string; role: 'user' | 'assistant'; action: string; content: string; provider: string; model: string; error?: string }
export interface ExtHostInfo { state: string; pid: number | null; startupMs: number | null; error: string | null; crashes: number; logs: string[] }
export interface ExtStatusItem { key: string; extId: string; text: string; tooltip?: string; command?: string; visible: boolean }
export interface ExtInfo {
  id: string; displayName: string; publisher: string; version: string; description: string; license: string | null;
  enabled: boolean; status: 'inactive' | 'activating' | 'active' | 'error' | 'quarantined' | 'disabled' | 'blocked'; quarantined: string | null; previousVersion: string | null;
  sha256: string | null; source: string; installedAt: string; path: string; engines: string; activationEvents: string[]; hasCode: boolean;
  permissions: { id: string; description: string; grant: 'granted' | 'denied' | null }[];
  contributes: Record<string, number>; activationMs: number | null; activatedBy: string | null; lastError: string | null;
  configuration: { key: string; type: string; description?: string; default?: unknown; value: unknown; enum?: unknown[] }[];
}
export interface ExtPreview { token: string; id: string; displayName: string; version: string; publisher: string; description: string; permissions: { id: string; description: string }[]; hasCode: boolean; sha256: string; sidecar: 'match' | 'mismatch' | 'none'; source: string; isUpdate: boolean; fromVersion: string | null; warnings: string[]; files: number; contributes: Record<string, number> }
interface ExtBase { extId: string; extName: string }
export interface ExtContributions {
  commands: (ExtBase & { command: string; title: string; category?: string; palette: boolean })[];
  editorContext: (ExtBase & { command: string; when?: string; title: string })[];
  themes: (ExtBase & { id: string; label: string; uiTheme: string; data: unknown })[];
  languages: (ExtBase & { id: string; aliases: string[]; extensions: string[]; configurationData: unknown })[];
  grammars: (ExtBase & { language: string; format: string; data: unknown })[];
  snippets: (ExtBase & { language: string; data: unknown })[];
  views: (ExtBase & { id: string; name: string; registered: boolean })[];
  tasks: (ExtBase & { id: string; label: string; command: string })[];
  outputChannels: (ExtBase & { name: string })[];
  jsonValidation: (ExtBase & { fileMatch: string[]; schemaPath: string; schema: unknown })[];
  yamlValidation: (ExtBase & { fileMatch: string[]; schemaPath: string; schema: unknown })[];
  gradleRunTasks: (ExtBase & { view: string; plugin: string; label: string; tasks: { name: string; label: string; requiresEula: boolean; runDir: string }[] })[];
  status: ExtStatusItem[];
}
export interface DetectedRunTasks { extId: string; view: string; label: string; plugin: string; buildFile: string; tasks: { name: string; label: string; requiresEula: boolean; runDir: string; eulaAccepted: boolean | null }[] }
export interface TemplateInfo { key: string; extId: string; extName: string; id: string; label: string; description: string; resolver: string }
export interface TemplateResolution { resolver: string; source: 'live' | 'offline-fallback'; note: string; versions: { minecraft: string; javaMajor: number; deps: Record<string, string> }[]; shared: Record<string, string>; errors: string[] }
export interface ExtTreeItem { id?: string; label: string; description?: string; tooltip?: string; collapsible?: boolean; command?: string; element?: unknown }
export type EventName = keyof Events;
export interface GradleProblem { uri: string; line: number; col: number; severity: 'error' | 'warning'; message: string; source: string }

export const ServerStatus = z.object({
  id: z.string(), name: z.string(), version: z.string(), languages: z.array(z.string()), installed: z.boolean(),
  state: z.enum(['stopped', 'starting', 'ready', 'restarting', 'crashed', 'failed', 'blocked']), reason: z.string().nullable(),
  pid: z.number().nullable(), capabilities: z.array(z.string()), limitations: z.string(),
  kind: z.enum(['jvm', 'external']),
  /** jvm servers: NOVA downloads a pinned archive after consent. */
  download: z.object({ url: z.string(), sizeHint: z.string(), license: z.string() }).nullable(),
  /** external servers: resolved executable, where it came from, and how to install it. */
  path: z.string().nullable(), pathSource: z.enum(['configured', 'PATH']).nullable(),
  /** Work-done progress the server reports right now (e.g. "Indexing 45/120"); null when idle. */
  progress: z.string().nullable(),
  setup: z.object({ summary: z.string(), commands: z.array(z.string()), url: z.string(), license: z.string() }).nullable(),
});
export type ServerStatus = z.infer<typeof ServerStatus>;
export const LSP_METHODS = ['textDocument/completion', 'completionItem/resolve', 'textDocument/hover', 'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/references', 'textDocument/prepareRename', 'textDocument/rename', 'textDocument/formatting', 'textDocument/codeAction', 'textDocument/documentSymbol', 'workspace/executeCommand'] as const;
const FileUri = z.string().max(8192).startsWith('file://');

export const LaunchConfig = z.object({
  id: z.string().max(64), name: z.string().min(1).max(200), type: z.enum(['java', 'python']), request: z.enum(['launch', 'attach']),
  mainClass: z.string().max(500).optional(), projectName: z.string().max(200).optional(),
  args: z.string().max(32768).optional(), vmArgs: z.string().max(32768).optional(),
  env: z.record(z.string().max(256), z.string().max(32768)).optional(), cwd: z.string().max(4096).optional(),
  javaHome: z.string().max(4096).nullable().optional(), preLaunchTask: z.string().max(512).optional(),
  hostName: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional(),
  /** python (debugpy): a script relative to the workspace, or a module run with -m (e.g. `pytest`, `app.main`). */
  program: z.string().max(4096).optional(), module: z.string().max(500).regex(/^$|^[A-Za-z_][\w.]*$/).optional(),
  justMyCode: z.boolean().optional(),
});
export type LaunchConfig = z.infer<typeof LaunchConfig>;
export const SourceBreakpoint = z.object({ line: z.number().int().min(1), condition: z.string().max(4096).optional(), logMessage: z.string().max(4096).optional(), hitCondition: z.string().max(256).optional() });
export type SourceBreakpoint = z.infer<typeof SourceBreakpoint>;
export const DebugStatus = z.object({
  sessionId: z.number(), state: z.enum(['idle', 'starting', 'running', 'stopped', 'terminated']), reason: z.string().nullable(),
  threadId: z.number().nullable(), configName: z.string().nullable(), capabilities: z.record(z.string(), z.boolean()),
});
export type DebugStatus = z.infer<typeof DebugStatus>;
export const DAP_COMMANDS = ['threads', 'stackTrace', 'scopes', 'variables', 'continue', 'next', 'stepIn', 'stepOut', 'pause', 'evaluate', 'source', 'setVariable', 'exceptionInfo'] as const;
export const TestFramework = z.enum(['gradle', 'pytest', 'cargo', 'vitest', 'jest']);
export type TestFramework = z.infer<typeof TestFramework>;
export const TestCase = z.object({ id: z.string(), framework: TestFramework, name: z.string(), status: z.enum(['passed', 'failed', 'skipped', 'error']), timeMs: z.number().nullable(), message: z.string().nullable(), stack: z.string().nullable(), stdout: z.string() });
export type TestCase = z.infer<typeof TestCase>;
/** id: the framework's own test name (Gradle `pkg.Class.method`, pytest node id `file::Class::test`, libtest `mod::test`). */
export const TestNode = z.object({ id: z.string(), framework: TestFramework, label: z.string(), className: z.string(), method: z.string().nullable(), rel: z.string(), line: z.number() });
export type TestNode = z.infer<typeof TestNode>;
const VerifiedBp = z.object({ line: z.number(), verified: z.boolean(), message: z.string().optional() });

const def = <Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(req: Req, res: Res) => ({ req, res });

export const channels = {
  'app.info.v1': def(z.object({}), z.object({ version: z.string(), platform: z.string(), electron: z.string() })),
  'daemon.status.v1': def(z.object({}), z.object({ state: z.enum(['starting', 'ready', 'restarting', 'failed']) })),
  'workspace.openDialog.v1': def(z.object({}), WorkspaceInfo.nullable()),
  'workspace.open.v1': def(z.object({ root: z.string().max(4096) }), WorkspaceInfo),
  'workspace.current.v1': def(z.object({}), WorkspaceInfo.nullable()),
  'fs.list.v1': def(z.object({ rel: RelPath }), z.array(DirEntry)),
  'fs.read.v1': def(z.object({ rel: RelPath }), z.object({ content: z.string(), mtimeMs: z.number() })),
  'fs.write.v1': def(
    z.object({ rel: RelPath, content: z.string().max(64 * 1024 * 1024), expectedMtimeMs: z.number().optional() }),
    z.object({ mtimeMs: z.number() }),
  ),
  'fs.saveAs.v1': def(
    z.object({ suggestedRel: RelPath, content: z.string().max(64 * 1024 * 1024) }),
    z.object({ rel: z.string(), mtimeMs: z.number() }).nullable(),
  ),
  'fs.create.v1': def(z.object({ rel: RelPath, kind: z.enum(['file', 'dir']) }), z.object({ rel: z.string() })),
  'fs.rename.v1': def(z.object({ from: RelPath, to: RelPath }), z.object({ rel: z.string() })),
  'fs.delete.v1': def(z.object({ rel: RelPath, permanent: z.boolean().default(false) }), z.object({ trashed: z.boolean() })),
  'fs.stat.v1': def(z.object({ rel: RelPath }), z.object({ mtimeMs: z.number(), kind: z.enum(['file', 'dir']) }).nullable()),
  'search.start.v1': def(
    z.object({ query: z.string().min(1).max(1000), isRegex: z.boolean().default(false), caseSensitive: z.boolean().default(false), maxResults: z.number().int().min(1).max(20000).default(5000) }),
    z.object({ searchId: z.number() }),
  ),
  'session.get.v1': def(z.object({}), SessionState.nullable()),
  'session.save.v1': def(SessionState.extend({ root: z.string(), final: z.boolean().optional() }), z.null()),
  'session.last.v1': def(z.object({}), z.object({ root: z.string() }).nullable()),
  'files.list.v1': def(z.object({}), z.object({ files: z.array(z.string()), truncated: z.boolean() })),
  'search.cancel.v1': def(z.object({ searchId: z.number() }), z.null()),
  'replace.apply.v1': def(
    z.object({ query: z.string().min(1).max(1000), isRegex: z.boolean(), caseSensitive: z.boolean(), replacement: z.string().max(10000), rels: z.array(RelPath).max(5000) }),
    z.object({ files: z.number(), replacements: z.number() }),
  ),
  'terminal.profiles.v1': def(z.object({}), z.object({ profiles: z.array(z.object({ id: z.string(), name: z.string() })), defaultId: z.string().nullable() })),
  'terminal.spawn.v1': def(z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000), profileId: z.string().max(64).optional() }), z.object({ ptyId: z.number(), profileId: z.string().nullable(), profileName: z.string().nullable() })),
  'terminal.write.v1': def(z.object({ ptyId: z.number(), data: z.string().max(1024 * 1024) }), z.null()),
  'terminal.resize.v1': def(z.object({ ptyId: z.number(), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }), z.null()),
  'terminal.kill.v1': def(z.object({ ptyId: z.number() }), z.null()),
  'git.status.v1': def(z.object({}), GitStatus),
  'git.show.v1': def(z.object({ rel: RelPath, rev: z.enum(['HEAD', 'INDEX']) }), z.object({ content: z.string() })),
  'git.stage.v1': def(z.object({ rels: z.array(RelPath).min(1).max(5000) }), z.null()),
  'git.unstage.v1': def(z.object({ rels: z.array(RelPath).min(1).max(5000) }), z.null()),
  'git.branches.v1': def(z.object({}), z.array(z.object({ name: z.string(), current: z.boolean(), remote: z.boolean(), upstream: z.string().nullable() }))),
  'git.createBranch.v1': def(z.object({ name: z.string().min(1).max(250), checkout: z.boolean() }), z.null()),
  'git.switch.v1': def(z.object({ name: z.string().min(1).max(250), allowDirty: z.boolean() }), z.null()),
  'git.discard.v1': def(z.object({ rels: z.array(RelPath).min(1).max(5000) }), z.null()),
  'git.sync.v1': def(z.object({ op: z.enum(['fetch', 'pull', 'push']) }), z.object({ output: z.string() })),
  'git.tracking.v1': def(z.object({}), z.object({ branch: z.string().nullable(), upstream: z.string().nullable(), ahead: z.number(), behind: z.number() })),
  'git.commit.v1': def(z.object({ message: z.string().min(1).max(100000) }), z.object({ commit: z.string() })),
  'trust.get.v1': def(z.object({}), z.object({ trusted: z.boolean() })),
  'trust.set.v1': def(z.object({ trusted: z.boolean() }), z.object({ trusted: z.boolean() })),
  'lsp.status.v1': def(z.object({}), z.array(ServerStatus)),
  'lsp.logs.v1': def(z.object({ serverId: z.string() }), z.array(z.string())),
  'lsp.restart.v1': def(z.object({ serverId: z.string() }), z.null()),
  'lsp.stop.v1': def(z.object({ serverId: z.string() }), z.null()),
  'lsp.install.v1': def(z.object({ serverId: z.string(), consent: z.literal(true) }), z.null()),
  /** Main shows a native file picker (pick=true) or clears the configured path; the renderer never supplies a path. */
  'lsp.setPath.v1': def(z.object({ serverId: z.string().max(64), pick: z.boolean() }), z.object({ path: z.string().nullable() })),
  'lsp.detect.v1': def(z.object({}), z.array(ServerStatus)),
  'lsp.open.v1': def(z.object({ languageId: z.string().max(64), uri: FileUri, version: z.number().int(), text: z.string().max(32 * 1024 * 1024) }), z.null()),
  'lsp.change.v1': def(z.object({ languageId: z.string().max(64), uri: FileUri, version: z.number().int(), changes: z.array(z.object({ range: z.unknown().optional(), text: z.string() })).max(10000) }), z.null()),
  'lsp.save.v1': def(z.object({ languageId: z.string().max(64), uri: FileUri }), z.null()),
  'lsp.close.v1': def(z.object({ languageId: z.string().max(64), uri: FileUri }), z.null()),
  'lsp.request.v1': def(z.object({ languageId: z.string().max(64), reqId: z.string().max(64), method: z.enum(LSP_METHODS), params: z.unknown() }), z.unknown()),
  'lsp.cancel.v1': def(z.object({ reqId: z.string().max(64) }), z.null()),
  'jdk.list.v1': def(z.object({}), z.object({
    jdks: z.array(z.object({ home: z.string(), version: z.string(), major: z.number(), source: z.string() })),
    globalHome: z.string().nullable(), workspaceHome: z.string().nullable(), effective: z.string().nullable(),
  })),
  /** Python interpreters (probed) and the one in effect for this workspace (tests, debugger, Pyright). */
  'python.list.v1': def(z.object({}), z.object({
    interpreters: z.array(z.object({ path: z.string(), version: z.string(), source: z.string() })),
    selected: z.string().nullable(),
    effective: z.object({ command: z.string(), source: z.string(), version: z.string().nullable(), note: z.string().nullable() }),
  })),
  /** path must be one of the interpreters the last python.list.v1 returned (or null = automatic); main re-checks it. */
  'python.select.v1': def(z.object({ path: z.string().max(4096).nullable() }), z.null()),
  /** Native file picker in main; the chosen file must run as Python. */
  'python.pick.v1': def(z.object({}), z.object({ path: z.string().nullable() })),
  'jdk.select.v1': def(z.object({ home: z.string().max(4096).nullable(), scope: z.enum(['global', 'workspace']) }), z.null()),
  'gradle.detect.v1': def(z.object({}), z.object({ isGradle: z.boolean(), wrapper: z.boolean(), buildFile: z.string().nullable() })),
  'gradle.tasks.v1': def(z.object({}), z.array(z.object({ name: z.string(), group: z.string(), description: z.string() }))),
  'gradle.run.v1': def(z.object({ args: z.array(z.string().max(512).regex(/^[^\0\r\n]*$/)).min(1).max(64) }), z.object({ runId: z.number() })),
  'gradle.kill.v1': def(z.object({ runId: z.number() }), z.null()),
  'debug.getConfigs.v1': def(z.object({}), z.array(LaunchConfig)),
  'debug.setConfigs.v1': def(z.object({ configs: z.array(LaunchConfig).max(100) }), z.null()),
  'debug.start.v1': def(z.object({ config: LaunchConfig }), z.object({ sessionId: z.number() })),
  'debug.stop.v1': def(z.object({}), z.null()),
  'debug.status.v1': def(z.object({}), DebugStatus),
  'debug.request.v1': def(z.object({ sessionId: z.number(), command: z.enum(DAP_COMMANDS), args: z.unknown() }), z.unknown()),
  'debug.getBreakpoints.v1': def(z.object({}), z.object({ breakpoints: z.record(z.string(), z.array(SourceBreakpoint)), verified: z.record(z.string(), z.array(VerifiedBp)) })),
  'debug.setBreakpoints.v1': def(z.object({ path: z.string().max(4096), breakpoints: z.array(SourceBreakpoint).max(1000) }), z.array(VerifiedBp).nullable()),
  'debug.adapter.v1': def(z.object({}), z.object({ installed: z.boolean(), name: z.string(), version: z.string(), url: z.string(), sizeHint: z.string(), license: z.string(), sha256: z.string() })),
  'debug.install.v1': def(z.object({ consent: z.literal(true) }), z.null()),
  'tests.discover.v1': def(z.object({}), z.array(TestNode)),
  /** targets: [] = every framework detected in the workspace. Filters are passed as separate argv entries (never a shell); a leading '-' is refused so a filter can't become an option. */
  'tests.run.v1': def(z.object({
    targets: z.array(z.object({ framework: TestFramework, filters: z.array(z.string().min(1).max(1000).regex(/^[^-\s][^\r\n\0]*$/)).max(500) })).max(5),
    debug: z.boolean().optional(),
  }), z.object({ runId: z.number() })),
  'tests.cancel.v1': def(z.object({ runId: z.number() }), z.null()),
  'recent.list.v1': def(z.object({}), z.array(RecentEntry)),
  'ai.getConfig.v1': def(z.object({}), z.custom<AiConfigInfo>()),
  'ai.setConfig.v1': def(z.object({
    enabled: z.boolean().optional(), activeProvider: z.string().max(40).optional(), includeHistory: z.boolean().optional(),
    timeoutMs: z.number().int().optional(), idleTimeoutMs: z.number().int().optional(), retries: z.number().int().optional(),
    providers: z.array(z.object({ id: z.string().max(40), kind: z.enum(['ollama', 'openai']), label: z.string().max(60), baseUrl: z.string().max(500), model: z.string().max(200), temperature: z.number().optional(), seed: z.number().int().optional() })).max(20).optional(),
  }), z.custom<AiConfigInfo>()),
  'ai.setKey.v1': def(z.object({ providerId: z.string().max(40), key: z.string().max(4096).nullable() }), z.null()),
  'ai.listModels.v1': def(z.object({ providerId: z.string().max(40) }), z.array(z.string())),
  'ai.prepare.v1': def(z.object({
    action: z.enum(['chat', 'explainSelection', 'explainError', 'generateTests', 'documentFunction', 'inlineEdit']), prompt: z.string().max(20_000).optional(),
    files: z.array(z.string().max(4096)).max(20).optional(),
    selection: z.object({ rel: z.string().max(4096), text: z.string().max(200_000), startLine: z.number().int(), languageId: z.string().max(64).optional() }).optional(),
    diagnostic: z.object({ rel: z.string().max(4096), line: z.number().int(), col: z.number().int(), severity: z.string().max(20), message: z.string().max(10_000), source: z.string().max(100) }).optional(),
    terminal: z.string().max(100_000).optional(),
  }), z.custom<AiPreview>()),
  'ai.send.v1': def(z.object({ id: z.string().max(64) }), z.object({ requestId: z.string() })),
  'ai.cancel.v1': def(z.object({ requestId: z.string().max(64) }), z.null()),
  'ai.history.v1': def(z.object({}), z.custom<AiHistoryEntry[]>()),
  'ai.clearHistory.v1': def(z.object({}), z.null()),
  'ext.list.v1': def(z.object({}), z.custom<ExtInfo[]>()),
  'ext.contributions.v1': def(z.object({}), z.custom<ExtContributions>()),
  'ext.outputChannels.v1': def(z.object({}), z.custom<{ key: string; extId: string; name: string; text: string }[]>()),
  'ext.hostInfo.v1': def(z.object({}), z.custom<ExtHostInfo>()),
  'ext.logs.v1': def(z.object({ id: ExtId }), z.array(z.string())),
  'ext.pickInstall.v1': def(z.object({ kind: z.enum(['file', 'folder']) }), z.custom<ExtPreview | null>()),
  'ext.install.v1': def(z.object({ token: z.string().max(128) }), z.object({ id: z.string(), version: z.string() })),
  'ext.cancelInstall.v1': def(z.object({ token: z.string().max(128) }), z.null()),
  'ext.setEnabled.v1': def(z.object({ id: ExtId, enabled: z.boolean() }), z.null()),
  'ext.uninstall.v1': def(z.object({ id: ExtId }), z.null()),
  'ext.rollback.v1': def(z.object({ id: ExtId }), z.object({ version: z.string() })),
  'ext.setGrant.v1': def(z.object({ id: ExtId, permission: z.string().max(64), grant: z.enum(['granted', 'denied']).nullable() }), z.null()),
  'ext.setConfig.v1': def(z.object({ id: ExtId, key: z.string().max(128), value: z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]) }), z.null()),
  'ext.executeCommand.v1': def(z.object({ command: z.string().max(256), args: z.array(z.unknown()).max(16).optional() }), z.unknown()),
  'ext.fireEvent.v1': def(z.object({ event: z.string().max(256).regex(/^(onLanguage|onView):[A-Za-z0-9_.-]+$/) }), z.null()),
  'ext.treeChildren.v1': def(z.object({ viewId: z.string().max(128), element: z.unknown().optional() }), z.custom<ExtTreeItem[]>()),
  'ext.permissionAnswer.v1': def(z.object({ requestId: z.number().int(), grant: z.enum(['granted', 'denied']), remember: z.boolean() }), z.null()),
  'ext.restartHost.v1': def(z.object({}), z.null()),
  'gradle.input.v1': def(z.object({ runId: z.number().int(), text: z.string().max(1000).regex(/^[^\0\r]*\n$/) }), z.null()),
  'runtask.detect.v1': def(z.object({}), z.custom<DetectedRunTasks[]>()),
  'runtask.acceptEula.v1': def(z.object({ runDir: z.string().max(512).regex(/^[A-Za-z0-9_.\/-]+$/).refine((p) => !p.split('/').includes('..')) }), z.object({ path: z.string() })),
  'template.list.v1': def(z.object({}), z.custom<TemplateInfo[]>()),
  'template.resolve.v1': def(z.object({ key: z.string().max(300), refresh: z.boolean().optional() }), z.custom<TemplateResolution>()),
  'template.pickLocation.v1': def(z.object({}), z.string().nullable()),
  'template.generate.v1': def(z.object({
    key: z.string().max(300), minecraft: z.string().max(64).nullable(), parentDir: z.string().max(4096), folderName: z.string().max(64), javaHome: z.string().max(4096).nullable(),
    options: z.object({ name: z.string().max(64), modId: z.string().max(64), package: z.string().max(200), author: z.string().max(64), description: z.string().max(200) }),
  }), z.object({ root: z.string(), files: z.array(z.string()), javaMajor: z.number().nullable(), source: z.string() })),
  'settings.get.v1': def(z.object({}), Settings),
  'settings.update.v1': def(SettingsPatch, Settings),
} as const;

export type Channels = typeof channels;
export type ChannelName = keyof Channels;
export type Req<C extends ChannelName> = z.input<Channels[C]['req']>;
export type Res<C extends ChannelName> = z.output<Channels[C]['res']>;

export const ErrorCode = z.enum(['INVALID_REQUEST', 'UNKNOWN_CHANNEL', 'NO_WORKSPACE', 'PATH_OUTSIDE_WORKSPACE', 'NOT_FOUND', 'EXISTS', 'CONFLICT', 'UNTRUSTED', 'DAEMON_UNAVAILABLE', 'TRASH_FAILED', 'LSP_ERROR', 'TOO_LARGE', 'EXT_ERROR', 'AI_ERROR', 'TEMPLATE_ERROR', 'GIT_ERROR', 'GIT_DIRTY', 'INTERNAL']);
export type ErrorCode = z.infer<typeof ErrorCode>;

export type Envelope<T> = { ok: true; result: T } | { ok: false; error: { code: ErrorCode; message: string } };

export const isChannel = (c: unknown): c is ChannelName => typeof c === 'string' && Object.hasOwn(channels, c);

/** The API the preload exposes as window.nova */
export interface NovaApi {
  invoke<C extends ChannelName>(channel: C, req: Req<C>): Promise<Envelope<Res<C>>>;
  onMenu(cb: (command: string) => void): () => void;
  onEvent<E extends EventName>(name: E, cb: (payload: Events[E]) => void): () => void;
}
