/**
 * NOVA Extension API v1. Extensions are CommonJS modules exporting `activate(nova, context)` and optionally `deactivate()`.
 * The `nova` object is passed in (there is no `require('nova')`). Every call that leaves the extension host is
 * capability-checked by NOVA's main process; calls needing a permission prompt the user the first time.
 */
export const API_VERSION = '1.0.0';

export interface Disposable { dispose(): void }
export type Thenable<T> = Promise<T>;

export interface OutputChannel extends Disposable {
  readonly name: string;
  append(text: string): void;
  appendLine(text: string): void;
  clear(): void;
  /** Reveals the channel in the Output panel. */
  show(): void;
}
export interface StatusBarItem extends Disposable {
  text: string; tooltip?: string; command?: string;
  show(): void; hide(): void;
}
export interface TreeItem { id?: string; label: string; description?: string; tooltip?: string; collapsible?: boolean; command?: string; commandArgs?: unknown[] }
export interface TreeDataProvider<T extends TreeItem = TreeItem> { getChildren(element?: T): T[] | Promise<T[]> }
export interface TreeView extends Disposable { refresh(): void }

export interface FetchResponse { status: number; ok: boolean; headers: Record<string, string>; text: string }
export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface NovaApi {
  readonly version: string;
  readonly commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable;
    executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  };
  readonly window: {
    showInformationMessage(message: string): Promise<void>;
    showWarningMessage(message: string): Promise<void>;
    showErrorMessage(message: string): Promise<void>;
    createOutputChannel(name: string): OutputChannel;
    createStatusBarItem(): StatusBarItem;
    registerTreeDataProvider(viewId: string, provider: TreeDataProvider): TreeView;
  };
  readonly workspace: {
    /** Values from `contributes.configuration`, with user overrides. */
    getConfiguration(): { get<T = unknown>(key: string): T | undefined };
    /** Needs permission `workspace.read`. Paths are workspace-relative. */
    readFile(rel: string): Promise<string>;
    listDir(rel: string): Promise<{ name: string; kind: 'file' | 'dir' }[]>;
    /** Needs permission `workspace.write`. */
    writeFile(rel: string, content: string): Promise<void>;
  };
  /** Needs permission `network`. http(s) only; response body capped at 5 MB. */
  readonly net: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> };
  /** Needs permission `process`. Runs a program (no shell) in the workspace root; 60 s timeout. */
  readonly process: { exec(command: string, args: string[]): Promise<ExecResult> };
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly subscriptions: Disposable[];
  /** Small persisted key/value store (JSON values), per extension. */
  readonly globalState: { get<T = unknown>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> };
}

export interface ExtensionModule {
  activate?(nova: NovaApi, context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
