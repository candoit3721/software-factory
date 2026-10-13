/**
 * A project's backlog: factory/backlog.md, one Markdown task line per item.
 *
 *   - [ ] open item
 *   - [x] done item (001-job-id)
 *
 * board.mjs hands out and checks off items; the dashboard shows the open ones.
 * Both read the file here, so they always agree on what is open.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stages in which a job is still working on its backlog item. */
export const ACTIVE = new Set(['spec', 'build', 'review', 'approve', 'needs-human']);

export const backlogPath = (root) => join(root, 'factory', 'backlog.md');

/** Every task line of a backlog file, in order. */
export function backlogItems(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^\s*- \[( |x)\] (.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ done: match[1] === 'x', text: match[2].trim() }));
}

/** Open items that no active job has claimed yet, in the order `next` hands them out. */
export function unclaimedItems(file, jobs) {
  const claimed = new Set(jobs.filter((job) => ACTIVE.has(job.stage) && job.backlog).map((job) => job.backlog));
  return backlogItems(file).filter((item) => !item.done && !claimed.has(item.text));
}

/** Marks an open item done, noting the job that did it. Returns whether the item was found. */
export function checkOffBacklog(file, text, jobId) {
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.trim() === `- [ ] ${text}`);
  if (index === -1) return false;
  lines[index] = lines[index].replace('- [ ]', '- [x]') + ` (${jobId})`;
  writeFileSync(file, lines.join('\n'));
  return true;
}
