/**
 * The list of projects that use the factory, so one dashboard can show them all.
 *
 * Stored at $SOFTWARE_FACTORY_HOME/projects.json, defaulting to
 * ~/.config/software-factory/projects.json. Projects register themselves when
 * the board script runs `init` or `new`; `register` adds one by hand.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export function factoryHome() {
  return process.env.SOFTWARE_FACTORY_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'software-factory');
}

export function registryPath() {
  return join(factoryHome(), 'projects.json');
}

/** Stable short key for a project root (FNV-1a of the absolute path). */
export function projectKey(root) {
  let h = 0x811c9dc5;
  for (const ch of resolve(root)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return `${slug(basename(root))}-${(h >>> 0).toString(36)}`;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

export function readRegistry() {
  try {
    const data = JSON.parse(readFileSync(registryPath(), 'utf8'));
    if (Array.isArray(data.projects)) return data;
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: 1, projects: [] };
}

function writeRegistry(registry) {
  mkdirSync(factoryHome(), { recursive: true });
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmp, registryPath());
}

/** Add a project root (idempotent). Returns its entry. */
export function registerProject(root) {
  const absolute = resolve(root);
  const registry = readRegistry();
  let entry = registry.projects.find((p) => p.root === absolute);
  if (!entry) {
    entry = { key: projectKey(absolute), name: basename(absolute), root: absolute, addedAt: new Date().toISOString() };
    registry.projects.push(entry);
    writeRegistry(registry);
  }
  return entry;
}

export function unregisterProject(root) {
  const absolute = resolve(root);
  const registry = readRegistry();
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => p.root !== absolute);
  if (registry.projects.length !== before) writeRegistry(registry);
  return before !== registry.projects.length;
}

export function projectStatus(entry) {
  return {
    exists: existsSync(entry.root),
    hasProfile: existsSync(join(entry.root, 'factory', 'profile.md')),
  };
}
