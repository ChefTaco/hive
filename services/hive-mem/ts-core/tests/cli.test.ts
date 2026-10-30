import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, defaultStoragePath, envSchema, HEALTH_PATH, probeQdrant, resolveConfig } from "../src/config.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string; bin: Record<string, string> };
const secret = () => randomBytes(32).toString("hex");

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "hivemem-cli-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address && typeof address === "object");
  return address.port;
}

describe("server configuration", () => {
  it("names the missing JWT secret and how to generate one", () => {
    const { problems } = resolveConfig({ HIVE_HOME: "/tmp/hive-test" });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /^HIVEMEM_JWT_SECRET is not set; generate one with `openssl rand -hex 32`/);
    assert.match(resolveConfig({ HIVEMEM_JWT_SECRET: "change_me_change_me_change_me_change_me" }).problems[0] ?? "", /HIVEMEM_JWT_SECRET must be at least 32 bytes/);
  });

  it("defaults to Qdrant persistence and accepts only an explicit volatile opt-in", () => {
    const base = { HIVEMEM_JWT_SECRET: secret(), HIVE_HOME: "/tmp/hive-test" };
    const defaults = resolveConfig(base);
    assert.deepEqual(defaults.problems, []);
    assert.equal(defaults.config.persistence, "qdrant");
    assert.equal(defaults.config.qdrantUrl, "http://127.0.0.1:6333");
    assert.equal(defaults.config.port, DEFAULT_PORT);
    assert.equal(defaults.config.host, "127.0.0.1");
    assert.equal(resolveConfig({ ...base, HIVEMEM_TS_PERSISTENCE: "memory" }).config.persistence, "memory");
    assert.equal(resolveConfig({ ...base, HIVEMEM_TS_PERSISTENCE: "qdrant" }).config.persistence, "qdrant");
    assert.match(resolveConfig({ ...base, HIVEMEM_TS_PERSISTENCE: "none" }).problems[0] ?? "", /HIVEMEM_TS_PERSISTENCE must be "qdrant".*or "memory"/);
  });

  it("keeps an explicit storage path and otherwise uses HIVE_HOME/memory", () => {
    const base = { HIVEMEM_JWT_SECRET: secret() };
    assert.equal(resolveConfig({ ...base, HIVEMEM_STORAGE_PATH: "/var/opt/hivemem", HIVE_HOME: "/tmp/other" }).config.storagePath, "/var/opt/hivemem");
    assert.equal(resolveConfig({ ...base, HIVE_HOME: "/tmp/hive-test" }).config.storagePath, "/tmp/hive-test/memory");
    assert.equal(defaultStoragePath({ HOME: "/tmp/example-home" }).endsWith("/.hive/memory"), true);
  });

  it("keeps the established port precedence and names an invalid port variable", () => {
    const base = { HIVEMEM_JWT_SECRET: secret(), HIVE_HOME: "/tmp/hive-test" };
    assert.equal(resolveConfig({ ...base, HIVEMEM_WEB_PORT: "18443", PORT: "9" }).config.port, 18443);
    assert.equal(resolveConfig({ ...base, HIVEMEM_TS_CORE_PORT: "20001", HIVEMEM_WEB_PORT: "18443" }).config.port, 20001);
    assert.match(resolveConfig({ ...base, HIVEMEM_WEB_PORT: "https" }).problems[0] ?? "", /^HIVEMEM_WEB_PORT must be a port number/);
  });

  it("rejects half-configured or unreadable TLS instead of silently serving HTTP", () => {
    const base = { HIVEMEM_JWT_SECRET: secret(), HIVE_HOME: "/tmp/hive-test" };
    assert.match(resolveConfig({ ...base, HIVEMEM_TLS_CERT_FILE: "/tmp/cert.pem" }).problems[0] ?? "", /Set both HIVEMEM_TLS_CERT_FILE and HIVEMEM_TLS_KEY_FILE/);
    const missing = resolveConfig({ ...base, HIVEMEM_TS_TLS_CERT_FILE: "/nonexistent/server.crt", HIVEMEM_TS_TLS_KEY_FILE: "/nonexistent/server.key" });
    assert.equal(missing.problems.length, 2);
    assert.match(missing.problems[0] ?? "", /^HIVEMEM_TS_TLS_CERT_FILE points to \/nonexistent\/server.crt/);
  });

  it("reports an incomplete embedding configuration at startup", () => {
    const { problems } = resolveConfig({ HIVEMEM_JWT_SECRET: secret(), HIVE_HOME: "/tmp/hive-test", HIVEMEM_EMBEDDING_ENDPOINT: "https://embeddings.example.com/v1/embeddings" });
    assert.match(problems[0] ?? "", /^HIVEMEM_EMBEDDING_ENDPOINT is set but the embedding config is invalid/);
  });

  it("describes Qdrant failures with a fix", async () => {
    const rejected = await probeQdrant("http://qdrant.example.com:6333", "fake-key", 1000, (async () => new Response("{}", { status: 401 })) as typeof fetch);
    assert.equal(rejected.ok, false);
    assert.match(rejected.detail, /QDRANT_API_KEY/);
    const reachable = await probeQdrant("http://admin:hunter2@qdrant.example.com:6333", undefined, 1000, (async () => new Response(JSON.stringify({ result: { collections: [{ name: "a" }] } }), { status: 200 })) as typeof fetch);
    assert.equal(reachable.ok, true);
    assert.doesNotMatch(reachable.detail, /hunter2/);
    const down = await probeQdrant(`http://127.0.0.1:${await closedPort()}`, undefined, 2000);
    assert.equal(down.ok, false);
    assert.match(down.detail, /HIVEMEM_TS_PERSISTENCE=memory/);
  });

  it("publishes an env schema the launcher can generate env files from", () => {
    const schema = envSchema();
    assert.equal(schema.service, "memory");
    assert.equal(schema.package, "@hivemagnus/hivemem-server");
    assert.equal(schema.version, packageJson.version);
    assert.equal(schema.defaultPort, DEFAULT_PORT);
    assert.equal(schema.healthPath, HEALTH_PATH);
    assert.deepEqual(schema.dependencies.map((dependency) => [dependency.name, dependency.envVar, dependency.default]), [["qdrant", "HIVEMEM_QDRANT_URL", "http://127.0.0.1:6333"]]);
    assert.match(schema.dependencies[0]?.docker ?? "", /^docker run .*qdrant\/qdrant:v\d+\.\d+\.\d+$/);
    const names = schema.env.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length);
    for (const required of ["HIVEMEM_JWT_SECRET", "HIVEMEM_WEB_PORT", "HIVEMEM_TS_CORE_HOST", "HIVEMEM_STORAGE_PATH", "HIVEMEM_TS_PERSISTENCE", "HIVEMEM_QDRANT_URL", "HIVEMEM_TLS_CERT_FILE", "HIVEMEM_TLS_KEY_FILE", "HIVEMEM_EMBEDDING_ENDPOINT"]) assert.ok(names.includes(required), required);
    assert.deepEqual(schema.env.filter((entry) => entry.required).map((entry) => entry.name), ["HIVEMEM_JWT_SECRET"]);
    assert.equal(schema.env.find((entry) => entry.name === "HIVEMEM_JWT_SECRET")?.generate, "hex32");
    for (const entry of schema.env) assert.ok(entry.description.length > 10, entry.name);
  });
});

describe("hivemem-server command", () => {
  it("prints version, help, and env-schema without configuration", () => {
    assert.equal(packageJson.bin["hivemem-server"], "dist/src/cli.js");
    const version = runCli(["--version"], {});
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), packageJson.version);
    const help = runCli(["--help"], {});
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: hivemem-server/);
    const schema = runCli(["env-schema"], {});
    assert.equal(schema.status, 0);
    assert.equal((JSON.parse(schema.stdout) as { service: string }).service, "memory");
    const unknown = runCli(["serve"], {});
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown command serve/);
  });

  it("ships an executable bin with a node shebang", async () => {
    assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node\n/);
    assert.notEqual((await stat(cli)).mode & 0o111, 0);
  });

  it("fails fast with one line and no stack trace when the JWT secret is missing", async () => {
    await withTempDir(async (directory) => {
      const result = runCli([], { HOME: directory, HIVE_HOME: directory });
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim().split("\n").length, 1);
      assert.match(result.stderr, /^hivemem-server: HIVEMEM_JWT_SECRET is not set; generate one with `openssl rand -hex 32`/);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    });
  });

  it("refuses to start when Qdrant is unreachable instead of silently keeping data in memory", async () => {
    await withTempDir(async (directory) => {
      const result = runCli(["start"], { HOME: directory, HIVE_HOME: directory, HIVEMEM_JWT_SECRET: secret(), HIVEMEM_QDRANT_URL: `http://127.0.0.1:${await closedPort()}`, HIVEMEM_WEB_PORT: String(await closedPort()) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^hivemem-server: Cannot reach Qdrant at .*HIVEMEM_TS_PERSISTENCE=memory/);
      assert.doesNotMatch(result.stdout, /listening/);
    });
  });

  it("check reports problems and exits 1, then passes for a valid volatile configuration without writing data", async () => {
    await withTempDir(async (directory) => {
      const failing = runCli(["check"], { HOME: directory, HIVE_HOME: directory, HIVEMEM_QDRANT_URL: `http://127.0.0.1:${await closedPort()}` });
      assert.equal(failing.status, 1);
      assert.match(failing.stdout, /FAIL {2}HIVEMEM_JWT_SECRET is not set/);
      assert.match(failing.stdout, /FAIL {2}Cannot reach Qdrant/);
      const envFile = join(directory, "memory.env");
      await writeFile(envFile, `HIVEMEM_JWT_SECRET=${secret()}\nHIVEMEM_TS_PERSISTENCE=qdrant\n`);
      // Variables that are already set win over the env file.
      const passing = runCli(["check", "--env-file", envFile], { HOME: directory, HIVE_HOME: directory, HIVEMEM_TS_PERSISTENCE: "memory" });
      assert.equal(passing.status, 0, passing.stdout + passing.stderr);
      assert.match(passing.stdout, /Result: ready to start/);
      assert.match(passing.stdout, /will be created/);
      await assert.rejects(stat(join(directory, "memory")));
      const missingFile = runCli(["check", "--env-file", join(directory, "absent.env")], { HOME: directory });
      // Node itself pre-checks --env-file arguments and exits non-zero naming the file.
      assert.notEqual(missingFile.status, 0);
      assert.match(missingFile.stderr, /absent\.env/);
    });
  });

  it("starts with the explicit volatile opt-in, creates a private storage directory, serves health, and stops on SIGTERM", async () => {
    await withTempDir(async (directory) => {
      const port = await closedPort();
      const child = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, HOME: directory, HIVE_HOME: directory, HIVEMEM_JWT_SECRET: secret(), HIVEMEM_TS_PERSISTENCE: "memory", HIVEMEM_WEB_PORT: String(port), HIVEMEM_WORKER_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      try {
        let health: Response | undefined;
        for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
          if (child.exitCode !== null) break;
          health = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`).catch(() => undefined);
          if (!health) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(health, output);
        assert.equal(health.status, 200);
        assert.equal(((await health.json()) as { status: string }).status, "ok");
        assert.match(output, /data is kept in memory only/);
        assert.equal((await stat(join(directory, "memory"))).mode & 0o777, 0o700);
      } finally {
        child.kill("SIGTERM");
      }
      assert.equal(await exited, 0, output);
    });
  });
});
