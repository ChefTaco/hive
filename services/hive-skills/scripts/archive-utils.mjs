import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export function readArchive(bytes) {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds compressed size limit');
  const tar = gunzipSync(bytes, { maxOutputLength: 100 * 1024 * 1024 });
  const entries = [];
  const names = new Set();
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').split('\0')[0];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const checksum = [...block].reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== Number.parseInt(field(block, 148, 8).trim(), 8)) throw new Error('Invalid tar checksum');
    const rawSize = field(block, 124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid tar size');
    const size = Number.parseInt(rawSize, 8);
    const type = field(block, 156, 1);
    if (!['', '0', '5'].includes(type)) throw new Error('Only regular files and directories are allowed');
    const prefix = field(block, 345, 155);
    let name = (prefix ? prefix + '/' : '') + field(block, 0, 100);
    name = name.replace(/^(\.\/)+/, '').replace(/\/$/, '');
    offset += 512;
    if (size > 10 * 1024 * 1024 || offset + size > tar.length || type === '5' && size !== 0) throw new Error('Invalid or excessive unpacked file size');
    if (name) {
      if (name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || names.has(name)) throw new Error('Unsafe or duplicate archive path');
      names.add(name);
      entries.push({ name, directory: type === '5', bytes: tar.subarray(offset, offset + size) });
      if (entries.length > 2000) throw new Error('Archive has too many entries');
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!entries.some((entry) => entry.name === 'SKILL.md' && !entry.directory && entry.bytes.length > 0)) throw new Error('Archive must have a root SKILL.md');
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = entries.find((candidate) => candidate.name === parts.slice(0, i).join('/'));
      if (parent && !parent.directory) throw new Error('Archive file overlaps a directory');
    }
  }
  return entries;
}

export function extractArchive(bytes, destination) {
  const entries = readArchive(bytes); // Validate the entire archive before any write.
  for (const entry of entries) {
    const path = resolve(destination, entry.name);
    mkdirSync(entry.directory ? path : dirname(path), { recursive: true, mode: 0o700 });
    if (!entry.directory) writeFileSync(path, entry.bytes, { mode: 0o600, flag: 'wx' });
  }
}

export async function boundedResponse(response, limit) {
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Response exceeds size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Response exceeds size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
