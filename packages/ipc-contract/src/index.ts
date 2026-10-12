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
});
export type Settings = z.infer<typeof Settings>;
export const SettingsPatch = Settings.partial().omit({ version: true });

export const GitFile = z.object({ path: z.string(), index: z.string(), worktree: z.string() });
export type GitFile = z.infer<typeof GitFile>;
export const GitStatus = z.object({ isRepo: z.boolean(), branch: z.string().nullable(), files: z.array(GitFile) });
export type GitStatus = z.infer<typeof GitStatus>;

export const SearchMatch = z.object({ rel: z.string(), line: z.number(), start: z.number(), end: z.number(), text: z.string() });
export type SearchMatch = z.infer<typeof SearchMatch>;

/** Events pushed main -> renderer. */
export interface Events {
  'fs.changed.v1': { rels: string[] };
  'search.matches.v1': { searchId: number; matches: SearchMatch[] };
  'search.done.v1': { searchId: number; total: number; truncated: boolean; cancelled: boolean };
  'terminal.data.v1': { ptyId: number; data: string };
  'terminal.exit.v1': { ptyId: number; code: number | null };
  'daemon.status.v1': { state: 'starting' | 'ready' | 'restarting' | 'failed'; message?: string };
}
export type EventName = keyof Events;

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
  'search.cancel.v1': def(z.object({ searchId: z.number() }), z.null()),
  'replace.apply.v1': def(
    z.object({ query: z.string().min(1).max(1000), isRegex: z.boolean(), caseSensitive: z.boolean(), replacement: z.string().max(10000), rels: z.array(RelPath).max(5000) }),
    z.object({ files: z.number(), replacements: z.number() }),
  ),
  'terminal.spawn.v1': def(z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }), z.object({ ptyId: z.number() })),
  'terminal.write.v1': def(z.object({ ptyId: z.number(), data: z.string().max(1024 * 1024) }), z.null()),
  'terminal.resize.v1': def(z.object({ ptyId: z.number(), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }), z.null()),
  'terminal.kill.v1': def(z.object({ ptyId: z.number() }), z.null()),
  'git.status.v1': def(z.object({}), GitStatus),
  'git.show.v1': def(z.object({ rel: RelPath, rev: z.enum(['HEAD', 'INDEX']) }), z.object({ content: z.string() })),
  'git.stage.v1': def(z.object({ rels: z.array(RelPath).min(1).max(5000) }), z.null()),
  'git.unstage.v1': def(z.object({ rels: z.array(RelPath).min(1).max(5000) }), z.null()),
  'git.commit.v1': def(z.object({ message: z.string().min(1).max(100000) }), z.object({ commit: z.string() })),
  'trust.get.v1': def(z.object({}), z.object({ trusted: z.boolean() })),
  'trust.set.v1': def(z.object({ trusted: z.boolean() }), z.object({ trusted: z.boolean() })),
  'recent.list.v1': def(z.object({}), z.array(RecentEntry)),
  'settings.get.v1': def(z.object({}), Settings),
  'settings.update.v1': def(SettingsPatch, Settings),
} as const;

export type Channels = typeof channels;
export type ChannelName = keyof Channels;
export type Req<C extends ChannelName> = z.input<Channels[C]['req']>;
export type Res<C extends ChannelName> = z.output<Channels[C]['res']>;

export const ErrorCode = z.enum(['INVALID_REQUEST', 'UNKNOWN_CHANNEL', 'NO_WORKSPACE', 'PATH_OUTSIDE_WORKSPACE', 'NOT_FOUND', 'EXISTS', 'CONFLICT', 'UNTRUSTED', 'DAEMON_UNAVAILABLE', 'TRASH_FAILED', 'TOO_LARGE', 'INTERNAL']);
export type ErrorCode = z.infer<typeof ErrorCode>;

export type Envelope<T> = { ok: true; result: T } | { ok: false; error: { code: ErrorCode; message: string } };

export const isChannel = (c: unknown): c is ChannelName => typeof c === 'string' && Object.hasOwn(channels, c);

/** The API the preload exposes as window.nova */
export interface NovaApi {
  invoke<C extends ChannelName>(channel: C, req: Req<C>): Promise<Envelope<Res<C>>>;
  onMenu(cb: (command: string) => void): () => void;
  onEvent<E extends EventName>(name: E, cb: (payload: Events[E]) => void): () => void;
}
