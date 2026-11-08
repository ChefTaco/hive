// Static native client for a disposable restored peer. Request data stays in a protected JSON file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function nativeReadProof(input, { ca, WebSocket, get = https.get }) {
  if (!input || !/^[A-Za-z0-9_-]{1,64}$/.test(input.fileId ?? '') || !/^[a-f0-9]{64}$/.test(input.fileSha256 ?? ''))
    throw Error('Invalid retained attachment identifier or digest');
  const headers = input.headers;
  if (!headers || Object.keys(headers).sort().join(',') !== 'Cookie,Host,Origin'
    || Object.values(headers).some(value => typeof value !== 'string' || /[\r\n\0]/.test(value)))
    throw Error('Invalid native proof headers');
  let origin;
  try { origin = new URL(headers.Origin); } catch { throw Error('Invalid native proof origin'); }
  if (origin.protocol !== 'https:' || origin.hostname !== 'localhost' || headers.Origin !== origin.origin || headers.Host !== origin.host)
    throw Error('Invalid native proof origin');
  // This file contains only this disposable fixture's session and retained attachment metadata.
  // Sending that session to the fixed, CA-verified peer is the authentication being tested.
  // No input can select another destination, TLS server name, request header or URL path prefix.
  const bytes = await new Promise((done, reject) => {
    const request = get('https://ingress:8443/api/v4/files/' + encodeURIComponent(input.fileId),
      { ca, servername: 'localhost', headers, timeout: 8000 }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(Error('Restored attachment read failed')); return; }
        const parts = [];
        response.on('error', reject);
        response.on('data', part => parts.push(part));
        response.on('end', () => done(Buffer.concat(parts)));
      });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Error('Restored attachment timeout')));
  });
  if (createHash('sha256').update(bytes).digest('hex') !== input.fileSha256)
    throw Error('Restored attachment digest differs');
  const ws = new WebSocket('wss://ingress:8443/api/v4/websocket', { ca, servername: 'localhost', headers });
  await new Promise((done, reject) => {
    const finish = error => { clearTimeout(timer); if (error) { ws.terminate(); reject(error); } else { ws.close(); done(); } };
    const timer = setTimeout(() => finish(Error('Restored socket timeout')), 8000);
    ws.on('error', finish);
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw);
        if (message.event === 'hello') ws.send(JSON.stringify({ seq: 1, action: 'ping', data: {} }));
        if (message.seq_reply === 1) finish(message.status === 'OK' ? null : Error('Restored socket ping failed'));
      } catch { finish(Error('Restored socket returned invalid JSON')); }
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const input = JSON.parse(readFileSync('/config/peer-read-proof.json', 'utf8'));
  await nativeReadProof(input, { ca: readFileSync('/config/authority.pem'), WebSocket: createRequire('/app/package.json')('ws') });
  console.log('PASS restored native attachment and authenticated WSS ping');
}
