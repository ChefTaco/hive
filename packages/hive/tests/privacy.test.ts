import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EnvDocument, writePrivateFile } from "../src/envfile.js";
import { runInit } from "../src/init.js";
import { displayUrl } from "../src/privacy.js";
import { scriptedPrompter } from "../src/prompt.js";
import { collectStatus, printStatus } from "../src/status.js";
import { fakeRedis, installFakeServers, recordingOutput, tempHome } from "./helpers.js";

describe("launcher diagnostic privacy", () => {
  it("removes URL credentials, queries and fragments without losing the endpoint", () => {
    assert.equal(displayUrl("redis://alice:dummy-password@localhost:6379/0?token=dummy-query#dummy-fragment"), "redis://localhost:6379/0");
    assert.equal(displayUrl("https://alice:dummy-password@memory.example.com/collections?key=dummy-query"), "https://memory.example.com/collections");
    assert.equal(displayUrl("dummy-invalid-url"), "[invalid URL]");
    assert.equal(displayUrl("data:text/plain,dummy-private"), "[invalid URL]");
  });

  it("keeps configured credentials in the env file and out of init and status reports", async () => {
    const redis = await fakeRedis();
    const { paths, cleanup } = tempHome();
    try {
      installFakeServers(paths, ["iam"]);
      const url = new URL(redis.url);
      url.username = "alice";
      url.password = "dummy-password";
      url.search = "token=dummy-query";
      url.hash = "dummy-fragment";
      const output = recordingOutput();
      const init = () => runInit({ paths, output, prompter: scriptedPrompter(["y"]), options: { services: ["iam"], tls: false, dockerPrefix: "hive-test", ports: {}, redisUrl: url.toString() }, isFree: async () => true });
      await init();
      // Re-run with an existing configuration so the change summary is exercised too.
      const doc = EnvDocument.load(paths.envFile("iam"));
      doc.set("REDIS_URL", redis.url);
      writePrivateFile(paths.envFile("iam"), doc.toString());
      await init();
      assert.equal(EnvDocument.load(paths.envFile("iam")).get("REDIS_URL"), url.toString());
      const status = await collectStatus(paths);
      printStatus(status, output);
      assert.doesNotMatch(output.text() + JSON.stringify(status), /dummy-password|dummy-query|dummy-fragment/);
      assert.equal(status.services[0]?.store?.url, redis.url);
    } finally {
      cleanup();
      await redis.close();
    }
  });
});
