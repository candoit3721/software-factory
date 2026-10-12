#!/usr/bin/env node
/**
 * One dashboard for every project that uses the factory.
 *
 *   node dashboard.mjs [--port 4700]
 *
 * Projects come from the registry (see registry.mjs). The server is read-only
 * and binds to localhost: it reads each project's factory/board.json and
 * factory/jobs/<id>/*.md|log, nothing else.
 *
 *   GET /                         the dashboard page
 *   GET /api/projects             every project with its jobs
 *   GET /api/jobs/<key>/<job-id>  the files of one job
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectStatus, readRegistry } from './registry.mjs';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'index.html');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : (process.env.FACTORY_DASHBOARD_PORT ?? 4700));

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readJobs(root) {
  try {
    return Object.values(JSON.parse(readFileSync(join(root, 'factory', 'board.json'), 'utf8')).jobs ?? {});
  } catch {
    return [];
  }
}

function projects() {
  return readRegistry().projects.map((entry) => {
    const status = projectStatus(entry);
    return { ...entry, ...status, jobs: status.exists ? readJobs(entry.root) : [] };
  });
}

export function createDashboardServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE));
    }
    if (url.pathname === '/api/projects') {
      return send(res, 200, 'application/json', JSON.stringify({ projects: projects() }));
    }
    const match = /^\/api\/jobs\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
    if (match) {
      const project = readRegistry().projects.find((p) => p.key === match[1]);
      const dir = project && join(project.root, 'factory', 'jobs', match[2]);
      if (!dir || !existsSync(dir)) return send(res, 404, 'application/json', '{"error":"no such job"}');
      const files = readdirSync(dir)
        .filter((name) => /\.(md|log)$/.test(name))
        .map((name) => ({
          name,
          modified: statSync(join(dir, name)).mtimeMs,
          content: readFileSync(join(dir, name), 'utf8').slice(-200_000),
        }))
        .sort((a, b) => a.modified - b.modified);
      return send(res, 200, 'application/json', JSON.stringify({ files }));
    }
    send(res, 404, 'text/plain', 'Not found');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createDashboardServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      process.stdout.write(`A dashboard is already running: http://localhost:${PORT}\n`);
      process.exit(0);
    }
    throw error;
  });
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Factory dashboard (all projects): http://localhost:${PORT}\n`);
  });
}
