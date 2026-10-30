#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_PUBLISHED_KEYS = 8;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function thumbprint(jwk) {
  if (jwk.kty !== 'RSA' || typeof jwk.e !== 'string' || typeof jwk.n !== 'string') {
    fail('keyring contains a non-RSA public key');
  }
  return createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url');
}

async function regularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${path} is not a regular, non-symlink file`);
  }
}

const release = process.argv[2];
const liveJwksPath = process.argv[3];
if (!release || process.argv.length < 3 || process.argv.length > 4) {
  fail('usage: validate-jwt-keyring.mjs RELEASE_DIR [LIVE_JWKS_FILE]');
}

const privatePath = join(release, 'active-private.pem');
const publicPath = join(release, 'active-public.pem');
await regularFile(privatePath);
await regularFile(publicPath);

const [privatePem, publicPem] = await Promise.all([
  readFile(privatePath, 'utf8'),
  readFile(publicPath, 'utf8'),
]);
const privatePublic = createPublicKey(createPrivateKey(privatePem))
  .export({ type: 'spki', format: 'pem' })
  .toString();
const normalizedPublic = createPublicKey(publicPem)
  .export({ type: 'spki', format: 'pem' })
  .toString();
if (privatePublic !== normalizedPublic) fail('active private and public keys do not match');

const previousDirectory = join(release, 'previous');
const previousNames = (await readdir(previousDirectory)).sort();
if (previousNames.some((name) => !/^iam-public-[A-Za-z0-9._-]+\.pem$/.test(name))) {
  fail('previous key directory contains an unexpected filename');
}

const publicPaths = [publicPath, ...previousNames.map((name) => join(previousDirectory, name))];
if (publicPaths.length > MAX_PUBLISHED_KEYS) {
  fail(`keyring exceeds ${MAX_PUBLISHED_KEYS} published keys`);
}

const kids = [];
const expectedJwks = [];
for (const path of publicPaths) {
  await regularFile(path);
  const pem = await readFile(path, 'utf8');
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  expectedJwks.push(jwk);
  kids.push(thumbprint(jwk));
}
if (new Set(kids).size !== kids.length) fail('keyring publishes a duplicate key');

if (liveJwksPath) {
  await regularFile(liveJwksPath);
  let liveJwks;
  try {
    liveJwks = JSON.parse(await readFile(liveJwksPath, 'utf8'));
  } catch {
    fail('live JWKS is not valid JSON');
  }
  if (!Array.isArray(liveJwks?.keys) || liveJwks.keys.length < 1 || liveJwks.keys.length > MAX_PUBLISHED_KEYS) {
    fail(`live JWKS must contain between 1 and ${MAX_PUBLISHED_KEYS} keys`);
  }

  const liveKids = [];
  if (liveJwks.keys.length !== expectedJwks.length) {
    fail('live JWKS key count does not match the staged release');
  }
  for (const [index, jwk] of liveJwks.keys.entries()) {
    if (jwk?.use !== 'sig' || jwk?.alg !== 'RS256') {
      fail('live JWKS contains a key with an unexpected use or algorithm');
    }
    const computedKid = thumbprint(jwk);
    if (jwk.kid !== computedKid) fail('live JWKS key ID does not match its RFC 7638 thumbprint');
    if (jwk.kty !== expectedJwks[index].kty || jwk.n !== expectedJwks[index].n || jwk.e !== expectedJwks[index].e) {
      fail('live JWKS RSA material does not match the staged release');
    }
    liveKids.push(computedKid);
  }
  if (new Set(liveKids).size !== liveKids.length) fail('live JWKS publishes a duplicate key');

  const expectedActiveJwk = expectedJwks[0];
  const liveActiveJwk = liveJwks.keys[0];
  if (
    liveActiveJwk.kty !== expectedActiveJwk.kty ||
    liveActiveJwk.n !== expectedActiveJwk.n ||
    liveActiveJwk.e !== expectedActiveJwk.e ||
    liveActiveJwk.kid !== kids[0]
  ) {
    fail('live JWKS active RSA material does not match the staged release');
  }

  // Prove that the staged private key signs with the exact public material
  // advertised by the live listener, without emitting the short-lived token.
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: kids[0], typ: 'JWT' })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify({ aud: 'hive-iam-keyring-check', exp: now + 30, iat: now })).toString('base64url');
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = sign('RSA-SHA256', signingInput, privatePem);
  if (!verify('RSA-SHA256', signingInput, createPublicKey({ key: liveActiveJwk, format: 'jwk' }), signature)) {
    fail('live JWKS active key cannot verify a staged-key test token');
  }
}

// The active key must be first, matching the IAM JWKS contract.
process.stdout.write(`${kids[0]}\n`);
