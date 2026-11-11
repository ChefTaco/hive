import {test} from 'node:test';
import assert from 'node:assert/strict';
import {translateLegacyConfig,managedUnit,validateConfig} from './migrate-legacy-ardent.mjs';
const config=()=>({id:'12345678-1234-1234-1234-123456789012',owner:'operator',profiles:['assistant'],legacyPackage:'@legacy/ardent',legacyVersion:'0.1.0',version:'3.0.0',archive:'/opt/upgrade/runtime.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64'),recordRoot:'/var/lib/ardent-migrations',agentRoot:'/opt/magnus-agent'});
test('legacy channel conversion preserves every unrelated byte and refuses ambiguous ownership',()=>{
 const text='profile: assistant\nchannels:\n  chattermost:\n    enabled: true\n    token_env: CHAT_TOKEN\n  telegram:\n    enabled: false\n';
 const next=translateLegacyConfig(text);assert.equal(next,text.replace('  chattermost:','  mattermost:'));assert.equal(translateLegacyConfig(next),next);
 assert.throws(()=>translateLegacyConfig(text+'  mattermost:\n    enabled: true\n'));assert.throws(()=>translateLegacyConfig(text+'  chattermost:\n    enabled: false\n'));
});
test('managed unit migration changes only the reviewed package path',()=>{
 const old=managedUnit('/opt/operator','assistant','@legacy/ardent'),next=managedUnit('/opt/operator','assistant','@hivemagnus/ardent');assert.equal(next,old.replace('/@legacy/ardent/','/@hivemagnus/ardent/'));
 for(const [home,profile,pkg]of [['/opt/operator\nExecStart=/bin/sh','assistant','@legacy/ardent'],['/opt/operator','../../other','@legacy/ardent'],['/opt/operator','assistant','@legacy/../other']])assert.throws(()=>managedUnit(home,profile,pkg));
});
test('explicit version, owner, profiles, integrity and bounded paths are mandatory',()=>{
 assert.deepEqual(validateConfig(config()),config());
 for(const delta of [{profiles:[]},{profiles:['assistant','assistant']},{profiles:['../other']},{owner:'root; id'},{legacyPackage:'@hivemagnus/ardent'},{version:'latest'},{version:'2.3.1'},{archive:'/opt/../etc/shadow'},{integrity:'sha256-fixture'},{unreviewedSetting:true}])assert.throws(()=>validateConfig({...config(),...delta}));
});

test('runtime dependency receipts bind the target tarball and refuse alternate origins or missing integrity',async()=>{
 const {validateDependencyLock}=await import('./migrate-legacy-ardent.mjs');const c=config();const fixture=()=>({lockfileVersion:3,packages:{'':{name:'fixture'},'node_modules/@hivemagnus/ardent':{version:c.version,resolved:'file:package.tgz',integrity:c.integrity},'node_modules/fixture':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',integrity:'sha512-fixture'}}});
 validateDependencyLock(fixture(),c);
 for(const delta of [{resolved:'https://example.com/fixture.tgz'},{resolved:'file:../other'},{integrity:undefined}]){const f=fixture();Object.assign(f.packages['node_modules/fixture'],delta);assert.throws(()=>validateDependencyLock(f,c));}
 const f=fixture();f.packages['node_modules/@hivemagnus/ardent'].integrity='sha512-substituted';assert.throws(()=>validateDependencyLock(f,c));
});

test('recovery never replays promotion or cancels a transferred runtime',async()=>{
 const {assertRecoveryPhase}=await import('./migrate-legacy-ardent.mjs');
 for(const phase of ['held','awaiting-auth'])for(const action of ['finish','check-held','start-for-auth'])assertRecoveryPhase({phase,failedPhase:'activated'},action);
 for(const phase of ['new','prepared','backed-up','promoting','activated','complete','cancelled'])assert.throws(()=>assertRecoveryPhase({phase,failedPhase:'activated'},'finish'));
 for(const phase of ['prepared','backed-up'])assertRecoveryPhase({phase},'cancel-before-promotion');
 for(const failedPhase of ['prepared','quiesced','backed-up'])assertRecoveryPhase({phase:'held',failedPhase},'cancel-before-promotion');
 for(const failedPhase of ['stopping','promoting','activated','complete'])assert.throws(()=>assertRecoveryPhase({phase:'held',failedPhase},'cancel-before-promotion'));
 assert.throws(()=>assertRecoveryPhase({phase:'held',failedPhase:'backed-up',retainedRuntime:'/opt/retained'},'cancel-before-promotion'));
});
test('management availability cannot disguise unrelated readiness failures',async()=>{
 const {classifyReadiness}=await import('./migrate-legacy-ardent.mjs');const c={execution:{backend:'codex'},providers:{codex:{auth_mode:'chatgpt'}}};
 assert.deepEqual(classifyReadiness(c,503,{problems:['Codex login required']}),{ready:false,requiresCodexLogin:true});assert.deepEqual(classifyReadiness(c,200,{status:'ready',problems:[]}),{ready:true});
 for(const [status,body]of [[200,{status:'ready',problems:['Codex login required']}],[503,{problems:['Codex login required','Database unavailable']}],[503,{problems:[]}],[401,{problems:['Codex login required']}],[200,{status:'starting',problems:[]}]])assert.throws(()=>classifyReadiness(c,status,body));
 assert.throws(()=>classifyReadiness({...c,execution:{backend:'other'}},503,{problems:['Codex login required']}));assert.throws(()=>classifyReadiness({...c,providers:{codex:{auth_mode:'api_key'}}},503,{problems:['Codex login required']}));
});
test('observer quiescence permits only explicit unique user services and timers',()=>{
 validateConfig({...config(),quiesceUserUnits:['observer.timer','observer.service']});
 for(const units of [['observer.timer','observer.timer'],['../observer.service'],['--all.service'],['ardent@assistant.service'],['observer.socket'],'observer.timer'])assert.throws(()=>validateConfig({...config(),quiesceUserUnits:units}));
 assert.throws(()=>validateConfig({...config(),id:'12345678---------------------------'}));
});

test('disabled legacy jobs become external in a new revision without changing work or admission',async()=>{
 const {translateDisabledJobs}=await import('./migrate-legacy-ardent.mjs');
 const original={schema_version:1,profile:'assistant',revision:4,jobs:[{id:'retained',owner:'hermes',enabled:false,handler:'fixture',input:{retained:true}},{id:'managed',owner:'ardent',enabled:true}]};const text=JSON.stringify(original);const next=JSON.parse(translateDisabledJobs(text));
 assert.deepEqual(next,{...original,revision:5,jobs:[{...original.jobs[0],owner:'external'},original.jobs[1]]});assert.equal(translateDisabledJobs(JSON.stringify(next)),JSON.stringify(next));
 for(const delta of [{owner:'hermes',enabled:true},{owner:'unknown',enabled:false},{owner:'hermes',enabled:undefined}])assert.throws(()=>translateDisabledJobs(JSON.stringify({...original,jobs:[{...original.jobs[0],...delta}]})));
 assert.throws(()=>translateDisabledJobs(JSON.stringify({...original,revision:Number.MAX_SAFE_INTEGER})));
});


test('capability checker paths and digests must be explicit and pinned',()=>{
 validateConfig({...config(),compatibilityCheck:{path:'/opt/upgrade/parity.mjs',sha256:'a'.repeat(64)}});
 for(const compatibilityCheck of [null,[],{path:'relative.mjs',sha256:'a'.repeat(64)},{path:'/opt/../etc/parity.mjs',sha256:'a'.repeat(64)},{path:'/opt/parity.mjs',sha256:'latest'},{path:'/opt/parity.mjs',sha256:'a'.repeat(64),unreviewed:true}])assert.throws(()=>validateConfig({...config(),compatibilityCheck}));
});
