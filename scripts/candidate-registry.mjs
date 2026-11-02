// Isolated test registry: real candidate tarballs, reordered metadata, public dependencies.
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reorder(child)]),
    );
  return value;
}

export async function candidateRegistry(packs, run) {
  const packages = new Map();
  const artifacts = new Map();
  for (const file of readdirSync(packs).filter((name) => name.endsWith('.tgz'))) {
    const path = join(packs, file);
    const pkg = JSON.parse(await run('tar', ['-xOf', path, 'package/package.json']));
    const bytes = readFileSync(path);
    artifacts.set(`/artifacts/${file}`, bytes);
    packages.set(pkg.name, {
      ...pkg,
      dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, file },
    });
  }
  let registry;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    let requestUrl;
    let path;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid registry path');
      requestUrl = new URL(req.url, 'https://registry.npmjs.org');
      if (requestUrl.origin !== 'https://registry.npmjs.org') throw new Error('Invalid registry origin');
      path = decodeURIComponent(requestUrl.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const bytes = artifacts.get(path);
    if (bytes) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
      return;
    }
    const name = path.split('/').slice(1, 3).join('/');
    const pkg = packages.get(name);
    if (pkg) {
      const metadata = reorder({
        ...pkg,
        dist: { integrity: pkg.dist.integrity, tarball: `${registry}/artifacts/${pkg.dist.file}` },
      });
      const body =
        path === `/${name}`
          ? { name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: metadata } }
          : metadata;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    // The origin is constant; request data can affect only path/query components.
    const destination = new URL('https://registry.npmjs.org');
    destination.pathname = requestUrl.pathname;
    destination.search = requestUrl.search;
    res.writeHead(307, { location: destination.href }).end();
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', yes);
  });
  registry = `http://127.0.0.1:${server.address().port}`;
  return {
    registry,
    close: () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  };
}
