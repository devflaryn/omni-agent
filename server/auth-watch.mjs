/**
 * OpenCode's login store (`opencode auth login` / `logout`, its TUI's /connect) is read by a running `opencode serve`
 * only when its instances start: a login made outside Omni leaves the server answering "Model not found" for the new
 * provider's models while its catalog already lists them. Omni watches the file and reloads OpenCode on a change.
 */
import { unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** OpenCode's auth.json: its data dir is XDG_DATA_HOME (else ~/.local/share, on Windows too) + /opencode. */
export function opencodeAuthFile(env = process.env, home = homedir()) {
  const xdg = String(env.XDG_DATA_HOME || "").trim();
  return join(xdg || join(home, ".local", "share"), "opencode", "auth.json");
}

/**
 * Calls `onChange` after `file` was written, created or removed; a burst of writes is one call. Polls (fs.watchFile):
 * a rename-into-place save, as OpenCode's, is seen where fs.watch on Windows misses it. `stop()` ends the watch.
 */
export function watchAuthStore(file, onChange, { interval = 2000, debounceMs = 500 } = {}) {
  let timer = null;
  const listener = (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
  };
  watchFile(file, { interval, persistent: false }, listener);
  return { stop() { clearTimeout(timer); unwatchFile(file, listener); } };
}
