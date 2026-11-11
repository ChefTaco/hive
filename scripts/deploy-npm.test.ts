import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployTargets, parseOptions, readConfig, rpcCommand, shellQuote, type Adapter, type Config, type Inventory, type ModelReport } from './deploy-npm.ts';
const env = {HIVE_NPM_DEPLOY_TARGETS:'[{"name":"primary","host":"hive.example.com"},{"name":"secondary","host":"memory.example.com"}]', DEPLOY_USERNAME:'deploy', DEPLOY_SSH_KEY:'/opt/fixture/key', HIVE_E2E_PROVIDER_URL:'http://client.example.com:8000', HIVE_E2E_MODEL:'example-model', HIVE_E2E_USERNAME:'admin', HIVE_E2E_PASSWORD:'dummy-password'};
const config = readConfig(env);
const inventory = (version = '1.2.1'): Inventory => ({host:'fixture',machine:'fixture-machine',node:'v24.22.3',projects:[{base:'/opt/hive-npm',current:'releases/previous',versions:{'@hivemagnus/hive':version}}],services:{'hive-router':{component:'router',switches:{HIVE_AUTO_UPGRADE:'false'}}}});
function fixture(options: {failBackup?:boolean; failModel?:boolean; cleanup?:boolean; version?:string; failPreflight?:boolean; terminal?:string} = {}) {
  const events: string[] = []; const states = new Map<string, string[]>();
  const report: ModelReport = {success:!options.failModel,checks:[{passed:true}],cleanup:[{passed:!options.cleanup}]};
  const adapter: Adapter = {
    rpc: async (target, payload) => {
      events.push(target.name + ':' + payload.operation);
      if (payload.operation === 'inspect') return {...inventory(options.version),machine:target.name};
      if (payload.operation === 'prepare') states.set(target.name, ['awaiting-backup-copy','awaiting-model-checks',options.terminal || 'complete']);
      if (payload.operation === 'status') return {phase:states.get(target.name)?.shift() || 'code-reverted', backup:{sha256:'fixture-hash'}};
      return {};
    },
    backup: async target => {events.push(target.name+':download'); if (options.failBackup) throw Error('Corrupted backup');},
    model: async target => {events.push(target.name+':model'); return report;},
    preflight: async target => {events.push(target.name+':preflight');if(options.failPreflight)throw Error('Missing model token');},
    sleep: async () => {}, progress: () => {},
  };
  return {events,adapter};
}
const run = (adapter: Adapter, mode: 'apply'|'dry-run'|'verify-only' = 'apply') => deployTargets(config,{version:'1.2.2',mode},adapter,{}, {}, 'fixture-transaction');

test('CLI requires an exact stable release and one explicit mode; defaults to read-only', () => {
  assert.deepEqual(parseOptions(['--to','1.2.1']),{version:'1.2.1',mode:'dry-run'});
  for(const version of ['latest','1','1.2.3-beta','1.2.3;id','01.2.3'])assert.throws(()=>parseOptions(['--to',version]));
  assert.throws(()=>parseOptions(['--to','1.2.1','--apply','--dry-run']));
});
test('untrusted host/user targets cannot become SSH options or shell syntax, with private values omitted', () => {
  for(const host of ['-oProxyCommand=id','example.com;id','a@hive.example.com','$(id)']){
    assert.throws(()=>readConfig({...env,HIVE_NPM_DEPLOY_TARGETS:JSON.stringify([{name:'primary',host}])}),error=>error instanceof Error&&!error.message.includes(host));
  }
  assert.throws(()=>readConfig({...env,DEPLOY_USERNAME:'deploy;id'}));
  assert.throws(()=>readConfig({...env,HIVE_NPM_DEPLOY_TARGETS:'[{"name":"primary","host":"example.com"},{"name":"secondary","host":"EXAMPLE.COM"}]'}));
  assert.throws(()=>readConfig({...env,DEPLOY_PASSWORD:'dummy\ncommand'}));
  assert.throws(()=>readConfig({...env,HIVE_E2E_PROVIDER_URL:'http://dummy-secret@example.com'}));
  assert.equal(shellQuote("a'b"),"'a'\\''b'");
  const command=rpcCommand({...config,password:'dummy-private-credential'} as Config);
  assert.ok(!command.includes('dummy-private-credential'));assert.match(command,/sudo -k -S/);
});
test('dry-run inspects every host without prepare, downloads, writes or inference', async () => {
  const f=fixture();await run(f.adapter,'dry-run');assert.deepEqual(f.events,['primary:inspect','primary:preflight','secondary:inspect','secondary:preflight']);
});
test('all preflights pass before mutations, then each installation accepts backup and model cleanup before the next starts', async () => {
  const f=fixture();await run(f.adapter);const sequence=f.events;
  assert.ok(sequence.indexOf('secondary:preflight')<sequence.indexOf('primary:prepare'));
  assert.ok(sequence.indexOf('primary:download')<sequence.indexOf('primary:backup-ack'));
  assert.ok(sequence.indexOf('primary:model-ack')<sequence.indexOf('secondary:prepare'));
});
test('backup corruption refuses acknowledgement, requests conservative recovery and leaves the next installation alone', async () => {
  const f=fixture({failBackup:true});await assert.rejects(run(f.adapter),/Corrupted/);
  assert.ok(!f.events.includes('primary:backup-ack'));assert.ok(f.events.includes('primary:reject'));assert.ok(!f.events.includes('secondary:prepare'));
});
test('model failure or failed cleanup cannot accept a transaction or start another host', async () => {
  for(const options of [{failModel:true},{cleanup:true}]){const f=fixture(options);await assert.rejects(run(f.adapter));assert.ok(!f.events.includes('primary:model-ack'));assert.ok(!f.events.includes('secondary:prepare'));assert.ok(f.events.includes('primary:reject'));}
});
test('major/downgrade transitions and missing preflight credentials fail before mutations', async () => {
  for(const options of [{version:'2.0.0'},{version:'1.3.0'},{failPreflight:true}]){const f=fixture(options);await assert.rejects(run(f.adapter));assert.ok(!f.events.some(x=>x.endsWith(':prepare')));}
});
test('matching targets verify live instead of reinstalling, and verify-only never stages code', async () => {
  for(const mode of ['apply','verify-only'] as const){const f=fixture({version:'1.2.2'});await run(f.adapter,mode);assert.ok(!f.events.some(x=>x.endsWith(':prepare')));assert.equal(f.events.filter(x=>x.endsWith(':model')).length,2);}
});
test('interrupted or incompatible host transaction is never considered successful', async () => {
  const f=fixture({terminal:'recovery-required'});await assert.rejects(run(f.adapter),/recovery-required/);assert.ok(!f.events.includes('secondary:prepare'));
});

test('two DNS names for the same machine fail before any transaction is prepared', async () => {
  const f=fixture(),previous=f.adapter.rpc;
  f.adapter.rpc=async(target,payload)=>payload.operation==='inspect'?inventory():previous(target,payload);
  await assert.rejects(run(f.adapter),/same installation/);assert.ok(!f.events.some(x=>x.endsWith(':prepare')));
});

test('a host outside the target release Node engine is refused before preparing a transaction', async () => {
  const {readFileSync}=await import('node:fs');
  const pkg=JSON.parse(readFileSync(new URL('../packages/hive/package.json',import.meta.url),'utf8')) as unknown;
  const f=fixture(),previous=f.adapter.rpc;
  f.adapter.rpc=async(target,payload)=>payload.operation==='inspect'?{...inventory(),node:'v22.0.0',machine:target.name}:previous(target,payload);
  await assert.rejects(deployTargets(config,{version:'1.2.2',mode:'apply'},f.adapter,{'@hivemagnus/hive':pkg},{},'fixture-transaction'),/Node engine/);
  assert.ok(!f.events.some(x=>x.endsWith(':prepare')));
});

test('slow host progress after an acknowledgement never repeats backup downloads or model resource creation', async () => {
  const f=fixture(),previous=f.adapter.rpc,phases=new Map<string,string[]>();
  f.adapter.rpc=async(target,payload)=>{
    if(payload.operation==='prepare')phases.set(target.name,['awaiting-backup-copy','awaiting-backup-copy','awaiting-backup-copy','awaiting-model-checks','awaiting-model-checks','complete']);
    if(payload.operation==='status')return{phase:phases.get(target.name)?.shift()||'code-reverted',backup:{sha256:'fixture-hash'}};
    return previous(target,payload);
  };
  await run(f.adapter);
  for(const name of ['primary','secondary']){
    assert.equal(f.events.filter(event=>event===name+':download').length,1);
    assert.equal(f.events.filter(event=>event===name+':model').length,1);
  }
});

test('losing the prepare response still requests recovery by the exact transaction ID', async () => {
  const f=fixture(),previous=f.adapter.rpc;
  f.adapter.rpc=async(target,payload)=>{const result=await previous(target,payload);if(payload.operation==='prepare')throw Error('Synthetic lost response');return result;};
  await assert.rejects(run(f.adapter),/lost response/);
  assert.ok(f.events.includes('primary:reject'));assert.ok(!f.events.includes('secondary:prepare'));
});
