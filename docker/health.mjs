import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
const name = process.env.HIVE_PACKAGE;
let url;
if (name.endsWith('/hive-iam-server'))
  url = `${process.env.TLS_CERT_PATH ? 'https' : 'http'}://localhost:${process.env.PORT || 4200}/api/v1/health/ready`;
else if (name.endsWith('/hivemem-server'))
  url = `${process.env.HIVEMEM_TLS_CERT_FILE || process.env.HIVEMEM_TS_TLS_CERT_FILE ? 'https' : 'http'}://localhost:${process.env.HIVEMEM_WEB_PORT || 18790}/v1/health/ready`;
else if (name.endsWith('/hive-skills'))
  url = `https://localhost:${process.env.HIVE_SKILLS_PORT || 4030}/healthz`;
else
  url = `${process.env.TLS_CERT_PATH ? 'https' : 'http'}://localhost:${process.env.ADMIN_PORT || 9443}/health/ready`;
const req = (url.startsWith('https:') ? httpsGet : httpGet)(url, { timeout: 3000 }, (res) => {
  res.resume();
  process.exitCode = res.statusCode === 200 ? 0 : 1;
});
req.once('error', () => {
  process.exitCode = 1;
});
req.once('timeout', () => req.destroy(new Error('Health timeout')));
