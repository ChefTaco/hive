import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyBearerToken } from "../src/auth.js";
import { envSchema } from "../src/config.js";
import { ADMIN_SCOPE, DEFAULT_AGENT_SCOPES, ISSUE_TOKEN_MAX_TTL_SECONDS, issueToken, parseDuration, resolveIssueTokenRequest } from "../src/issue-token.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const secret = () => randomBytes(32).toString("hex");

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });
}

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address && typeof address === "object");
  return address.port;
}

describe("issue-token request validation", () => {
  it("parses durations and enforces the lifetime limits", () => {
    assert.equal(parseDuration("3600"), 3600);
    assert.equal(parseDuration("90s"), 90);
    assert.equal(parseDuration("45m"), 2700);
    assert.equal(parseDuration("12h"), 43_200);
    assert.equal(parseDuration("30d"), ISSUE_TOKEN_MAX_TTL_SECONDS);
    assert.ok(Number.isNaN(parseDuration("1w")));
    assert.ok(Number.isNaN(parseDuration("-5m")));
    assert.match(resolveIssueTokenRequest({ subject: "svc", ttl: "31d" }).problems[0] ?? "", /^--ttl must be between 60 seconds and 30 days/);
    assert.match(resolveIssueTokenRequest({ subject: "svc", ttl: "59" }).problems[0] ?? "", /^--ttl must be between/);
    assert.match(resolveIssueTokenRequest({ subject: "svc", ttl: "soon" }).problems[0] ?? "", /^--ttl must be a duration/);
    assert.equal(resolveIssueTokenRequest({ subject: "svc" }).request?.ttlSeconds, ISSUE_TOKEN_MAX_TTL_SECONDS);
  });

  it("requires a well-formed subject and a known role", () => {
    assert.match(resolveIssueTokenRequest({}).problems[0] ?? "", /^--subject is required/);
    assert.match(resolveIssueTokenRequest({ subject: "bad subject" }).problems[0] ?? "", /^--subject must be/);
    assert.match(resolveIssueTokenRequest({ subject: "svc", role: "root" }).problems[0] ?? "", /^--role must be admin or agent/);
  });

  it("defaults scopes by role and keeps admin scopes away from agent tokens", () => {
    assert.deepEqual(resolveIssueTokenRequest({ subject: "hive-router", role: "admin" }).request?.scopes, [ADMIN_SCOPE]);
    assert.deepEqual(resolveIssueTokenRequest({ subject: "agent-1" }).request?.scopes, [...DEFAULT_AGENT_SCOPES]);
    assert.deepEqual(resolveIssueTokenRequest({ subject: "agent-1", scopes: ["memories:read, context:read", "memories:read"] }).request?.scopes, ["memories:read", "context:read"]);
    assert.match(resolveIssueTokenRequest({ subject: "agent-1", scopes: ["admin:all"] }).problems[0] ?? "", /agent tokens cannot carry wildcard or admin/);
    assert.match(resolveIssueTokenRequest({ subject: "agent-1", scopes: ["*"] }).problems[0] ?? "", /agent tokens cannot carry/);
    assert.match(resolveIssueTokenRequest({ subject: "agent-1", scopes: ["memories"] }).problems[0] ?? "", /--scope values must look like memories:read/);
  });
});

describe("issueToken", () => {
  it("signs the claim set the server verifies, matching the deploy-time admin token", () => {
    const key = secret();
    const request = resolveIssueTokenRequest({ subject: "hive-router", role: "admin", ttl: "1h" }).request;
    assert.ok(request);
    const now = Date.now();
    const issued = issueToken(key, request, now);
    const claims = decodeClaims(issued.token);
    assert.equal(claims.iss, "hivemem");
    assert.equal(claims.aud, "hivemem-api");
    assert.equal(claims.token_type, "access");
    assert.equal(claims.sub, "hive-router");
    assert.equal(claims.role, "admin");
    assert.equal(claims.scope, "admin:all");
    assert.equal(typeof claims.jti, "string");
    assert.equal(claims.exp, Math.floor(now / 1000) + 3600);
    assert.equal(issued.expiresAt.getTime(), (claims.exp as number) * 1000);
    const principal = verifyBearerToken(`Bearer ${issued.token}`, key);
    assert.equal(principal.agentId, "hive-router");
    assert.throws(() => verifyBearerToken(`Bearer ${issued.token}`, secret()), /Invalid JWT signature/);
    assert.notEqual(issueToken(key, request, now).token, issued.token, "each token gets its own jti");
  });

  it("refuses the placeholder and short secrets the server refuses", () => {
    const request = resolveIssueTokenRequest({ subject: "svc" }).request;
    assert.ok(request);
    assert.throws(() => issueToken("short", request), /at least 32 bytes/);
    assert.throws(() => issueToken("change_me_change_me_change_me_change_me", request), /not a placeholder/);
  });

  it("is described in the env schema for launchers", () => {
    const schema = envSchema();
    assert.equal(schema.issueToken.command, "issue-token");
    assert.equal(schema.issueToken.signedWith, "HIVEMEM_JWT_SECRET");
    assert.equal(schema.issueToken.maxTtlSeconds, ISSUE_TOKEN_MAX_TTL_SECONDS);
    assert.deepEqual([...schema.issueToken.roles], ["admin", "agent"]);
  });
});

describe("hivemem-server issue-token", () => {
  it("prints only the token, reads the secret from --env-file, and writes nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemem-token-"));
    try {
      const key = secret();
      const envFile = join(directory, "memory.env");
      await writeFile(envFile, `HIVEMEM_JWT_SECRET=${key}\n`, { mode: 0o600 });
      const before = await readdir(directory);
      const result = runCli(["issue-token", "--env-file", envFile, "--subject", "hive-router", "--role=admin", "--ttl", "2h"], { HOME: directory, HIVE_HOME: directory });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const lines = result.stdout.split("\n");
      assert.equal(lines.length, 2);
      assert.equal(lines[1], "");
      const token = lines[0] ?? "";
      assert.match(token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
      assert.equal(verifyBearerToken(`Bearer ${token}`, key).rawClaims.role, "admin");
      assert.deepEqual(await readdir(directory), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails with one line per problem and no token when the secret or options are wrong", () => {
    const missing = runCli(["issue-token", "--subject", "svc"], { HOME: "/nonexistent" });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /^hivemem-server: HIVEMEM_JWT_SECRET is not set/);
    assert.doesNotMatch(missing.stderr, /\n\s+at /);
    const both = runCli(["issue-token", "--role", "agent", "--scope", "admin:all"], { HIVEMEM_JWT_SECRET: "too-short" });
    assert.equal(both.status, 1);
    assert.equal(both.stdout, "");
    const lines = both.stderr.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /HIVEMEM_JWT_SECRET must be at least 32 bytes/);
    assert.match(lines[1] ?? "", /--subject is required/);
    assert.match(lines[2] ?? "", /agent tokens cannot carry/);
    const misplaced = runCli(["check", "--subject", "svc"], {});
    assert.equal(misplaced.status, 1);
    assert.match(misplaced.stderr, /--subject is only valid with issue-token/);
    const noValue = runCli(["issue-token", "--subject"], {});
    assert.match(noValue.stderr, /--subject requires a value/);
  });

  it("mints an admin token a running server accepts on admin routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemem-token-"));
    const key = secret();
    const port = await freePort();
    const env = { PATH: process.env.PATH, HOME: directory, HIVE_HOME: directory, HIVEMEM_JWT_SECRET: key, HIVEMEM_TS_PERSISTENCE: "memory", HIVEMEM_WEB_PORT: String(port), HIVEMEM_WORKER_ENABLED: "false" };
    const child = spawn(process.execPath, [cli], { env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const admin = runCli(["issue-token", "--subject", "hive-router", "--role", "admin"], env).stdout.trim();
      const agent = runCli(["issue-token", "--subject", "agent-1"], env).stdout.trim();
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
        ready = (await fetch(`http://127.0.0.1:${port}/v1/health/ready`).catch(() => undefined))?.status === 200;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, "server became ready");
      const audit = (token: string) => fetch(`http://127.0.0.1:${port}/v1/admin/audit`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((await audit(admin)).status, 200);
      assert.equal((await audit(agent)).status, 403);
      const stats = await fetch(`http://127.0.0.1:${port}/v1/stats`, { headers: { authorization: `Bearer ${agent}` } });
      assert.equal(stats.status, 200);
    } finally {
      child.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
