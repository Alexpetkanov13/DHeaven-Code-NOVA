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

const def = <Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(req: Req, res: Res) => ({ req, res });

export const channels = {
  'app.info.v1': def(z.object({}), z.object({ version: z.string(), platform: z.string(), electron: z.string() })),
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
  'recent.list.v1': def(z.object({}), z.array(RecentEntry)),
  'settings.get.v1': def(z.object({}), Settings),
  'settings.update.v1': def(SettingsPatch, Settings),
} as const;

export type Channels = typeof channels;
export type ChannelName = keyof Channels;
export type Req<C extends ChannelName> = z.input<Channels[C]['req']>;
export type Res<C extends ChannelName> = z.output<Channels[C]['res']>;

export const ErrorCode = z.enum(['INVALID_REQUEST', 'UNKNOWN_CHANNEL', 'NO_WORKSPACE', 'PATH_OUTSIDE_WORKSPACE', 'NOT_FOUND', 'CONFLICT', 'TOO_LARGE', 'INTERNAL']);
export type ErrorCode = z.infer<typeof ErrorCode>;

export type Envelope<T> = { ok: true; result: T } | { ok: false; error: { code: ErrorCode; message: string } };

export const isChannel = (c: unknown): c is ChannelName => typeof c === 'string' && Object.hasOwn(channels, c);

/** The API the preload exposes as window.nova */
export interface NovaApi {
  invoke<C extends ChannelName>(channel: C, req: Req<C>): Promise<Envelope<Res<C>>>;
  onMenu(cb: (command: string) => void): () => void;
}
