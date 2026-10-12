#!/usr/bin/env node
/**
 * One-command install, update and migration of the software factory.
 *
 *   npx -y github:candoit3721/software-factory            # in a project folder
 *   npx -y github:candoit3721/software-factory my-app     # create ./my-app first
 *
 * Options:
 *   --init           open Claude Code with /factory:init afterwards, to tailor the profile
 *   --no-commit      leave the changes uncommitted
 *   --repo <o/r>     install from another GitHub repo (a fork)
 *   --remove         take the factory out of this project (keeps factory/ files and job history)
 *
 * Safe to run again: it updates the plugin and never overwrites factory files you edited.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProject, unregisterProject } from './registry.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The marketplace name Claude Code actually uses is read back after adding it
// (a source registered before under another name keeps that name).
let MARKETPLACE = JSON.parse(readFileSync(join(PACKAGE_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')).name;
let PLUGIN = `factory@${MARKETPLACE}`;
const LEGACY_PLUGINS = ['software-factory@software-factory-local', 'factory@software-factory-local'];
const LEGACY_MARKETPLACES = ['software-factory-local'];
const IGNORE = ['factory/jobs/', 'factory/board.json', 'factory/.board.lock'];

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--repo'));
const repoIndex = argv.indexOf('--repo');
const REPO = repoIndex > -1 ? argv[repoIndex + 1] : 'candoit3721/software-factory';
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--repo');
const unknown = [...flags].filter((f) => !['--init', '--no-commit', '--remove', '--help'].includes(f));

if (flags.has('--help') || unknown.length > 0) {
  if (unknown.length) process.stderr.write(`Unknown option: ${unknown.join(' ')}\n\n`);
  process.stdout.write(
    'Usage: npx -y github:candoit3721/software-factory [folder] [--init] [--no-commit] [--remove] [--repo owner/name]\n',
  );
  process.exit(unknown.length ? 2 : 0);
}

// ----------------------------------------------------------------- output

const step = (text) => process.stdout.write(`  ${text}\n`);
function die(text) {
  process.stderr.write(`\nSetup stopped: ${text}\n`);
  process.exit(1);
}

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) die(`could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) die(`${cmd} ${args.join(' ')} failed:\n${output}`);
  return { ok: result.status === 0, output };
}

// ------------------------------------------------------------------ steps

function checkTools() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) die(`Node.js 22 or later is required (found ${process.versions.node}).`);
  if (!run('git', ['--version'], process.cwd(), { allowFail: true }).ok) die('git is not installed.');
  if (!run('claude', ['--version'], process.cwd(), { allowFail: true }).ok) {
    die('Claude Code is not installed. See https://claude.com/claude-code');
  }
}

function prepareFolder() {
  const root = resolve(positional[0] ?? process.cwd());
  mkdirSync(root, { recursive: true });
  if (!run('git', ['rev-parse', '--is-inside-work-tree'], root, { allowFail: true }).ok) {
    run('git', ['init', '-q', '-b', 'main'], root);
    step('Created a git repository (branch main).');
  }
  return root;
}

/** Remove settings from versions that installed the factory from a local folder. */
function migrateLegacy(root) {
  const path = join(root, '.claude', 'settings.json');
  if (!existsSync(path)) return;
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  const legacy = LEGACY_PLUGINS.filter((id) => id !== PLUGIN && settings.enabledPlugins?.[id] !== undefined);
  const legacyMarkets = LEGACY_MARKETPLACES.filter(
    (name) => name !== MARKETPLACE && settings.extraKnownMarketplaces?.[name],
  );
  if (legacy.length === 0 && legacyMarkets.length === 0) return;
  for (const id of legacy) {
    run('claude', ['plugin', 'uninstall', id, '--scope', 'project'], root, { allowFail: true });
    delete settings.enabledPlugins[id];
  }
  for (const name of legacyMarkets) delete settings.extraKnownMarketplaces[name];
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  step('Removed the old locally-installed factory.');
}

function addMarketplace(root) {
  const add = run('claude', ['plugin', 'marketplace', 'add', REPO, '--scope', 'project', '--json'], root, {
    allowFail: true,
  });
  const line = add.output.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let result = null;
  try {
    result = line ? JSON.parse(line) : null;
  } catch {
    // Fall through to the error below.
  }
  if (!add.ok || !result?.marketplace) die(`could not add the marketplace ${REPO}:\n${add.output}`);
  MARKETPLACE = result.marketplace;
  PLUGIN = `factory@${MARKETPLACE}`;
  run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE], root, { allowFail: true });
}

function installPlugin(root) {

  // Decide from this project's settings, not `plugin list`: the plugin may be
  // installed for the user or another project but not yet enabled here.
  const settingsPath = join(root, '.claude', 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  if (settings.enabledPlugins?.[PLUGIN]) {
    run('claude', ['plugin', 'update', PLUGIN, '--scope', 'project'], root, { allowFail: true });
    step(`Updated ${PLUGIN} to the latest version.`);
  } else {
    run('claude', ['plugin', 'install', PLUGIN, '--scope', 'project'], root);
    step(`Installed ${PLUGIN} for this project.`);
  }
}

/** Copy templates into factory/, never overwriting files that exist. */
function scaffold(root) {
  const created = [];
  const copyTree = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) copyTree(source, target);
      else if (!existsSync(target)) {
        copyFileSync(source, target);
        created.push(target.slice(root.length + 1));
      }
    }
  };
  copyTree(join(PACKAGE_ROOT, 'templates'), join(root, 'factory'));

  const gitignore = join(root, '.gitignore');
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = IGNORE.filter((line) => !current.split('\n').includes(line));
  if (missing.length) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(gitignore, `${prefix}\n# software factory runtime state\n${missing.join('\n')}\n`);
  }
  step(created.length ? `Added ${created.join(', ')}.` : 'Factory files already present; left them as they are.');
}

function commit(root) {
  if (flags.has('--no-commit')) return step('Left the changes uncommitted (--no-commit).');
  const paths = ['factory', '.gitignore', '.claude/settings.json'].filter((p) => existsSync(join(root, p)));
  run('git', ['add', '--', ...paths], root);
  if (run('git', ['diff', '--cached', '--quiet', '--', ...paths], root, { allowFail: true }).ok) {
    return step('Nothing new to commit.');
  }
  const hasCommits = run('git', ['rev-parse', '--verify', 'HEAD'], root, { allowFail: true }).ok;
  const message = hasCommits ? 'chore: install the software factory' : 'chore: initial commit with the software factory';
  run('git', ['commit', '-q', '-m', message, '--', ...paths], root);
  step(`Committed: ${message}.`);
}

// ------------------------------------------------------------------- main

function remove() {
  const root = resolve(positional[0] ?? process.cwd());
  const path = join(root, '.claude', 'settings.json');
  process.stdout.write(`\nRemoving the software factory from ${root}\n\n`);
  run('claude', ['plugin', 'uninstall', PLUGIN, '--scope', 'project'], root, { allowFail: true });
  if (existsSync(path)) {
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    for (const id of [PLUGIN, ...LEGACY_PLUGINS]) delete settings.enabledPlugins?.[id];
    for (const name of [MARKETPLACE, ...LEGACY_MARKETPLACES]) delete settings.extraKnownMarketplaces?.[name];
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
  step('Uninstalled the plugin and removed it from .claude/settings.json.');
  step(unregisterProject(root) ? 'Removed the project from the dashboard.' : 'The project was not on the dashboard.');
  step('Kept factory/ (profile, reviewers, backlog, job history); delete it yourself if you no longer need it.');
  process.stdout.write('\nReview and commit the change to .claude/settings.json.\n\n');
}

if (flags.has('--remove')) {
  checkTools();
  remove();
  process.exit(0);
}

process.stdout.write(`\nSoftware factory setup (${REPO})\n\n`);
checkTools();
const root = prepareFolder();
addMarketplace(root);
migrateLegacy(root);
installPlugin(root);
scaffold(root);
registerProject(root);
step('Added the project to the factory dashboard.');
commit(root);

const tailored = !readFileSync(join(root, 'factory', 'profile.md'), 'utf8').includes('factory:untailored');
process.stdout.write(`\nDone. In ${root}:\n`);
if (!tailored) {
  process.stdout.write('  1. Open Claude Code and run /factory:init to tailor factory/profile.md to this project.\n');
  process.stdout.write('  2. Then /factory:new <request> or /factory:next.\n\n');
} else {
  process.stdout.write('  Run /factory:new <request> or /factory:next in Claude Code.\n\n');
}

if (flags.has('--init') && !tailored) {
  spawnSync('claude', ['/factory:init'], { cwd: root, stdio: 'inherit' });
}
