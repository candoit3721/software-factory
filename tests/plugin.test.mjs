/**
 * Structure checks for the plugin: skills, agents and the files they reference.
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

function frontMatter(path) {
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8'));
  assert.ok(match, `${path} has front matter`);
  return Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => /^([\w-]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value]),
  );
}

const skills = readdirSync(join(ROOT, 'skills'));
const agents = readdirSync(join(ROOT, 'agents')).map((file) => file.replace(/\.md$/, ''));

describe('plugin structure', () => {
  it('is named "factory", so commands read /factory:<name>', () => {
    assert.equal(manifest.name, 'factory');
  });

  it('has the expected commands', () => {
    assert.deepEqual(skills.sort(), ['approve', 'dashboard', 'discard', 'init', 'new', 'next', 'preview', 'rework', 'status']);
  });

  it('names every skill after its folder and describes it', () => {
    for (const skill of skills) {
      const meta = frontMatter(join(ROOT, 'skills', skill, 'SKILL.md'));
      assert.equal(meta.name, skill);
      assert.ok(meta.description?.length > 40, `${skill} needs a real description`);
    }
  });

  it('lets only the user trigger commands that merge or delete work', () => {
    for (const skill of ['approve', 'discard']) {
      assert.equal(frontMatter(join(ROOT, 'skills', skill, 'SKILL.md'))['disable-model-invocation'], 'true');
    }
  });

  it('references only plugin files that exist', () => {
    const files = [
      ...skills.map((skill) => join(ROOT, 'skills', skill, 'SKILL.md')),
      join(ROOT, 'reference', 'job-loop.md'),
    ];
    for (const file of files) {
      for (const [, rel] of readFileSync(file, 'utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
        assert.ok(existsSync(join(ROOT, rel)), `${file} references missing ${rel}`);
      }
    }
  });

  it('spawns only agents that exist, by their factory: name', () => {
    const loop = readFileSync(join(ROOT, 'reference', 'job-loop.md'), 'utf8');
    for (const [, name] of loop.matchAll(/`factory:([\w-]+)`/g)) assert.ok(agents.includes(name), name);
    for (const agent of agents) assert.equal(frontMatter(join(ROOT, 'agents', `${agent}.md`)).name, agent);
  });

  // docs/ is excluded: INSTALL.md explains how to move from the old name.
  it('never mentions the old /software-factory:factory command', () => {
    const scan = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        ['.git', 'node_modules', 'tests', 'docs'].includes(entry.name)
          ? []
          : entry.isDirectory()
            ? scan(join(dir, entry.name))
            : [join(dir, entry.name)],
      );
    // setup.mjs names the old ids on purpose, to migrate projects away from them.
    for (const file of scan(ROOT).filter((f) => /\.(md|mjs|json|html)$/.test(f) && !f.endsWith('setup.mjs'))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /software-factory:|software-factory@/, file);
    }
  });
});
