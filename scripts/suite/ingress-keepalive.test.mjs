// Static guard for the upstream keep-alive limit (scripts/suite/ingress-keepalive.mjs proves it
// against the real ingress image). Every reverse_proxy in deployment/Caddyfile, and every one
// hive.sh migrate-native renders, must use a transport whose idle connections close before a
// Node backend's 5-second keep-alive timeout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const caddyfile = readFileSync(join(root, 'deployment/Caddyfile'), 'utf8');
const BACKEND_KEEPALIVE_SECONDS = 5;

// The block that opens at the brace at or after start (or exactly at open, when given).
function block(text, start, open = text.indexOf('{', start)) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error('Unbalanced block at ' + start);
}
const snippets = Object.fromEntries([...caddyfile.matchAll(/^\(([a-z_]+)\) \{$/gm)].map((match) => [match[1], block(caddyfile, match.index)]));
const imports = (text) => [...text.matchAll(/^\s*import ([a-z_]+)\b/gm)].map((match) => match[1]).filter((name) => snippets[name]);
function idleSeconds(text, seen = new Set()) {
  const transport = text.search(/^\s*transport http \{$/m);
  if (transport >= 0) {
    const own = /^\s*keepalive (\d+)s$/m.exec(block(text, transport));
    return own ? Number(own[1]) : null;
  }
  for (const name of imports(text)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const value = idleSeconds(snippets[name], seen);
    if (value !== null) return value;
  }
  return null;
}

test('the upstream snippets keep idle connections for less than a backend keep-alive timeout', () => {
  for (const name of ['verified_backend', 'plain_backend']) {
    const seconds = idleSeconds(snippets[name] ?? '');
    assert(seconds !== null && seconds > 0 && seconds < BACKEND_KEEPALIVE_SECONDS, name + ' must set keepalive below ' + BACKEND_KEEPALIVE_SECONDS + 's');
  }
});

test('every reverse_proxy in the Caddyfile uses a transport with that limit', () => {
  // The block opens at the line's last brace: an upstream such as {$HIVEMEM_ENDPOINT} has its own.
  const proxies = [...caddyfile.matchAll(/reverse_proxy [^\n]*\{$/gm)].map((match) => block(caddyfile, match.index, match.index + match[0].length - 1));
  assert(proxies.length >= 20, 'Expected the suite routes');
  for (const proxy of proxies) {
    const seconds = idleSeconds(proxy);
    assert(seconds !== null && seconds < BACKEND_KEEPALIVE_SECONDS, 'reverse_proxy without the upstream keep-alive limit:\n' + proxy.split('\n')[0]);
  }
});

test('the native routes and listeners hive.sh migrate-native renders use the verified transport', () => {
  const host = readFileSync(join(root, 'scripts/suite/migrate-native-host.sh'), 'utf8');
  const routes = [...host.matchAll(/local proxy_[a-z]+='import ([a-z_]+)/g)].map((match) => match[1]);
  assert.equal(routes.length, 2, 'Expected the rendered native memory and model routes');
  for (const name of routes) assert(idleSeconds(snippets[name] ?? '') < BACKEND_KEEPALIVE_SECONDS, name);
  assert.match(host, /reverse_proxy https:\/\/%s \{\\n\\t\\timport verified_backend %s/, 'Native listeners import verified_backend');
});
