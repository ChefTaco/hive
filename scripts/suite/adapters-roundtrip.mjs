#!/usr/bin/env node
// Synthetic HTTPS protocol/artifact acceptance; not real-agent integration acceptance.
import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../..'),
  temporary = mkdtempSync(join(tmpdir(), 'hive-adapters-'));
const environment = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const plan = 'a'.repeat(64),
  directory = join(temporary, 'installation');
const put = (path, value) => {
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  chmodSync(path, 0o600);
};
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', env: environment, ...options });
let server,
  passed = false;
try {
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(temporary, 'profile'), { mode: 0o700 });
  mkdirSync(join(temporary, 'bundle', 'bin'), { recursive: true, mode: 0o700 });
  put(
    join(temporary, 'profile', 'credential.env'),
    'EXAMPLE_SCOPED_CREDENTIAL=fixture-native-credential\n',
  );
  const launcher = join(temporary, 'bundle', 'bin', 'launcher');
  put(launcher, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  chmodSync(launcher, 0o700);
  run('tar', ['-czf', join(temporary, 'agent.tgz'), '-C', join(temporary, 'bundle'), 'bin']);
  const artifactSHA = createHash('sha256')
    .update(readFileSync(join(temporary, 'agent.tgz')))
    .digest('hex');
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temporary, 'server.key'),
      '-out',
      join(temporary, 'server.crt'),
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-days',
      '1',
    ],
    { stdio: 'ignore' },
  );
  put(
    join(temporary, 'fixture.mjs'),
    `import https from 'node:https';import fs from 'node:fs';import path from 'node:path';
const base=process.argv[2],providers=[],aliases=[];let creates=0,aliasCreates=0;
const server=https.createServer({key:fs.readFileSync(path.join(base,'server.key')),cert:fs.readFileSync(path.join(base,'server.crt'))},async(req,res)=>{
 if(req.url==='/agent.tgz'){res.end(fs.readFileSync(path.join(base,'agent.tgz')));return;}
 if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'fixture-model'}]}));return;}
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
 let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):null;
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/chat'){if(body.stream){res.setHeader('Content-Type','application/x-ndjson');res.write(JSON.stringify({message:{content:'OK'},done:false})+'\\n');setTimeout(()=>res.end(JSON.stringify({done:true})+'\\n'),30);}else res.end(JSON.stringify({message:{content:'OK'},done:true}));return;}
 if(req.url==='/v1/chat/completions'){if(body.stream){res.setHeader('Content-Type',fs.existsSync(path.join(base,'bad-stream-type'))?'application/json':'text/event-stream');res.write('data: '+JSON.stringify({choices:[{delta:{content:'OK'}}]})+'\\n\\n');setTimeout(()=>res.end('data: [DONE]\\n\\n'),30);}else res.end(JSON.stringify({choices:[{message:{content:fs.existsSync(path.join(base,'fail-generation'))?null:'OK'}}]}));return;}
 if(req.headers.authorization!=='Bearer obviously-fake-test-enrollment'){res.statusCode=401;res.end('{}');return;}
 if(req.url==='/api/emberpath/providers')req.url='/api/providers';
 if(req.url==='/api/emberpath/model-aliases')req.url='/api/model-aliases';
 if(req.url==='/api/providers'){if(req.method==='POST'){creates++;const provider={...body,id:'provider-'+creates};providers.push(provider);fs.writeFileSync(path.join(base,'counts.json'),JSON.stringify({creates,aliasCreates}));if(body.slug==='uncertain'){res.destroy();return;}res.end(JSON.stringify({data:provider}));}else res.end(JSON.stringify({data:providers}));return;}
 if(req.url==='/api/model-aliases'){if(req.method==='POST'){aliasCreates++;aliases.push({...body,id:'alias-'+aliasCreates});fs.writeFileSync(path.join(base,'counts.json'),JSON.stringify({creates,aliasCreates}));res.end(JSON.stringify({data:aliases.at(-1)}));}else res.end(JSON.stringify({data:aliases}));return;}
 res.statusCode=404;res.end('{}');
});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
`,
  );
  server = spawn(process.execPath, [join(temporary, 'fixture.mjs'), temporary], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [chunk] = await once(server.stdout, 'data'),
    endpoint = 'https://localhost:' + String(chunk).trim();
  put(
    join(temporary, 'authorization.header'),
    'Authorization: Bearer obviously-fake-test-enrollment\n',
  );
  environment.CURL_CA_BUNDLE = join(temporary, 'server.crt');
  put(join(directory, 'installation.json'), {
    installation: 'fixture',
    host: 'control',
    uuid: 'fixture-installation',
  });
  put(join(directory, 'transaction.json'), { plan, phase: 'ready', operation: 'install' });
  put(join(directory, 'receipt.json'), { plan, version: '0.1.0' });
  const manifest = {
    agentArtifacts: {
      magnus: {
        '2.0.0': {
          [process.arch === 'arm64' ? 'arm64' : 'amd64']: {
            url: endpoint + '/agent.tgz',
            sha256: artifactSHA,
            executable: 'bin/launcher',
            arguments: ['@PROFILE@', '@ENV_FILE@', 'literal $(must-not-run) argument'],
          },
        },
      },
    },
  };
  put(join(directory, 'manifest.' + plan + '.json'), manifest);
  const input = {
    directory,
    installation: 'fixture',
    host: 'control',
    plan,
    version: '0.1.0',
    operation: 'install',
    action: 'adapters-stage',
    agents: [
      {
        id: 'fixture-agent',
        runtime: 'magnus',
        version: '2.0.0',
        profileDirectory: join(temporary, 'profile'),
        environmentFile: join(temporary, 'profile', 'credential.env'),
        service: 'none',
        authorized: false,
      },
    ],
    inference: [],
  };
  const code = ['adapters-host.sh', 'inference-registration.sh', 'host-runtime.sh']
    .map((file) => readFileSync(join(root, 'scripts/suite', file), 'utf8'))
    .join('\n');
  function action(payload, expected = true) {
    const result = spawnSync('bash', ['-c', code], {
      input: JSON.stringify(payload) + '\n',
      encoding: 'utf8',
      env: environment,
    });
    put(join(temporary, 'last-action.log'), result.stdout + '\n' + result.stderr);
    assert.equal(result.status === 0, expected, result.stderr.slice(-1600));
  }
  action(input);
  action(input);
  const installed = JSON.parse(
    readFileSync(join(directory, 'agents', 'fixture-agent', 'candidate.' + plan + '.json')),
  );
  assert.equal(installed.artifactSHA256, artifactSHA);
  assert.equal(installed.accepted, false);
  assert.equal(
    readFileSync(join(temporary, 'profile', 'credential.env'), 'utf8'),
    'EXAMPLE_SCOPED_CREDENTIAL=fixture-native-credential\n',
  );
  const args = run('bash', [join(directory, 'agents', 'fixture-agent', 'run.' + plan)])
    .trim()
    .split('\n');
  assert.equal(args[2], 'literal $(must-not-run) argument');
  input.agents = [];
  input.action = 'adapters-accept';
  const inference = {
    id: 'fixture-model',
    host: 'control',
    engine: 'openai',
    protocol: 'openai',
    endpoint,
    caFile: join(temporary, 'server.crt'),
    model: { id: 'fixture-model' },
    registration: {
      endpoint,
      caFile: join(temporary, 'server.crt'),
      credentialFile: join(temporary, 'authorization.header'),
      providerSlug: 'fixture-provider',
      aliases: ['fixture-alias'],
    },
  };
  input.inference = [inference];
  action(input);
  action(input);
  assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'counts.json'))), {
    creates: 1,
    aliasCreates: 1,
  });
  put(join(temporary, 'fail-generation'), 'fixture');
  input.inference = [
    {
      ...inference,
      id: 'failed-model',
      registration: { ...inference.registration, providerSlug: 'failed-provider' },
    },
  ];
  action(input, false);
  assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'counts.json'))), {
    creates: 1,
    aliasCreates: 1,
  });
  rmSync(join(temporary, 'fail-generation'));
  input.inference = [
    {
      ...inference,
      id: 'uncertain-model',
      registration: { ...inference.registration, providerSlug: 'uncertain' },
    },
  ];
  action(input, false);
  action(input, false);
  assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'counts.json'))), {
    creates: 2,
    aliasCreates: 1,
  });
  assert.equal(
    JSON.parse(
      readFileSync(join(directory, 'inference-checks', 'uncertain-model', 'registration.json')),
    ).phase,
    'create-started',
  );
  input.inference = [
    {
      ...inference,
      id: 'ingress-model',
      registration: {
        ...inference.registration,
        apiPrefix: '/api/emberpath',
        providerSlug: 'ingress-provider',
        aliases: ['ingress-alias'],
      },
    },
  ];
  action(input);
  action(input);
  assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'counts.json'))), {
    creates: 3,
    aliasCreates: 2,
  });
  // Explicit native Ollama protocol is verified through the same native API
  // Emberpath will use; no pull/create/delete endpoint exists in this fixture.
  input.inference = [
    {
      ...inference,
      id: 'native-ollama',
      engine: 'ollama',
      protocol: 'ollama',
      registration: { ...inference.registration, providerSlug: 'native-ollama', aliases: [] },
    },
  ];
  action(input);
  action(input);
  assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'counts.json'))), {
    creates: 4,
    aliasCreates: 2,
  });
  put(join(temporary, 'bad-stream-type'), 'fixture');
  input.inference = [inference];
  action(input, false);
  assert.equal(
    JSON.parse(
      readFileSync(join(directory, 'inference-checks', 'fixture-model', 'previous-receipt.json')),
    ).streaming,
    true,
  );
  assert.equal(
    (await import('node:fs')).existsSync(
      join(directory, 'inference-checks', 'fixture-model', 'receipt.json'),
    ),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'counts.json'))), {
    creates: 4,
    aliasCreates: 2,
  });
  passed = true;
  console.log(
    'PASS: verified native artifact, preserved profile credentials, literal argument transport, external OpenAI/SSE and Ollama/NDJSON verification, stale receipt rejection, registration ordering/idempotence and unknown-outcome refusal (synthetic provider).',
  );
} finally {
  if (server) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  }
  if (passed) rmSync(temporary, { recursive: true, force: true });
  else console.error('Private adapter evidence retained at ' + temporary);
}
