import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { AuthError, verifyBearerToken } from "../src/auth.js";
import { createHiveMemServer } from "../src/server.js";

const secret = "dummy-signing-secret-at-least-32-bytes";
const now = Math.floor(Date.now() / 1000);

function signed(payload: unknown, header: unknown = { alg: "HS256" }): string {
  const encoded = [header, payload].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

describe("JWT validation boundaries", () => {
  it("rejects malformed present claims while retaining tokens that omit optional claims", () => {
    const legacy = { sub: "dummy-agent", exp: now + 3600 };
    assert.equal(verifyBearerToken(`Bearer ${signed(legacy)}`, secret).agentId, legacy.sub);
    for (const extra of [{ aud: [] }, { aud: 123 }, { aud: null }, { aud: ["hivemem-api", 123] }, { iat: "yesterday" }, { nbf: "tomorrow" }, { jti: "" }, { jti: 123 }]) {
      assert.throws(() => verifyBearerToken(`Bearer ${signed({ ...legacy, ...extra })}`, secret), AuthError, JSON.stringify(extra));
    }
  });

  it("requires a valid issued-at claim when a maximum lifetime is configured", () => {
    const claims = { sub: "dummy-agent", exp: now + 3600 };
    assert.throws(() => verifyBearerToken(`Bearer ${signed(claims)}`, secret, { maxLifetimeSeconds: 60 }), AuthError);
    assert.throws(() => verifyBearerToken(`Bearer ${signed({ ...claims, iat: now + 30, exp: now + 10 })}`, secret), AuthError);
  });

  it("returns 401 without echoing malformed JWT JSON, and 400 without echoing malformed request JSON", async () => {
    const server = createHiveMemServer({ jwtSecret: secret });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const invalidHeader = Buffer.from('dummy-private-header').toString('base64url');
      const unsigned = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString('base64url')}.${Buffer.from('dummy-private-payload').toString('base64url')}`;
      const invalidPayload = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
      for (const token of [`${invalidHeader}.e30.invalid`, invalidPayload]) {
        const response = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(response.status, 401);
        assert.doesNotMatch(await response.text(), /dummy-private/);
      }
      const response = await fetch(`${base}/v1/memories`, {
        method: "POST", headers: { authorization: `Bearer ${signed({ sub: "dummy-agent", scope: "memories:write", exp: now + 3600 })}`, "content-type": "application/json" },
        body: 'dummy-private-request',
      });
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /dummy-private-request/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
