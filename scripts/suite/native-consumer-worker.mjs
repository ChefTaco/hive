// Runs only inside the explicitly extracted developer artifact and fresh profile.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const moduleURL = (name) => pathToFileURL(join(input.modules, name + '.js')).href;
const { loadConfig } = await import(moduleURL('config'));
const { ArdentRuntime } = await import(moduleURL('runtime'));
const { MattermostAdapter } = await import(moduleURL('mattermost'));
const { TaskStore } = await import(moduleURL('store'));
const { parseModelPolicy } = await import(moduleURL('model-policy'));
const { exerciseContext } = await import(moduleURL('context-maintenance'));
const env = JSON.parse(readFileSync(input.environment, 'utf8'));
Object.assign(process.env, env);
const { config } = await loadConfig(input.profile);
const runtime = new ArdentRuntime(input.profile, config, env);
const adapter = new MattermostAdapter(runtime, config.channels.mattermost, env);
const abort = new AbortController();
let channelRun;
try {
  const me = await adapter.initialize();
  assert.equal(me.botId, input.botId);
  channelRun = adapter.run(abort.signal);
  // Wait for authenticated WebSocket startup and initial channel reconciliation.
  for (
    let attempt = 0;
    attempt < 100 &&
    runtime.store.cursor(`mattermost:${me.botId}:${input.channelId}:last_ms`) === undefined;
    attempt++
  )
    await new Promise((done) => setTimeout(done, 100));
  assert.notEqual(
    runtime.store.cursor(`mattermost:${me.botId}:${input.channelId}:last_ms`),
    undefined,
  );
  writeFileSync(input.ready, 'ready', { mode: 0o600 });
  while (!readFileSync(input.stop, 'utf8').trim())
    await new Promise((done) => setTimeout(done, 100));
} finally {
  abort.abort();
  await channelRun?.catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  assert(await runtime.drain());
}
const tasks = runtime.store.db.prepare('SELECT id,state,prompt FROM tasks ORDER BY rowid').all();
assert.equal(tasks.length, 1, 'Disallowed chat account must never become an Ardent task');
assert.equal(tasks[0].state, 'completed');
const events = runtime.store.events(tasks[0].id);
writeFileSync(input.events, JSON.stringify(events), { mode: 0o600 });
assert(
  JSON.stringify(events).includes('skill_view'),
  'Actual native task must execute the synced skill tool',
);
assert(!tasks.some((task) => task.prompt.includes('FORBIDDEN-CONSUMER')));
runtime.close();
// A separate fresh context store keeps the real chat journal untouched.
const context = new TaskStore(input.contextDatabase);
try {
  const bytes = JSON.stringify({
    schema_version: 1,
    revision: 1,
    primary: {
      codex: { model: 'synthetic-summary', reasoning_effort: 'low' },
      llamacpp: { mode: 'profile' },
    },
    compaction: {
      enabled: true,
      routes: [{ backend: 'codex', model: 'synthetic-summary', reasoning_effort: 'low' }],
      prompt_budget_tokens: 32000,
      output_reserve_tokens: 8000,
      checkpoint_max_tokens: 4000,
      recent_max_tokens: 8000,
      trigger_ratio: 0.7,
    },
  });
  writeFileSync(input.policy, bytes, { mode: 0o600 });
  const loaded = { ...parseModelPolicy(bytes), path: input.policy };
  const call = async (path, body) => {
    const response = await fetch(input.modelOrigin + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + env.ARDENT_LLAMA_API_KEY,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const result = await exerciseContext(
    context,
    (_route, prompt) => call('/fixture/summary', { prompt }),
    loaded,
    join(input.modules, 'context-checkpoints.js'),
    (messages) => call('/fixture/continue', { messages }),
  );
  const { previous_reader, ...bounded } = result;
  assert.equal(previous_reader, true);
  writeFileSync(
    input.contextResult,
    JSON.stringify({
      ...bounded,
      same_version_reader: true,
      cross_version_reader: 'not exercised',
      summarizer: 'synthetic HTTPS callback; no Codex process or real model',
    }),
    { mode: 0o600 },
  );
} finally {
  context.close();
}
writeFileSync(
  input.result,
  JSON.stringify({
    passed: true,
    nativeTasks: tasks.length,
    executedSkillTool: true,
    forbiddenActorIgnored: true,
  }),
  { mode: 0o600 },
);
