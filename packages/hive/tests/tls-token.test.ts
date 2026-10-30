import assert from "node:assert/strict";
import { createHmac, X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { describe, it } from "node:test";
import { EnvDocument } from "../src/envfile.js";
import { probeHttp, probeRedis } from "../src/net.js";
import { certificateNames, createCertificates, inspectServerCertificate, namesOnCertificate, opensslVersion, subjectAltName, tlsFiles } from "../src/tls.js";
import { memoryTokenProblem, signedWith, tokenExpiry } from "../src/token.js";
import { fakeRedis, listen, tempHome } from "./helpers.js";

function hs256(secret: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

describe("Router HiveMem token", () => {
  const secret = "a".repeat(64);
  const now = 1_800_000_000;
  const memory = new EnvDocument(`HIVEMEM_JWT_SECRET=${secret}\n`);
  const router = (token?: string) => new EnvDocument(token ? `HIVE_ROUTER_MEMORY_PROXY_TOKEN=${token}\n` : "");

  it("is renewed when missing, malformed, signed with another secret, expired or close to expiry", () => {
    assert.equal(memoryTokenProblem(router(), memory, now), "missing");
    assert.equal(memoryTokenProblem(router("not-a-jwt"), memory, now), "malformed");
    assert.equal(memoryTokenProblem(router(hs256("b".repeat(64), { exp: now + 20 * 86_400 })), memory, now), "wrong-secret");
    assert.equal(memoryTokenProblem(router(hs256(secret, { exp: now - 1 })), memory, now), "expired");
    assert.equal(memoryTokenProblem(router(hs256(secret, { exp: now + 6 * 86_400 })), memory, now), "expiring");
    assert.equal(memoryTokenProblem(router(hs256(secret, { exp: now + 8 * 86_400 })), memory, now), null);
  });

  it("decodes the expiry and checks the signature locally", () => {
    const token = hs256(secret, { exp: now });
    assert.equal(tokenExpiry(token), now);
    assert.ok(signedWith(token, secret));
    assert.ok(!signedWith(token, "c".repeat(64)));
  });
});

describe("local TLS", { skip: opensslVersion() ? false : "openssl is not installed" }, () => {
  it("creates a CA and a server certificate the launcher's probes trust", async () => {
    const { paths, cleanup } = tempHome();
    try {
      const names = certificateNames("hive.example.com");
      assert.equal(subjectAltName(names), "DNS:localhost,IP:127.0.0.1,IP:::1,DNS:hive.example.com");
      const files = createCertificates(paths, names, { newCa: true });
      assert.equal(statSync(files.caKey).mode & 0o777, 0o600);
      assert.equal(statSync(files.key).mode & 0o777, 0o600);
      assert.equal(statSync(paths.tls).mode & 0o777, 0o700);
      const cert = new X509Certificate(readFileSync(files.cert));
      const ca = new X509Certificate(readFileSync(files.caCert));
      assert.ok(cert.verify(ca.publicKey));
      assert.ok(ca.ca);
      assert.deepEqual(namesOnCertificate(readFileSync(files.cert)).sort(), [...names].sort());
      assert.deepEqual(inspectServerCertificate(files, names), { state: "ok" });
      assert.equal(inspectServerCertificate(files, [...names, "other.example.com"]).state, "unusable");
      assert.deepEqual(inspectServerCertificate(tlsFiles(paths), ["localhost"], new Date(Date.now() + 900 * 86_400_000)).state, "unusable");

      const server = createServer({ cert: readFileSync(files.cert), key: readFileSync(files.key) }, (_request, response) => response.end("ok"));
      const port = await listen(server);
      try {
        assert.equal((await probeHttp(`https://127.0.0.1:${port}/`, { ca: readFileSync(files.caCert) })).ok, true);
        assert.equal((await probeHttp(`https://localhost:${port}/`, { ca: readFileSync(files.caCert) })).ok, true);
        const untrusted = await probeHttp(`https://127.0.0.1:${port}/`);
        assert.equal(untrusted.ok, false);
        assert.match(untrusted.error ?? "", /not trusted|certificate/i);
      } finally {
        server.close();
      }

      // A new server certificate keeps the CA.
      const caBefore = readFileSync(files.caCert, "utf8");
      createCertificates(paths, certificateNames(), { newCa: false });
      assert.equal(readFileSync(files.caCert, "utf8"), caBefore);
      assert.ok(new X509Certificate(readFileSync(files.cert)).verify(ca.publicKey));
    } finally {
      cleanup();
    }
  });
});

describe("store probes", () => {
  it("tells Redis apart from a password-protected Redis and from other services", async () => {
    const ok = await fakeRedis();
    const auth = await fakeRedis("-NOAUTH Authentication required.\r\n");
    const other = await fakeRedis("HTTP/1.1 400 Bad Request\r\n\r\n");
    try {
      assert.equal(await probeRedis("127.0.0.1", ok.port), "ok");
      assert.equal(await probeRedis("127.0.0.1", auth.port), "auth-required");
      assert.equal(await probeRedis("127.0.0.1", other.port), "not-redis");
    } finally {
      await Promise.all([ok.close(), auth.close(), other.close()]);
    }
    assert.equal(await probeRedis("127.0.0.1", ok.port), "down");
  });
});
