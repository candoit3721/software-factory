/**
 * Review previews: the app of one job, running from its worktree, so a human
 * can try it before approving. board.mjs starts and stops them and records
 * them on the job; the dashboard only reads them.
 *
 * A preview is the profile's `preview` command (for example
 * `npm run dev -- --port $FACTORY_PORT`), run detached in its own process
 * group so it outlives the Claude session and can be stopped as a whole.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';

const WINDOWS = process.platform === 'win32';

/** Start `command` in `cwd` on `port`; its output goes to `logPath`. Returns the child's pid. */
export function launchPreview(command, cwd, port, logPath) {
  const log = openSync(logPath, 'w');
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true, // its own process group, so stopping it stops the whole tree
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, FACTORY_PORT: String(port), PORT: String(port) },
  });
  closeSync(log);
  child.unref();
  return child.pid;
}

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive, but owned by someone else
  }
}

/** True when something answers HTTP at the url, whatever the status code. */
export async function answers(url, timeoutMs = 1500) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

/** Wait until the preview answers, its process exits, or the time runs out. */
export async function waitForPreview(pid, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(url)) return { ok: true };
    if (!processAlive(pid)) return { ok: false, reason: 'the preview command exited' };
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return { ok: false, reason: `nothing answered at ${url} within ${Math.round(timeoutMs / 1000)} s` };
}

/** Stop a preview and everything it started. Safe to call when it is already gone. */
export function stopPreview(preview) {
  if (!preview?.pid || !processAlive(preview.pid)) return false;
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { windowsHide: true });
    return true;
  }
  try {
    process.kill(-preview.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(preview.pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}

export function openInBrowser(url) {
  const [cmd, args] = WINDOWS
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // no browser opener (a server, for example): the url is printed anyway
  child.unref();
}

/** The last lines of a log file, for error messages. */
export function tail(path, lines = 20) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
