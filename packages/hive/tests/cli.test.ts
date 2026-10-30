import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EnvDocument, writePrivateFile } from "../src/envfile.js";
import { runInit } from "../src/init.js";
import type { HivePaths } from "../src/paths.js";
import { scriptedPrompter } from "../src/prompt.js";
import { fakeQdrant, fakeRedis, freePort, installFakeServers, recordingOutput, tempHome } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string; bin: Record<string, string> };

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, NO_COLOR: "1", ...env }, encoding: "utf8", timeout: 30_000, input: "" });
}

describe("hive command", () => {
  it("prints its version and help", () => {
    assert.equal(packageJson.bin.hive, "dist/src/cli.js");
    assert.match(readFileSync(cli, "utf8"), /^#!\/usr\/bin\/env node\n/);
    assert.notEqual(statSync(cli).mode & 0o111, 0);
    assert.equal(run(["--version"]).stdout.trim(), packageJson.version);
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    for (const command of ["init", "start", "status", "doctor", "install"]) assert.match(help.stdout, new RegExp(`\\n  ${command} `));
    for (const command of ["init", "start", "status", "doctor", "install"]) {
      const commandHelp = run([command, "--help"]);
      assert.equal(commandHelp.status, 0, command);
      assert.match(commandHelp.stdout, new RegExp(`^Usage: hive ${command}`));
    }
  });

  it("reports usage errors on one line with exit code 2", () => {
    const unknown = run(["serve"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr.trim(), "✗ hive: unknown command serve; run `hive --help`");
    const badFlag = run(["init", "--colour"]);
    assert.equal(badFlag.status, 2);
    assert.match(badFlag.stderr, /unknown option --colour for `hive init`/);
    assert.match(run(["init", "--port", "nope=1"]).stderr, /--port takes <name>=<port>/);
    assert.match(run(["start", "bogus"]).stderr, /unknown service "bogus"/);
  });

  it("refuses to wait for answers when stdin is not a terminal", () => {
    const { paths, cleanup } = tempHome();
    try {
      const result = run(["init"], { HIVE_HOME: paths.home });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /standard input is not a terminal\. Re-run with --yes/);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    } finally {
      cleanup();
    }
  });

  it("explains what to do when nothing is configured or installed", () => {
    const { paths, cleanup } = tempHome();
    try {
      const status = run(["status"], { HIVE_HOME: paths.home });
      assert.equal(status.status, 1);
      assert.match(status.stdout, /No services are configured\. Run `hive init`/);
      const start = run(["start"], { HIVE_HOME: paths.home });
      assert.equal(start.status, 1);
      assert.match(start.stderr, /no services are configured; run `hive init` first/);
      assert.match(run(["start", "router"], { HIVE_HOME: paths.home }).stderr, /router is not configured/);
    } finally {
      cleanup();
    }
  });
});

describe("hive start, status and doctor", () => {
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

  async function configured(): Promise<{ paths: HivePaths; cleanup: () => void }> {
    const home = tempHome();
    installFakeServers(home.paths);
    const ports = { memory: await freePort(), iam: await freePort(), router: await freePort(), "router-admin": await freePort() };
    await runInit({ paths: home.paths, output: recordingOutput(), prompter: scriptedPrompter([]), options: { services: ["memory", "router", "iam"], tls: false, ports, dockerPrefix: "hive-test", qdrantUrl: qdrant.url, redisUrl: redis.url }, platform: "linux", username: "alice" });
    rmSync(`${home.paths.home}/events.log`, { force: true });
    return home;
  }

  function startLauncher(paths: HivePaths) {
    const child = spawn(process.execPath, [cli, "start"], { env: { PATH: process.env.PATH, NO_COLOR: "1", HIVE_HOME: paths.home, PORT_LEAK_CHECK: "1", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    return { child, exited, output: () => output };
  }

  async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const events = (paths: HivePaths) => (existsSync(`${paths.home}/events.log`) ? readFileSync(`${paths.home}/events.log`, "utf8").trim().split("\n") : []);

  it("starts in dependency order, renews a missing token, reports status, and stops in reverse order", async () => {
    const { paths, cleanup } = await configured();
    try {
      const router = EnvDocument.load(paths.envFile("router"));
      router.set("HIVE_ROUTER_MEMORY_PROXY_TOKEN", "");
      writePrivateFile(paths.envFile("router"), router.toString());
      const launcher = startLauncher(paths);
      await waitFor(() => launcher.output().includes("Hive is running"), "all services");
      assert.deepEqual(events(paths), ["issue-token", "start iam token=no", "start memory token=no", "start router token=yes"]);
      assert.match(launcher.output(), /^iam {4}│ iam listening on/m);
      assert.match(launcher.output(), /^router │ router listening on/m);
      assert.ok(EnvDocument.load(paths.envFile("router")).get("HIVE_ROUTER_MEMORY_PROXY_TOKEN"));

      const status = run(["status", "--json"], { HIVE_HOME: paths.home });
      assert.equal(status.status, 0, status.stdout + status.stderr);
      const report = JSON.parse(status.stdout) as { ok: boolean; launcher: { running: boolean }; services: Array<{ service: string; listeners: Array<{ healthy: boolean }> }> };
      assert.equal(report.ok, true);
      assert.equal(report.launcher.running, true);
      assert.equal(report.services.flatMap((service) => service.listeners).length, 4);

      const doctor = run(["doctor"], { HIVE_HOME: paths.home });
      assert.match(doctor.stdout, /ok {4}memory: hivemem-server check passed/);
      assert.match(doctor.stdout, /is served by the running router/);

      const second = run(["start"], { HIVE_HOME: paths.home });
      assert.equal(second.status, 1);
      assert.match(second.stderr, /hive start is already running \(pid \d+\)/);

      launcher.child.kill("SIGTERM");
      assert.equal(await launcher.exited, 0, launcher.output());
      assert.deepEqual(events(paths).slice(4), ["stop router SIGTERM", "stop memory SIGTERM", "stop iam SIGTERM"]);
      assert.ok(!existsSync(paths.pidFile));
      assert.ok(!events(paths).some((line) => line.startsWith("leaked")), "the launcher's environment is not passed through");
      const down = run(["status"], { HIVE_HOME: paths.home });
      assert.equal(down.status, 1);
      assert.match(down.stdout, /down {2}memory/);
    } finally {
      cleanup();
    }
  });

  it("stops the other services and exits 1 when one dies", async () => {
    const { paths, cleanup } = await configured();
    try {
      writeFileSync(`${paths.home}/crash-memory`, "");
      const launcher = startLauncher(paths);
      assert.equal(await launcher.exited, 1, launcher.output());
      assert.match(launcher.output(), /memory exited unexpectedly \(exit code 3\); stopping the other services/);
      const log = events(paths);
      assert.ok(log.includes("crash memory"));
      assert.ok(log.includes("stop iam SIGTERM"));
      assert.ok(!log.some((line) => line.startsWith("start router")) || log.includes("stop router SIGTERM"));
    } finally {
      cleanup();
    }
  });

  it("starts only the services asked for", async () => {
    const { paths, cleanup } = await configured();
    try {
      const child = spawn(process.execPath, [cli, "start", "memory"], { env: { PATH: process.env.PATH, NO_COLOR: "1", HIVE_HOME: paths.home }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      await waitFor(() => output.includes("Hive is running"), "memory");
      child.kill("SIGINT");
      assert.equal(await exited, 0);
      assert.deepEqual(events(paths), ["start memory token=no", "stop memory SIGTERM"]);
    } finally {
      cleanup();
    }
  });
});
