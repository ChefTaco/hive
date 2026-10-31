import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { parseEnv } from "node:util";
import { parseFlags } from "../src/args.js";
import { dockerCommandLine, parseDockerRun } from "../src/docker.js";
import { EnvDocument, quote, writePrivateFile } from "../src/envfile.js";
import { CliError, UsageError } from "../src/errors.js";
import { mask } from "../src/output.js";
import { hivePaths } from "../src/paths.js";
import { createPrompter } from "../src/prompt.js";
import { envFileArgs, findTarball, serverEnvironment, tarballPrefix } from "../src/runtime.js";
import { parseServerSchema } from "../src/schema.js";
import { parseServiceList } from "../src/services.js";
import { compareVersions, launcherVersion, satisfiesCaretRange, serverRange } from "../src/version.js";
import { recordingOutput, tempHome } from "./helpers.js";

describe("env files", () => {
  it("edits values in place and keeps comments and unrelated lines", () => {
    const doc = new EnvDocument("# a comment\nA=1\nB=two\nA=3\n");
    assert.equal(doc.get("A"), "3");
    doc.set("A", "4");
    doc.set("C", "/path with spaces/x");
    assert.equal(doc.toString(), "# a comment\nB=two\nA=4\nC='/path with spaces/x'\n");
    assert.deepEqual(doc.values(), { B: "two", A: "4", C: "/path with spaces/x" });
    assert.equal(new EnvDocument("EMPTY=\n").get("EMPTY"), undefined);
  });

  it("quotes only when needed, in a form Node's --env-file parser reads back", () => {
    for (const value of ["abc123", "https://localhost:9443/api/auth/oidc/callback", "redis://127.0.0.1:6379", "it's", 'say "hi"', "a b#c"]) {
      assert.equal(parseEnv(`X=${quote(value)}\n`).X, value, value);
    }
    assert.equal(quote("plain"), "plain");
    assert.throws(() => quote("two\nlines"), /line breaks/);
    assert.throws(() => quote('dummy-private-value\'"'), (error: Error) => !error.message.includes("dummy-private-value"));
  });

  it("writes owner-only files in owner-only directories", () => {
    const { paths, cleanup } = tempHome();
    try {
      const file = join(paths.config, "x.env");
      writePrivateFile(file, "A=1\n");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(paths.config).mode & 0o777, 0o700);
      writePrivateFile(file, "A=2\n");
      assert.equal(EnvDocument.load(file).get("A"), "2");
    } finally {
      cleanup();
    }
  });
});

describe("arguments and names", () => {
  it("parses flags in both forms and rejects unknown ones", () => {
    const flags = parseFlags(["--port", "memory=1", "--port=iam=2", "-y", "router", "--from=/tmp/x"], { "--port": "repeat", "--yes": "boolean", "--from": "string" }, "init");
    assert.deepEqual(flags.repeats.get("--port"), ["memory=1", "iam=2"]);
    assert.ok(flags.booleans.has("--yes"));
    assert.equal(flags.strings.get("--from"), "/tmp/x");
    assert.deepEqual(flags.positionals, ["router"]);
    assert.throws(() => parseFlags(["--nope"], {}, "init"), UsageError);
    assert.throws(() => parseFlags(["--from"], { "--from": "string" }, "init"), /needs a value/);
  });

  it("parses service lists into start order", () => {
    assert.deepEqual(parseServiceList(["router,memory"]), ["memory", "router"]);
    assert.deepEqual(parseServiceList(["all"]), ["iam", "memory", "router"]);
    assert.deepEqual(parseServiceList(["router", "iam"]), ["iam", "router"]);
    assert.throws(() => parseServiceList(["mem"]), /unknown service "mem"/);
  });

  it("pins the servers to the launcher's major version and checks the engines range", () => {
    assert.match(launcherVersion(), /^\d+\.\d+\.\d+/);
    assert.equal(serverRange(), `^${launcherVersion().split(".")[0]}.0.0`);
    const range = "^24.22.1 || ^26.13.0";
    assert.ok(satisfiesCaretRange("24.22.1", range));
    assert.ok(satisfiesCaretRange("v24.30.0", range));
    assert.ok(satisfiesCaretRange("26.13.0", range));
    assert.ok(!satisfiesCaretRange("24.21.9", range));
    assert.ok(!satisfiesCaretRange("25.0.0", range));
    assert.ok(!satisfiesCaretRange("22.12.0", range));
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  });

  it("masks secrets in change summaries", () => {
    assert.equal(mask("0123456789abcdef"), "0123••••");
    assert.equal(mask("short"), "••••");
  });
});

describe("docker one-liners", () => {
  it("reads the servers' commands and rewrites the name, port and volume", () => {
    const qdrant = parseDockerRun("docker run -d --name hive-qdrant -p 127.0.0.1:6333:6333 -v hive-qdrant:/qdrant/storage qdrant/qdrant:v1.18.1");
    assert.deepEqual(qdrant, { name: "hive-qdrant", image: "qdrant/qdrant:v1.18.1", hostIp: "127.0.0.1", hostPort: 6333, containerPort: 6333, volume: { name: "hive-qdrant", target: "/qdrant/storage" } });
    const redis = parseDockerRun("docker run -d --name hive-redis -p 127.0.0.1:6379:6379 redis:7.4.7-alpine");
    assert.ok(redis);
    assert.equal(dockerCommandLine({ ...redis, name: "test-redis", hostPort: 16379 }), "docker run -d --name test-redis -p 127.0.0.1:16379:6379 redis:7.4.7-alpine");
    assert.equal(parseDockerRun("docker run --rm -it redis"), null);
    assert.equal(parseDockerRun("podman run x"), null);
  });
});

describe("server packages", () => {
  it("finds the newest tarball of the launcher's major version", () => {
    const { paths, cleanup } = tempHome();
    try {
      const dir = paths.home;
      for (const name of ["hivemagnus-hive-router-1.0.0.tgz", "hivemagnus-hive-router-1.2.0.tgz", "hivemagnus-hive-router-2.0.0.tgz", "hivemagnus-hive-1.5.0.tgz"]) writeFileSync(join(dir, name), "");
      assert.equal(tarballPrefix("@hivemagnus/hive-router"), "hivemagnus-hive-router");
      assert.equal(findTarball(dir, "@hivemagnus/hive-router", 1), join(dir, "hivemagnus-hive-router-1.2.0.tgz"));
      assert.equal(findTarball(dir, "@hivemagnus/hivemem-server", 1), null);
      assert.throws(() => findTarball(join(dir, "missing"), "@hivemagnus/hive-router", 1), CliError);
    } finally {
      cleanup();
    }
  });

  it("passes only a small allowlist of the launcher's environment to the servers", () => {
    const paths = hivePaths({ HIVE_HOME: "/tmp/hive-test-home" });
    const env = serverEnvironment(paths, { PATH: "/usr/bin", HOME: "/tmp/example-home", LC_ALL: "C", PORT: "1", NODE_ENV: "test", DATABASE_URL: "file:/x.db", HTTPS_PROXY: "http://proxy.example.com:3128", NODE_OPTIONS: "--inspect" });
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/tmp/example-home", LC_ALL: "C", HTTPS_PROXY: "http://proxy.example.com:3128", HIVE_HOME: "/tmp/hive-test-home" });
  });

  it("refuses to pass a missing env file, which Node would reject with exit code 9", () => {
    const paths = hivePaths({ HIVE_HOME: "/tmp/hive-test-missing" });
    assert.throws(() => envFileArgs(paths, "memory"), /memory.env does not exist; run `hive init`/);
  });

  it("validates env-schema documents and names the field that is wrong", () => {
    const schema = parseServerSchema("iam", JSON.stringify({ service: "iam", defaultPort: 4200, healthPath: "/h", dependencies: [{ name: "redis", envVar: "REDIS_URL", default: "redis://localhost:6379", docker: "docker run x" }], env: [{ name: "A", required: true, secret: true, generate: "hex32", description: "d" }] }));
    assert.equal(schema.stores[0]?.name, "redis");
    assert.equal(schema.env[0]?.generate, "hex32");
    assert.throws(() => parseServerSchema("iam", "not json"), /did not print JSON/);
    assert.throws(() => parseServerSchema("iam", JSON.stringify({ service: "router" })), /no valid "service"/);
  });
});

describe("prompts", () => {
  it("--yes takes each default without reading input", async () => {
    const output = recordingOutput();
    const prompter = createPrompter({ yes: true, output, input: Object.assign(new PassThrough(), { isTTY: false }) });
    assert.equal(await prompter.confirm("Install?", true), true);
    assert.equal(await prompter.confirm("Also set up iam?", false), false);
    assert.equal(await prompter.ask("Services", "memory,router,iam"), "memory,router,iam");
    assert.match(output.text(), /Install\? \[Y\/n\] yes \(--yes\)/);
  });

  it("fails with a clear message instead of waiting when stdin is not a terminal", async () => {
    const prompter = createPrompter({ yes: false, output: recordingOutput(), input: Object.assign(new PassThrough(), { isTTY: false }) });
    await assert.rejects(prompter.confirm("Install?"), (error: unknown) => error instanceof CliError && /not a terminal\. Re-run with --yes/.test(error.message));
  });

  it("reads answers from a terminal, keeps answers typed ahead, and re-asks on nonsense", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const terminal = new PassThrough();
    const prompter = createPrompter({ yes: false, output: recordingOutput(), input, terminal });
    input.write("maybe\nn\n\nrouter\n");
    assert.equal(await prompter.confirm("Install?", true), false);
    assert.equal(await prompter.confirm("Start Redis?", true), true);
    assert.equal(await prompter.ask("Services", "all"), "router");
    prompter.close();
    assert.match(terminal.read().toString(), /\? Install\? \[Y\/n\] /);
  });
});
