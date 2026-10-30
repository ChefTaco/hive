import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ensureRuntimeManifest, NATIVE_MODULES, nativeModuleProblems, runtimeManifest } from "../src/runtime.js";
import { installFakeServers, tempHome } from "./helpers.js";

describe("npm 12 install scripts", () => {
  it("allows exactly the servers' native add-ons", () => {
    assert.deepEqual(NATIVE_MODULES, ["argon2", "better-sqlite3"]);
    const fresh = runtimeManifest(null);
    assert.equal(fresh["private"], true);
    assert.deepEqual(fresh["allowScripts"], { argon2: true, "better-sqlite3": true, "msgpackr-extract": false });
  });

  it("keeps existing entries, including a deliberate false", () => {
    const merged = runtimeManifest({ name: "hive-runtime", private: true, allowScripts: { argon2: false, sharp: true }, dependencies: { x: "1.0.0" } });
    assert.deepEqual(merged["allowScripts"], { argon2: false, sharp: true, "better-sqlite3": true, "msgpackr-extract": false });
    assert.deepEqual(merged["dependencies"], { x: "1.0.0" });
  });

  it("adds the allowlist to a runtime folder created by an older launcher", () => {
    const { paths, cleanup } = tempHome();
    try {
      mkdirSync(paths.runtime, { recursive: true });
      writeFileSync(join(paths.runtime, "package.json"), JSON.stringify({ name: "hive-runtime", private: true, dependencies: { "@hivemagnus/hive-router": "^1.0.0" } }));
      ensureRuntimeManifest(paths);
      const manifest = JSON.parse(readFileSync(join(paths.runtime, "package.json"), "utf8")) as Record<string, unknown>;
      assert.deepEqual(manifest["allowScripts"], { argon2: true, "better-sqlite3": true, "msgpackr-extract": false });
      assert.deepEqual(manifest["dependencies"], { "@hivemagnus/hive-router": "^1.0.0" });
      assert.equal(statSync(join(paths.runtime, "package.json")).mode & 0o777, 0o600);
    } finally {
      cleanup();
    }
  });

  it("reports native add-ons that do not load", () => {
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths, ["memory", "router"]);
      assert.deepEqual(nativeModuleProblems(paths, "memory"), []);
      const problems = nativeModuleProblems(paths, "router");
      assert.equal(problems.length, 1);
      assert.equal(problems[0]?.module, "better-sqlite3");
      assert.match(problems[0]?.error ?? "", /Cannot find module/u);
      // A loadable stand-in counts as working.
      const fake = join(paths.runtime, "node_modules", "better-sqlite3");
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
      writeFileSync(join(fake, "index.js"), "module.exports = class { close() {} };\n");
      assert.deepEqual(nativeModuleProblems(paths, "router"), []);
    } finally {
      cleanup();
    }
  });
});
