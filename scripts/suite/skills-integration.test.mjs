import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,mkdirSync,chmodSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { generateKeyPairSync,sign,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const helper=resolve(import.meta.dirname,'skills-integration-host.sh'),sha=value=>createHash('sha256').update(value).digest('hex');
test('verifies signed client metadata and protected exact registry bindings without executing a client',()=>{
 const dir=mkdtempSync(join(tmpdir(),'skills-integration-'));try{
 const pair=generateKeyPairSync('ed25519'),artifact={version:'1.2.2',url:'https://artifacts.example.com/client.tgz',sha256:'a'.repeat(64),nodeVersion:'v24.22.3',files:Object.fromEntries(['hermes-sync.mjs','archive-utils.mjs','LICENSE','NOTICE'].map(name=>[name,'b'.repeat(64)]))};
 const manifest=JSON.stringify({nativeClients:{hiveskills:artifact}});writeFileSync(join(dir,'manifest.fixture.json'),manifest);writeFileSync(join(dir,'signature.fixture'),sign(null,Buffer.from(manifest),pair.privateKey));writeFileSync(join(dir,'trust.fixture.pub'),pair.publicKey.export({type:'spki',format:'pem'}));
 const token='obviously-fake-registry-token-for-fixture';writeFileSync(join(dir,'token'),token,{mode:0o600});
 const target={target:'fixture-target',host:'fixture-host',nodeId:'fixture-node',agentTarget:'fixture-native',owner:'operator',home:'/opt/operator',hermesHome:'/opt/hermes',environmentFile:'/protected/native.env',clientDirectory:'/opt/skills-client',nodeBinary:'/usr/bin/node'};
 const input={digest:sha(manifest),skillsDeployment:{registryId:'fixture-registry',clientVersion:'1.2.2',executor:{origin:'https://magnus.example.com',credentialFile:join(dir,'token')},targets:[target]}};writeFileSync(join(dir,'input.json'),JSON.stringify(input));
 const bin=join(dir,'bin');mkdirSync(bin);writeFileSync(join(bin,'curl'),'#!/bin/bash\ncat >/dev/null\ncat "$FIXTURE_REPLY"\n',{mode:0o755});
 const config={registryId:'fixture-registry',registryTarget:'fixture-target',owner:target.owner,home:target.home,hermesHome:target.hermesHome,envFile:target.environmentFile,syncScript:target.clientDirectory+'/'+artifact.sha256+'/hermes-sync.mjs',nodeBinary:target.nodeBinary};
 const configurationSha256=sha(JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a],[b])=>a.localeCompare(b))))),reply={registryId:'fixture-registry',target:target.target,nodeId:target.nodeId,agentTarget:target.agentTarget,ready:true,configurationSha256,clientSha256:'b'.repeat(64)};writeFileSync(join(dir,'reply.json'),JSON.stringify(reply));
 const invoke=command=>spawnSync('bash',['-c','set -euo pipefail; source "$HELPER"; directory=$FIXTURE_DIR; plan=fixture; host=fixture-host; input=$(cat "$directory/input.json"); '+command],{encoding:'utf8',env:{...process.env,HELPER:helper,FIXTURE_DIR:dir,FIXTURE_REPLY:join(dir,'reply.json'),PATH:bin+':'+process.env.PATH}});
 const prepared=invoke('skills_integration_configuration');assert.equal(prepared.status,0,prepared.stderr);const result=JSON.parse(prepared.stdout);assert.equal(result.magnusGrants['fixture-registry'].tokenSha256,sha(token));assert.equal(result.nativeTargets['fixture-native'].syncScript,config.syncScript);assert.ok(!prepared.stdout.includes(token));
 assert.equal(invoke('skills_integration_verify_executor').status,0);
 for(const change of [{ready:false},{nodeId:'different-node'},{configurationSha256:'c'.repeat(64)},{clientSha256:'c'.repeat(64)}]){writeFileSync(join(dir,'reply.json'),JSON.stringify({...reply,...change}));assert.equal(invoke('skills_integration_verify_executor').status,2)}
 chmodSync(join(dir,'token'),0o644);assert.notEqual(invoke('skills_integration_token_digest').status,0);chmodSync(join(dir,'token'),0o600);
 writeFileSync(join(dir,'manifest.fixture.json'),manifest+' ');assert.notEqual(invoke('skills_integration_configuration').status,0);assert.equal(readFileSync(join(dir,'token'),'utf8'),token);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('optional configuration fails closed and preparation never activates proposals',()=>{
 const dir=mkdtempSync(join(tmpdir(),'skills-command-'));try{
 const target={target:'fixture-target',host:'control',nodeId:'fixture-node',agentTarget:'fixture-native',owner:'operator',home:'/opt/operator',hermesHome:'/opt/hermes',environmentFile:'/protected/native.env',clientDirectory:'/opt/skills-client',nodeBinary:'/usr/bin/node'};
 const config={schema:1,installation:'fixture',release:'1.2.2',profile:'custom',origin:'https://console.example.com',hosts:{control:{target:'local',directory:'/opt/fixture'}},components:{hiveskills:{host:'control'},magnus:{host:'control'}},agents:[],inference:[],skillsDeployment:{registryId:'fixture-registry',clientVersion:'1.2.2',executor:{origin:'https://magnus.example.com',credentialFile:'/protected/registry-token'},targets:[target]}};
 const input=join(dir,'input.json');const invoke=(script)=>spawnSync('bash',['-c','set -euo pipefail; source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/skills-integration.sh"; HIVE_CONFIG=$INPUT; '+script],{encoding:'utf8',env:{...process.env,ROOT:resolve(import.meta.dirname,'../..'),INPUT:input,TEST_DIR:dir}});
 writeFileSync(input,JSON.stringify(config));assert.equal(invoke('hive_validate').status,0);
 for(const value of [{...config,skillsDeployment:{...config.skillsDeployment,unexpected:'forbidden'}},{...config,skillsDeployment:{...config.skillsDeployment,targets:[target,target]}},{...config,skillsDeployment:{...config.skillsDeployment,targets:[{...target,host:'missing-host'}]}},{...config,components:{hiveskills:{host:'control'}}}]){writeFileSync(input,JSON.stringify(value));assert.notEqual(invoke('hive_validate').status,0)}
 writeFileSync(input,JSON.stringify(config));writeFileSync(join(dir,'release'),'synthetic-public-manifest');
 const script='HIVE_MANIFEST=$TEST_DIR/release; HIVE_SIGNATURE=$TEST_DIR/release; HIVE_TRUST_KEY=$TEST_DIR/release; hive_skills_action(){ if [[ $2 == token ]]; then printf "%064d\\n" 0; else printf "%s\\n" "$2" >> "$TEST_DIR/actions"; [[ $2 != verify ]]; fi; }; hive_skills_prepare';
 const result=invoke(script);assert.equal(result.status,2);assert.match(result.stderr,/No mapping was activated/);assert.equal(readFileSync(join(dir,'actions'),'utf8'),'preflight\nstage\nproposal\nverify\n');assert.ok(!result.stdout.includes('synthetic-public-manifest'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
