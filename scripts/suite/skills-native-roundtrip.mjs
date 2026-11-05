#!/usr/bin/env node
// Developer proof: packaged native agent, real Magnus API, isolated PostgreSQL
// and Redis. Never selects an existing host agent, fleet or production service.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  createReadStream,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as createTlsServer, request as tlsRequest } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
const args = process.argv.slice(2),
  options = {};
for (let index = 0; index < args.length; index += 2) {
  assert(['--agent-image', '--server-image', '--skills-root', '--output'].includes(args[index]) && args[index + 1]);
  options[args[index].slice(2)] = args[index + 1];
}
assert(
  /^sha256:[a-f0-9]{64}$/.test(options['agent-image'] ?? '') && options['skills-root'] && options.output && /^sha256:[a-f0-9]{64}$/.test(options['server-image'] ?? ''),
  '--agent-image LOCAL_IMAGE_ID --server-image LOCAL_IMAGE_ID --skills-root PRODUCT_SOURCE --output NEW_PRIVATE_DIRECTORY are required',
);
const root = resolve(import.meta.dirname, '../..'),
  output = resolve(options.output);
assert(!existsSync(output));
assert(process.getuid() !== 0);
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
const put = (name, value, mode = 0o600) => {
  const path = join(output, name);
  writeFileSync(
    path,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2),
  );
  chmodSync(path, mode);
  return path;
};
const run = (command, argv, extra = {}) =>
  execFileSync(command, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...extra,
  }).trim();
const docker = (...argv) => run('docker', argv);
const metadata={architecture:{x64:'amd64',arm64:'arm64'}[process.arch],image:options['agent-image'],version:docker('run','--rm','--entrypoint','node',options['agent-image'],'-p',"require('/opt/magnus-agent/node_modules/@hivemagnus/magnus-agent/package.json').version")};
const id = 'skills-proof-' + randomBytes(5).toString('hex'),
  user = `${process.getuid()}:${process.getgid()}`;
const port = async () => {
  const server = createTcpServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
};
const apiPort = await port(),
  agentPort = await port(),
  apiOrigin = 'https://localhost:' + apiPort,
  profile = join(output, 'profile'),
  installation = join(output, 'installation'),
  config = join(output, 'api-config');
for (const path of [
  profile,
  installation,
  config,
  join(output, 'api-data'),
  join(output, 'redis-data'),
])
  mkdirSync(path, { mode: 0o700 });
const secrets = Object.fromEntries(
  [
    'API_SECRET',
    'JWT_SECRET',
    'NODE_MANAGER_SECRET',
    'AUDIT_HMAC_SECRET',
    'RESULT_SIGNING_SECRET',
    'LOG_INGEST_SIGNING_SECRET',
    'CREDENTIAL_ROTATION_KEY',
    'METRICS_TOKEN',
    'WEBHOOK_ENCRYPTION_KEY',
    'CONTROL_NODE_CREDENTIAL_KEY',
    'POSTGRES_PASSWORD',
    'REDIS_PASSWORD',
  ].map((name) => [name, randomBytes(32).toString('hex')]),
);
const protectedEnvironment = (path, values) => {
  writeFileSync(
    path,
    Object.entries(values)
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
};
const authority = put('authority.pem', ''),
  authorityKey = join(output, 'authority.key');
run('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  authorityKey,
  '-out',
  authority,
  '-subj',
  '/CN=Synthetic native acceptance CA',
  '-days',
  '2',
]);
chmodSync(authorityKey, 0o600);
chmodSync(authority, 0o600);
function certificate(prefix, identities) {
  const key = join(output, prefix + '.key'),
    csr = join(output, prefix + '.csr'),
    cert = join(output, prefix + '.pem'),
    extensions = put(
      prefix + '.extensions',
      'subjectAltName=' + identities.join(',') + '\nextendedKeyUsage=serverAuth\n',
    );
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    '/CN=synthetic-native-fixture',
  ]);
  run('openssl', [
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    authority,
    '-CAkey',
    authorityKey,
    '-set_serial',
    '0x' + randomBytes(16).toString('hex'),
    '-out',
    cert,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  for (const path of [key, csr, cert]) chmodSync(path, 0o600);
  return { key, cert };
}
const apiTls = certificate('api', ['DNS:localhost', 'DNS:api', 'IP:127.0.0.1']);
for (const [name, source] of Object.entries({
  'server.key': apiTls.key,
  'server.pem': apiTls.cert,
  'ca.pem': authority,
}))
  put('api-config/' + name, readFileSync(source));
const apiEnv = {
  ...secrets,
  NODE_ENV: 'production',
  LOG_LEVEL: 'error',
  MAGNUS_HOME: '/data',
  DATABASE_URL: `postgresql://synthetic:${secrets.POSTGRES_PASSWORD}@postgres:5432/magnus_ideas_native`,
  REDIS_URL: `redis://:${secrets.REDIS_PASSWORD}@redis:6379`,
  REDIS_PREFIX: id + ':',
  CONTROL_API_PORT: '4000',
  CONTROL_API_BIND_HOST: '0.0.0.0',
  CONTROL_API_URL: apiOrigin,
  TLS_CERT_PATH: '/config/server.pem',
  TLS_KEY_PATH: '/config/server.key',
  NODE_EXTRA_CA_CERTS: '/config/ca.pem',
  MAGNUS_AUTO_MIGRATE: 'true',
  MAGNUS_AUTO_MIGRATE_BACKUP: 'false',
  MAGNUS_UPDATE_CHECK: 'false',
  MAGNUS_AUTO_UPGRADE: 'false',
  ENABLE_AGENT_DISCOVERY: 'false',
};
delete apiEnv.POSTGRES_PASSWORD;
delete apiEnv.REDIS_PASSWORD;
protectedEnvironment(join(output, 'api.env'), apiEnv);
protectedEnvironment(join(output, 'postgres.env'), {
  POSTGRES_USER: 'synthetic',
  POSTGRES_DB: 'magnus_ideas_native',
  POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD,
});
put(
  'redis.conf',
  `bind 0.0.0.0\nprotected-mode yes\nrequirepass ${secrets.REDIS_PASSWORD}\nappendonly yes\ndir /data\n`,
);
const pgImage = JSON.parse(
    docker('image', 'inspect', 'postgres:17-alpine', '--format', '{{json .RepoDigests}}'),
  )[0],
  redisImage = 'redis@sha256:5fa2edb1e408fa8235e6db8fab01d1afaaae96c9403ba67b70feceb8661e8621';
assert(pgImage?.includes('@sha256:'));
const pgUser = docker(
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  pgImage,
  '-c',
  'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"',
);
const compose = {
  name: id,
  services: {
    postgres: {
      image: pgImage,
      user: pgUser,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      env_file: [join(output, 'postgres.env')],
      volumes: ['postgres:/var/lib/postgresql/data'],
      tmpfs: [
        '/tmp:mode=1777',
        `/var/run/postgresql:uid=${pgUser.split(':')[0]},gid=${pgUser.split(':')[1]},mode=700`,
      ],
      healthcheck: {
        test: ['CMD', 'pg_isready', '-U', 'synthetic', '-d', 'magnus_ideas_native'],
        interval: '2s',
        retries: 30,
      },
    },
    redis: {
      image: redisImage,
      user,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      command: ['redis-server', '/config/redis.conf'],
      volumes: [
        {
          type: 'bind',
          source: join(output, 'redis.conf'),
          target: '/config/redis.conf',
          read_only: true,
        },
        { type: 'bind', source: join(output, 'redis-data'), target: '/data' },
      ],
      tmpfs: ['/tmp:mode=1777'],
      healthcheck: {
        test: [
          'CMD',
          'sh',
          '-c',
          'export REDISCLI_AUTH=$(sed -n "s/^requirepass //p" /config/redis.conf); redis-cli --no-auth-warning ping | grep -q PONG',
        ],
        interval: '2s',
        retries: 30,
      },
    },
    api: {
      image: options['server-image'],
      user,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      env_file: [join(output, 'api.env')],
      volumes: [
        { type: 'bind', source: config, target: '/config', read_only: true },
        { type: 'bind', source: join(output, 'api-data'), target: '/data' },
      ],
      tmpfs: ['/tmp:mode=1777'],
      ports: [`127.0.0.1:${apiPort}:4000`],
      depends_on: {
        postgres: { condition: 'service_healthy' },
        redis: { condition: 'service_healthy' },
      },
      healthcheck: {
        test: [
          'CMD',
          'node',
          '-e',
          "fetch('https://localhost:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: '2s',
        timeout: '5s',
        start_period: '30s',
        retries: 90,
      },
    },
  },
  volumes: { postgres: {} },
};
const composeFile = put('compose.json', compose),
  dc = (...argv) => docker('compose', '-f', composeFile, ...argv);
const request = (path, body, headers = {}) =>
  new Promise((done, reject) => {
    const req = tlsRequest(
      new URL(path, apiOrigin),
      {
        method: body ? 'POST' : 'GET',
        ca: readFileSync(authority),
        headers: {
          'Content-Type': 'application/json',
          'x-api-secret': secrets.API_SECRET,
          ...headers,
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            done({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('Native fixture API timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
const { copyFileSync, openSync, closeSync }=await import('node:fs');
const skillsRoot=resolve(options['skills-root']),scratch=join(output,'scratch'),agentConfig=join(output,'agent-config');
for(const directory of [scratch,agentConfig,join(output,'skills-data'),join(output,'client')])mkdirSync(directory,{mode:0o700});
for(const name of ['LICENSE','NOTICE'])if(existsSync(join(skillsRoot,name)))copyFileSync(join(skillsRoot,name),join(output,'client',name));
for(const name of ['hermes-sync.mjs','archive-utils.mjs'])copyFileSync(join(skillsRoot,'scripts',name),join(output,'client',name));
put('client/runner.mjs',`import {syncSkills} from './hermes-sync.mjs';
import {appendFileSync,writeFileSync} from 'node:fs';
try{await syncSkills({registry:process.env.HIVE_SKILLS_URL,hermesHome:process.env.HERMES_HOME,target:process.env.HIVE_SKILLS_TARGET,token:process.env.HIVE_SKILLS_TARGET_TOKEN,hermesVersion:process.env.HIVE_SKILLS_HERMES_VERSION,frozenManifest:JSON.parse(process.env.HIVE_SKILLS_FROZEN_MANIFEST),restart:()=>{}})}catch(error){writeFileSync('/scratch/client-error.json',JSON.stringify({message:error.message,cause:error.cause?.code,stack:error.stack}),{mode:0o600});throw error}
appendFileSync('/scratch/client-runs.log',process.env.HIVE_SKILLS_TARGET+'\\n');
if(process.env.HIVE_SKILLS_TARGET==='fixture-unknown'){writeFileSync('/scratch/effect-finished','yes');await new Promise(()=>{setInterval(()=>{},1000)});}
`);
docker('tag',options['agent-image'],id+'-input');
put('client/Dockerfile',`FROM ${id+'-input'}\nUSER root\nCOPY . /opt/hive-skills/scripts/\nRUN chmod 755 /opt/hive-skills /opt/hive-skills/scripts && chmod 644 /opt/hive-skills/scripts/*\nUSER node\n`);
docker('build','--quiet','--tag',id+'-agent','--file',join(output,'client/Dockerfile'),join(output,'client'));
const registryPort=await port(),registryOrigin='https://localhost:'+registryPort,executorToken=randomBytes(32).toString('hex'),skillsSecret=randomBytes(32).toString('hex');
const executorFile=put('executor-credential',executorToken);
let skills,passed=false,registryPublic;
function sql(query){return dc('exec','-T','postgres','psql','-U','synthetic','-d','magnus_ideas_native','-At','-v','ON_ERROR_STOP=1','-c',query)}
function ownerCommand(command){return dc('exec','-T','api','magnus-server',command)}
async function skillsRequest(path,body,method=body?'POST':'GET'){return new Promise((done,reject)=>{
 const req=tlsRequest(new URL(path,registryOrigin),{method,ca:readFileSync(authority),timeout:15000,headers:{'content-type':'application/json',cookie:skillsCookie??''}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{try{done({status:res.statusCode,body:raw?JSON.parse(raw):null})}catch{reject(Error('Invalid bounded registry response'))}})});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Registry response timeout')));req.end(body?JSON.stringify(body):undefined);
})}
let skillsCookie;
const wait=async(check,seconds=60)=>{const deadline=Date.now()+seconds*1000;for(;;){if(await check())return;if(Date.now()>deadline)throw Error('Disposable Skills proof readiness deadline exceeded');await new Promise(done=>setTimeout(done,300));}};
try{
 dc('up','-d','--wait','--wait-timeout','300');
 // Actual owner completion verification: no writes/reset on the failed read-only gate.
 ownerCommand('verify-initialization');
 sql("DELETE FROM product_initializations WHERE id='base-data-v1'");
 const missingBefore=sql("SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM users t");
 let refused=false;try{ownerCommand('verify-initialization')}catch{refused=true}assert(refused,'Missing initialization receipt must fail');assert.equal(sql("SELECT count(*) FROM product_initializations WHERE id='base-data-v1'"),'0');assert.equal(sql("SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM users t"),missingBefore);
 ownerCommand('migrate');ownerCommand('verify-initialization');put('initialization-result.json',{result:'passed',missingReceiptRejected:true,readOnlyCheckPreservedUserRows:true,noAutomaticSeed:true,explicitOwnerMigrationRecovered:true});
 const apiContainer=dc('ps','-q','api'),networks=JSON.parse(docker('inspect',apiContainer,'--format','{{json .NetworkSettings.Networks}}')),gateway=Object.values(networks)[0].Gateway;
 const registryTls=certificate('registry',['DNS:localhost','IP:127.0.0.1','IP:'+gateway]);registryPublic='https://'+gateway+':'+registryPort;
 compose.services.agent={image:id+'-agent',user,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],entrypoint:['sh','-c','while [ ! -f /config/ready ]; do sleep 1; done; exec /opt/magnus-agent/node_modules/.bin/magnus-agent start'],env_file:[join(output,'agent.env')],volumes:[{type:'bind',source:agentConfig,target:'/config',read_only:true},{type:'bind',source:scratch,target:'/scratch'}],tmpfs:['/tmp:mode=1777'],environment:{AGENT_INSTALL_DIR:'/scratch/agent-state',NODE_ENV:'production'}};
 const nativeTargets=Object.fromEntries(['normal','unknown'].map(kind=>['native-'+kind,{registryId:'fixture-registry',registryTarget:'fixture-'+kind,owner:'node',home:'/scratch',hermesHome:'/scratch/hermes',envFile:'/scratch/'+kind+'.env',syncScript:'/opt/hive-skills/scripts/runner.mjs',nodeBinary:'/usr/local/bin/node',caFile:'/config/ca.pem'}]));
 protectedEnvironment(join(output,'agent.env'),{NODE_ENV:'production',LOG_LEVEL:'error',CONTROL_API_URL:'https://api:4000',CONTROL_API_CA_PATH:'/config/ca.pem',NODE_MANAGER_SECRET:secrets.NODE_MANAGER_SECRET,RESULT_SIGNING_SECRET:secrets.RESULT_SIGNING_SECRET,HOST_FQDN:'synthetic-agent.example.com',NODE_MANAGER_PORT:'4100',NODE_MANAGER_BIND_HOST:'0.0.0.0',TLS_CERT_PATH:'/config/server.pem',TLS_KEY_PATH:'/config/server.key',MAGNUS_AGENT_PRIVILEGED:'false',MAGNUS_AGENT_SELF_UPGRADE:'false',ENABLE_AGENT_DISCOVERY:'false',HERMES_HOME:'/scratch/hermes',MAGNUS_AGENT_HIVESKILLS_TARGETS_JSON:JSON.stringify(nativeTargets)});
 put('compose.json',compose);dc('up','-d','agent');
 const agentContainer=dc('ps','-q','agent'),agentNetworks=JSON.parse(docker('inspect',agentContainer,'--format','{{json .NetworkSettings.Networks}}')),agentIP=Object.values(agentNetworks)[0].IPAddress;
 const agentTls=certificate('agent',['DNS:agent','DNS:synthetic-agent.example.com','IP:'+agentIP]);
 for(const [name,path]of Object.entries({'server.key':agentTls.key,'server.pem':agentTls.cert,'ca.pem':authority}))put('agent-config/'+name,readFileSync(path));
 const enrollment=await request('/api/v1/nodes/register',{name:'Synthetic Skills agent',hostname:'synthetic-agent.example.com',ipAddress:agentIP,port:4100,os:'linux',arch:metadata.architecture,agentVersion:metadata.version});assert.equal(enrollment.status,201);const nodeId=enrollment.body.data.nodeId;
 // Explicit synthetic pre-enrolled baseline: drain enrollment itself is a separate gate.
 sql(`INSERT INTO resource_enrollments ("nodeId","nodeFqdn",state,epoch,"enrolledAt","updatedAt") VALUES ('${nodeId}','synthetic-agent.example.com','enrolled',1,NOW(),NOW())`);
 apiEnv.MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON=JSON.stringify({'fixture-registry':{tokenSha256:createHash('sha256').update(executorToken).digest('hex'),targets:Object.fromEntries(['normal','unknown'].map(kind=>['fixture-'+kind,{nodeId,agentTarget:'native-'+kind}]))}});protectedEnvironment(join(output,'api.env'),apiEnv);dc('up','-d','--force-recreate','--wait','--wait-timeout','300','api');put('agent-config/ready','yes');
 const log=openSync(put('skills.log',''),'a');skills=spawn(process.execPath,[join(skillsRoot,'dist/server.js')],{cwd:skillsRoot,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',HIVE_SKILLS_HOST:'0.0.0.0',HIVE_SKILLS_PORT:String(registryPort),HIVE_SKILLS_PUBLIC_URL:registryPublic,HIVE_SKILLS_DATA_DIR:join(output,'skills-data'),HIVE_SKILLS_SESSION_SECRET:skillsSecret,HIVE_SKILLS_ADMIN_USERS:'admin',HIVE_SKILLS_TLS_KEY_FILE:registryTls.key,HIVE_SKILLS_TLS_CERT_FILE:registryTls.cert,HIVE_SKILLS_TARGETS:'fixture-normal=deploy@synthetic-agent.example.com,fixture-unknown=deploy@synthetic-agent.example.com',HIVE_AUTO_MIGRATE:'true',HIVE_UPDATE_CHECK:'false',HIVE_SKILLS_MAGNUS_EXECUTOR_JSON:JSON.stringify({url:apiOrigin,credentialFile:executorFile,caFile:authority})},stdio:['ignore',log,log]});closeSync(log);
 await wait(async()=>{try{return(await skillsRequest('/healthz')).status===200}catch{return false}});
 const {DatabaseSync}=await import('node:sqlite'),{createHmac}=await import('node:crypto'),db=new DatabaseSync(join(output,'skills-data/registry.sqlite'));const session=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(session,'admin',new Date(Date.now()+3600000).toISOString(),new Date().toISOString());skillsCookie='hive_skills_session='+session+'.'+createHmac('sha256',skillsSecret).update(session).digest('base64url');
 for(const kind of ['normal','unknown']){const enrolled=await skillsRequest('/admin/targets/fixture-'+kind+'/enroll',{channel:'stable',skills:['fixture-skill']});assert.equal(enrolled.status,201);protectedEnvironment(join(scratch,kind+'.env'),{HIVE_SKILLS_URL:registryPublic,HIVE_SKILLS_TARGET_TOKEN:enrolled.body.token,HIVE_SKILLS_HERMES_VERSION:'0.21.3',NODE_EXTRA_CA_CERTS:'/config/ca.pem'})}
 const source=join(output,'skill-source');mkdirSync(source,{mode:0o700});put('skill-source/SKILL.md','# Synthetic immutable skill\n');const archive=join(output,'fixture.tgz');run('tar',['-czf',archive,'-C',source,'.']);
 assert.equal((await skillsRequest('/admin/skills',{slug:'fixture-skill',name:'Synthetic Skill',description:'Disposable immutable publication',homepage:null,enabled:true})).status,201);
 assert.equal((await skillsRequest('/admin/skills/fixture-skill/releases',{version:'1.0.0',archiveBase64:readFileSync(archive).toString('base64')})).status,201);
 assert.equal((await skillsRequest('/admin/channels/stable/fixture-skill',{version:'1.0.0'},'PUT')).status,200);
 await wait(async()=>{const node=(await request('/api/v1/nodes/'+nodeId)).body.data;return node?.status==='ONLINE'&&Date.now()-Date.parse(node.lastHeartbeatAt)<120000});
 const posture=await request('/api/v1/hiveskills/targets/fixture-normal',null,{authorization:'Bearer '+executorToken});
 assert.equal(posture.status,200);assert.equal(posture.body.ready,true);assert.equal(posture.body.nodeId,nodeId);assert.equal(posture.body.agentTarget,'native-normal');assert.equal(posture.body.clientSha256,createHash('sha256').update(readFileSync(join(output,'client/runner.mjs'))).digest('hex'));assert.equal(posture.body.configurationSha256,createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(nativeTargets['native-normal']).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'));
 const protectedNative=readFileSync(join(scratch,'normal.env'));put('scratch/normal.env',Buffer.concat([protectedNative,Buffer.from('\n'+['NODE_MANAGER_SECRET','obviously-fake-forbidden-native-value'].join('=')+'\n')]));assert.equal((await request('/api/v1/hiveskills/targets/fixture-normal',null,{authorization:'Bearer '+executorToken})).body.ready,false);put('scratch/normal.env',protectedNative);
 put('posture-result.json',{passed:true,readOnly:true,exactNodeAndNativeMapping:true,exactConfigurationAndClientSHA256:true,infrastructureCredentialEnvironmentRejected:true});
 async function prepare(kind){const preview=await skillsRequest('/admin/deployments/fixture-'+kind,{});assert.equal(preview.status,201);const approved=await skillsRequest('/admin/deployments/jobs/'+preview.body.id+'/approve',{publicationSha256:preview.body.publication_sha256});assert.equal(approved.status,202);return preview.body}
 const normal=await prepare('normal');let normalJob;await wait(async()=>{normalJob=(await skillsRequest('/admin/deployments/jobs/'+normal.id)).body;return ['completed','failed','unknown'].includes(normalJob.status)},150);put('normal-job.json',normalJob);assert.equal(normalJob.status,'completed');assert.equal(readFileSync(join(scratch,'hermes/skills/registry/fixture-skill/SKILL.md'),'utf8'),'# Synthetic immutable skill\n');
 const beforeRuns=readFileSync(join(scratch,'client-runs.log'),'utf8');assert.equal((await skillsRequest('/admin/deployments/jobs/'+normal.id+'/approve',{publicationSha256:normal.publication_sha256})).status,409);assert.equal(readFileSync(join(scratch,'client-runs.log'),'utf8'),beforeRuns);
 const uncertain=await prepare('unknown');await wait(async()=>existsSync(join(scratch,'effect-finished')),60);dc('kill','-s','SIGKILL','agent');await wait(async()=>{const job=(await skillsRequest('/admin/deployments/jobs/'+uncertain.id)).body;return job.status==='unknown'},150);dc('up','-d','agent');await wait(async()=>{try{const result=await skillsRequest('/admin/deployments/jobs/'+uncertain.id+'/reconcile',{});return result.status===200&&result.body.status==='unknown'}catch{return false}},60);assert.equal((await skillsRequest('/admin/deployments/fixture-unknown',{})).status,409);assert.equal(readFileSync(join(scratch,'client-runs.log'),'utf8').trim().split('\n').length,2);
 db.close();put('database.sql',dc('exec','-T','postgres','pg_dump','-U','synthetic','-d','magnus_ideas_native'));
 put('result.json',{schema:1,result:'passed',productionCutover:false,images:{agent:options['agent-image'],server:options['server-image']},skillsSourceCommit:run('git',['-C',skillsRoot,'rev-parse','HEAD']),checks:['read-only owning target posture verifies exact native configuration/client digests and rejects infrastructure env','real owning registry preview and one-use approval','dedicated endpoint-scoped Magnus grant','actual enrolled native admission and signed completed receipt','immutable digest-verified skill installed into scratch profile','duplicate approval does not rerun client','real process interruption retains unknown ownership and receipt-only reconciliation without replay','read-only initializer completion verifier refuses missing receipt; explicit owner migration restores it'],limitations:['synthetic pre-enrolled baseline; participant drain enrollment is a separate gate','gateway restart is intentionally a no-op in the scratch-profile client wrapper','containerized packaged native agent on one physical host; native host artifact installation has separate evidence']});passed=true;console.log('PASS: isolated actual Skills registry, Magnus managed admission, native immutable publication and retained unknown receipt.');
}catch(error){try{put('containers.log',dc('logs','--no-color'))}catch{}throw error}finally{if(skills&&skills.exitCode===null){skills.kill('SIGTERM');await Promise.race([new Promise(done=>skills.once('close',done)),new Promise(done=>setTimeout(done,5000))]);if(skills.exitCode===null)skills.kill('SIGKILL')}try{dc('down','--volumes','--remove-orphans')}catch{}if(!passed)console.error('Private Skills proof evidence retained at '+output)}
