import type { AbortController as ScriptingAbortController, AbortSignal as ScriptingAbortSignal } from "scripting";

// Scripting injects these globals without declaring them in the synced SDK.
declare global {
  type AbortController = ScriptingAbortController;
  const AbortController: typeof ScriptingAbortController;
  type AbortSignal = ScriptingAbortSignal;
  const AbortSignal: typeof ScriptingAbortSignal;

  interface URL {
    readonly href: string;
    readonly protocol: string;
    readonly hostname: string;
    readonly host: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
    readonly username: string;
    readonly password: string;
    readonly port: string;
    readonly origin: string;
    readonly searchParams: URLSearchParams;
  }
  const URL: { new (url: string | URL, base?: string | URL): URL };
  interface URLSearchParams {
    get(name: string): string | null;
    getAll(name: string): string[];
  }
  const URLSearchParams: { new (query?: string): URLSearchParams };
}
