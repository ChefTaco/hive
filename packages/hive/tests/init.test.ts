import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { randomUUID } from 'node:crypto';
import { projectFile, writeJson } from '../src/release/runtime.js';
import { after, before, describe, it } from "node:test";
import { EnvDocument } from "../src/envfile.js";
import { CliError } from "../src/errors.js";
import { runInit, type InitOptions } from "../src/init.js";
import type { HivePaths } from "../src/paths.js";
import { scriptedPrompter } from "../src/prompt.js";
import { opensslVersion } from "../src/tls.js";
import { signedWith } from "../src/token.js";
import { fakeQdrant, fakeRedis, installFakeServers, recordingOutput, tempHome } from "./helpers.js";

let qdrant: Awaited<ReturnType<typeof fakeQdrant>>;
let redis: Awaited<ReturnType<typeof fakeRedis>>;
before(async () => {
  qdrant = await fakeQdrant();
  redis = await fakeRedis();
});
after(async () => {
  await qdrant.close();
  await redis.close();
});

function options(overrides: Partial<InitOptions> = {}): InitOptions {
  return { tls: false, ports: {}, dockerPrefix: "hive-test", qdrantUrl: qdrant.url, redisUrl: redis.url, ...overrides };
}

async function init(paths: HivePaths, initOptions: InitOptions, answers: string[] = [], isFree: (port: number) => Promise<boolean> = async () => true) {
  const output = recordingOutput();
  const asked: string[] = [];
  const result = await runInit({ paths, output, prompter: scriptedPrompter(answers, asked), options: initOptions, platform: "linux", username: "alice", isFree });
  return { result, output, asked };
}

const env = (paths: HivePaths, service: "memory" | "router" | "iam" | "skills") => EnvDocument.load(paths.envFile(service));

describe("hive init", () => {
  it('refuses additions to a managed service inventory before writing configuration', async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths);
      writeJson(projectFile(paths.home), { schema: 1, id: randomUUID(), manager: 'foreground', services: ['router'], launcher: '@hivemagnus/hive', createdAt: new Date().toISOString() });
      const before = readFileSync(projectFile(paths.home), 'utf8');
      await assert.rejects(init(paths, options({ services: ['iam'] })), /service selection is fixed/);
      assert.equal(readFileSync(projectFile(paths.home), 'utf8'), before);
    } finally { cleanup(); }
  });
  it("writes private env files for all three services with consistent wiring", { skip: opensslVersion() ? false : "openssl is not installed" }, async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths);
      const { result, asked } = await init(paths, options({ services: ["memory", "router", "iam"], tls: true }));
      assert.deepEqual(asked, []);
      assert.deepEqual(result.written.sort(), ["iam", "memory", "router"]);
      assert.equal(result.consoleUrl, "https://localhost:9443/");
      for (const service of ["memory", "router", "iam"] as const) assert.equal(statSync(paths.envFile(service)).mode & 0o777, 0o600);
      assert.equal(statSync(paths.config).mode & 0o777, 0o700);
      assert.equal(statSync(paths.home).mode & 0o777, 0o700);

      const memory = env(paths, "memory");
      const router = env(paths, "router");
      const iam = env(paths, "iam");
      for (const doc of [memory, router, iam]) assert.equal(doc.get("HIVE_HOME"), paths.home);
      assert.match(memory.get("HIVEMEM_JWT_SECRET") ?? "", /^[0-9a-f]{64}$/);
      assert.equal(memory.get("HIVEMEM_RENEWAL_SECRET"), undefined, "optional secrets stay unset");
      assert.equal(memory.get("HIVEMEM_QDRANT_URL"), qdrant.url);
      assert.equal(iam.get("REDIS_URL"), redis.url);
      assert.equal(iam.get("SEED_ADMIN_PASSWORD"), undefined, "IAM generates the admin password itself");
      assert.match(iam.get("COOKIE_SECRET") ?? "", /^[0-9a-f]{64}$/);

      // Router <-> IAM
      assert.equal(router.get("HIVE_ROUTER_AUTH_MODE"), "iam-oidc");
      assert.equal(router.get("HIVE_ROUTER_ADMIN_USERS"), "admin");
      assert.equal(router.get("HIVE_ROUTER_IAM_CLIENT_SECRET"), iam.get("SEED_HIVE_ROUTER_CLIENT_SECRET"));
      assert.equal(router.get("HIVE_IAM_INTERNAL_URL"), "https://127.0.0.1:4200");
      assert.equal(router.get("HIVE_ROUTER_IAM_REDIRECT_URI"), "https://localhost:9443/api/auth/oidc/callback");
      assert.equal(iam.get("SEED_HIVE_ROUTER_REDIRECT_URI"), router.get("HIVE_ROUTER_IAM_REDIRECT_URI"));
      assert.equal(iam.get("SEED_HIVE_PUBLIC_URL"), "https://localhost:9443");
      assert.equal(router.get("HIVE_ROUTER_IAM_ISSUER"), iam.get("JWT_ISSUER"));
      assert.equal(router.get("HIVE_ROUTER_IAM_AUDIENCE"), "hive-router");
      // Router <-> HiveMem
      assert.equal(router.get("HIVEMEM_INTERNAL_URL"), "https://127.0.0.1:18790");
      assert.ok(signedWith(router.get("HIVE_ROUTER_MEMORY_PROXY_TOKEN") ?? "", memory.get("HIVEMEM_JWT_SECRET") ?? ""));
      // TLS
      const ca = `${paths.tls}/ca.crt`;
      assert.equal(router.get("HIVE_ROUTER_IAM_CA_CERT_PATH"), ca);
      assert.equal(router.get("HIVEMEM_CA_CERT_PATH"), ca);
      assert.equal(router.get("NODE_ENV"), "production");
      for (const [doc, cert] of [[router, "TLS_CERT_PATH"], [iam, "TLS_CERT_PATH"], [memory, "HIVEMEM_TLS_CERT_FILE"]] as const) assert.equal(doc.get(cert), `${paths.tls}/server.crt`);
      assert.deepEqual(new Set([memory.get("HIVEMEM_WEB_PORT"), router.get("API_PORT"), router.get("ADMIN_PORT"), iam.get("PORT")]).size, 4);
      assert.match(readFileSync(paths.envFile("router"), "utf8"), /^# Hive Router \(@hivemagnus\/hive-router\), written by `hive init`/);

      // Re-running asks nothing and changes nothing.
      const before = ["memory", "router", "iam"].map((service) => readFileSync(paths.envFile(service as "memory"), "utf8"));
      const tlsBefore = readFileSync(`${paths.tls}/server.crt`, "utf8");
      const again = await init(paths, options({ tls: true, services: ["memory", "router", "iam"] }));
      assert.deepEqual(again.asked, []);
      assert.deepEqual(again.result.written, []);
      assert.deepEqual(["memory", "router", "iam"].map((service) => readFileSync(paths.envFile(service as "memory"), "utf8")), before);
      assert.equal(readFileSync(`${paths.tls}/server.crt`, "utf8"), tlsBefore);
      assert.match(again.output.text(), /router\.env is up to date/);
    } finally {
      cleanup();
    }
  });

  it("sets up the Router alone with OS sign-in, then wires in IAM later after asking", async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths);
      const first = await init(paths, options(), ["router"]);
      assert.deepEqual(first.asked, ["Services to set up (comma-separated)"]);
      let router = env(paths, "router");
      assert.equal(router.get("HIVE_ROUTER_AUTH_MODE"), "os");
      assert.equal(router.get("HIVE_ROUTER_ADMIN_USERS"), "alice");
      assert.equal(router.get("NODE_ENV"), "development");
      assert.equal(router.get("PUBLIC_ADMIN_URL"), "http://localhost:9443");
      assert.equal(router.get("HIVE_ROUTER_IAM_CLIENT_SECRET"), undefined);
      assert.match(first.output.text(), /pamtester/);
      const secret = router.get("HIVE_ROUTER_SECRET");

      // Declining the "also set up" questions keeps everything as it is.
      const unchanged = await init(paths, options(), ["n", "n", "n"]);
      assert.deepEqual(unchanged.asked, ["Also set up memory (HiveMem)?", "Also set up iam (Hive IAM)?", "Also set up skills (Hive Skills)?"]);
      assert.deepEqual(unchanged.result.services, ["router"]);

      const added = await init(paths, options(), ["n", "y", "n", "y"]);
      assert.equal(added.asked.at(-1), "Update router.env?");
      assert.match(added.output.text(), /HIVE_ROUTER_AUTH_MODE: os -> iam-oidc/);
      assert.match(added.output.text(), /add HIVE_ROUTER_IAM_CLIENT_SECRET=[0-9a-f]{4}••••/);
      router = env(paths, "router");
      const iam = env(paths, "iam");
      assert.equal(router.get("HIVE_ROUTER_SECRET"), secret, "existing secrets are kept");
      assert.equal(router.get("HIVE_ROUTER_AUTH_MODE"), "iam-oidc");
      assert.equal(router.get("HIVE_ROUTER_ADMIN_USERS"), "admin");
      assert.equal(router.get("HIVE_ROUTER_IAM_CLIENT_SECRET"), iam.get("SEED_HIVE_ROUTER_CLIENT_SECRET"));
      assert.equal(iam.get("SEED_HIVE_ROUTER_REDIRECT_URI"), "http://localhost:9443/api/auth/oidc/callback");
    } finally {
      cleanup();
    }
  });

  it("asks before overwriting a mismatched shared secret and leaves the file alone when declined", async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths);
      await init(paths, options({ services: ["router", "iam"] }));
      const router = env(paths, "router");
      router.set("HIVE_ROUTER_IAM_CLIENT_SECRET", "f".repeat(64));
      const { writePrivateFile } = await import("../src/envfile.js");
      writePrivateFile(paths.envFile("router"), router.toString());
      const declined = await init(paths, options(), ["n", "n", "n"]);
      assert.equal(declined.asked.at(-1), "Update router.env?");
      assert.match(declined.output.text(), /HIVE_ROUTER_IAM_CLIENT_SECRET: ffff•••• -> [0-9a-f]{4}••••/);
      assert.doesNotMatch(declined.output.text(), /f{64}/, "secrets are never printed in full");
      assert.equal(env(paths, "router").get("HIVE_ROUTER_IAM_CLIENT_SECRET"), "f".repeat(64));
      assert.match(declined.output.text(), /Left .*router\.env unchanged/);
      await init(paths, options(), ["n", "n", "y"]);
      assert.equal(env(paths, "router").get("HIVE_ROUTER_IAM_CLIENT_SECRET"), env(paths, "iam").get("SEED_HIVE_ROUTER_CLIENT_SECRET"));
    } finally {
      cleanup();
    }
  });

  it("moves off ports that are in use and refuses an explicit port that is taken", async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths);
      const busy = new Set([4020, 4021, 9443]);
      await init(paths, options({ services: ["router"] }), [], async (port) => !busy.has(port));
      const router = env(paths, "router");
      assert.equal(router.get("API_PORT"), "4022");
      assert.equal(router.get("ADMIN_PORT"), "9444");
      const other = tempHome();
      try {
        installFakeServers(other.paths);
        await assert.rejects(init(other.paths, options({ services: ["memory"], ports: { memory: 4020 } }), [], async (port) => !busy.has(port)), (error: unknown) => error instanceof CliError && /port 4020 \(--port memory\) is already in use/.test(error.message));
      } finally {
        other.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  it("stops when the user declines to install a missing server", async () => {
    const { paths, cleanup } = tempHome();
    try {
      await assert.rejects(init(paths, options({ services: ["memory"] }), ["n"]), (error: unknown) => error instanceof CliError && /cannot continue without @hivemagnus\/hivemem-server/.test(error.message));
    } finally {
      cleanup();
    }
  });
});

describe("optional Skills setup", () => {
  it("sets up Skills alone with a public hostname and no external stores", async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths, ["skills"]);
      const result = await init(paths, options({ tls: true, services: ["skills"], hostname: "hive.example.com", qdrantUrl: undefined, redisUrl: undefined }));
      assert.deepEqual(result.result.services, ["skills"]);
      assert.deepEqual(result.result.written, ["skills"]);
      assert.equal(env(paths, "skills").get("HIVE_SKILLS_HOST"), "0.0.0.0");
      assert.equal(env(paths, "skills").get("HIVE_SKILLS_PUBLIC_URL"), "https://hive.example.com:4030");
      assert.equal(result.result.consoleUrl, null);
    } finally { cleanup(); }
  });

  it("adds Skills to an existing core setup while keeping credentials and data paths", async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths, ["memory", "router", "iam", "skills"]);
      await init(paths, options({ tls: true, services: ["memory", "router", "iam"] }));
      const iamBefore = readFileSync(paths.envFile("iam"), "utf8");
      const memoryBefore = readFileSync(paths.envFile("memory"), "utf8");
      const routerSecret = env(paths, "router").get("HIVE_ROUTER_SECRET");
      const added = await init(paths, options({ tls: true, services: ["skills"] }), ["y"]);
      assert.deepEqual(added.result.services, ["iam", "memory", "skills", "router"]);
      assert.equal(readFileSync(paths.envFile("iam"), "utf8"), iamBefore);
      assert.equal(readFileSync(paths.envFile("memory"), "utf8"), memoryBefore);
      assert.equal(env(paths, "router").get("HIVE_ROUTER_SECRET"), routerSecret);
      assert.equal(env(paths, "router").get("HIVE_SKILLS_INTERNAL_URL"), "https://127.0.0.1:4030");
    } finally { cleanup(); }
  });

  it("configures all four services with private state, TLS and independent OS administration", async () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths, ["memory", "router", "iam", "skills"]);
      await init(paths, options({ tls: true, services: ["iam", "memory", "skills", "router"] }), [], async (port) => port !== 4030);
      const skills = env(paths, "skills");
      assert.equal(skills.get("HIVE_SKILLS_PORT"), "4031");
      assert.equal(skills.get("HIVE_SKILLS_DATA_DIR"), `${paths.home}/skills`);
      assert.equal(skills.get("HIVE_SKILLS_ADMIN_USERS"), "alice");
      assert.equal(skills.get("HIVE_SKILLS_PAM_SERVICE"), "login");
      assert.equal(skills.get("HIVE_SKILLS_SESSION_SECRET")?.length, 64);
      assert.equal(skills.get("HIVE_SKILLS_TLS_CERT_FILE"), `${paths.tls}/server.crt`);
      assert.equal(env(paths, "router").get("HIVE_SKILLS_INTERNAL_URL"), "https://127.0.0.1:4031");
      assert.equal(env(paths, "router").get("HIVE_SKILLS_PUBLIC_URL"), "https://localhost:4031");
      assert.equal(statSync(paths.envFile("skills")).mode & 0o777, 0o600);
      const before = ["memory", "router", "iam", "skills"].map((s) => readFileSync(paths.envFile(s as "skills"), "utf8"));
      const again = await init(paths, options({ tls: true }));
      assert.deepEqual(again.asked, []); assert.deepEqual(again.result.written, []);
      assert.deepEqual(["memory", "router", "iam", "skills"].map((s) => readFileSync(paths.envFile(s as "skills"), "utf8")), before);
    } finally { cleanup(); }
  });

  it("rejects new Skills setup without TLS before installing packages or writing env files", async () => {
    const { paths, cleanup } = tempHome();
    try {
      await assert.rejects(init(paths, options({ services: ["skills"] })), /Skills requires TLS/);
      assert.equal((await import("node:fs")).existsSync(paths.envFile("skills")), false);
      assert.equal((await import("node:fs")).existsSync(paths.runtime), false);
    } finally { cleanup(); }
  });
});
