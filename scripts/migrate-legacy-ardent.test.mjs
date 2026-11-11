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

test('reviewed extension plans bind every profile without alternate plugins, traversal or unpinned packages',async()=>{
 const {validateExtensions,translatedProfileConfig,preservedJobs}=await import('./migrate-legacy-ardent.mjs');const c={...config(),version:'3.1.0'};
 const fixture=()=>({packages:[{name:'@example/extension',version:'1.0.0',archive:'/opt/upgrade/extension.tgz',integrity:c.integrity}],profiles:{assistant:{plugins:['@example/extension'],files:[{source:'/opt/upgrade/binding.json',target:'.extensions/example/bindings.json',sha256:'a'.repeat(64)}]}}});
 assert.deepEqual(validateExtensions(fixture(),c),fixture());validateConfig({...c,extensions:fixture()});
 for(const mutate of [e=>delete e.profiles.assistant,e=>e.packages.push(e.packages[0]),e=>e.packages[0].name='@hivemagnus/ardent',e=>e.packages[0].version='latest',e=>e.profiles.assistant.plugins=['@example/other'],e=>e.profiles.assistant.plugins=['@example/extension/../other'],e=>e.profiles.assistant.files[0].target='.extensions/example/../../config.yaml',e=>e.profiles.assistant.files[0].source='/opt/../etc/shadow',e=>e.profiles.assistant.files.push(e.profiles.assistant.files[0]),e=>e.profiles.assistant.unreviewed=true]){const e=fixture();mutate(e);assert.throws(()=>validateExtensions(e,c));}
 assert.throws(()=>validateExtensions(fixture(),config()));
 const text='profile: assistant\n# owner policy\nchannels:\n  chattermost:\n    enabled: true\n';const target=translatedProfileConfig(text,fixture().profiles.assistant);assert.equal(target,text.replace('chattermost:','mattermost:')+'plugins: ["@example/extension"]\n');assert.throws(()=>translatedProfileConfig('plugins: ["existing"]\n',fixture().profiles.assistant));
 const jobs=' {"revision":4,"jobs":[{"id":"other-owner","owner":"hermes","enabled":false}]}\n';assert.equal(preservedJobs(jobs,'3.1.0'),jobs);assert.equal(JSON.parse(preservedJobs(jobs,'3.0.3')).revision,5);
});

test('extension dependency locks pin all local archives and reject nested host runtimes',async()=>{
 const {validateDependencyLock}=await import('./migrate-legacy-ardent.mjs');const c={...config(),version:'3.1.0',extensions:{packages:[{name:'@example/extension',version:'1.0.0',integrity:config().integrity}]}};
 const fixture=()=>({lockfileVersion:3,packages:{'':{},'node_modules/@hivemagnus/ardent':{version:c.version,integrity:c.integrity,resolved:'file:core-package.tgz'},'node_modules/@example/extension':{version:'1.0.0',integrity:c.integrity,resolved:'file:extension-0.tgz'}}});validateDependencyLock(fixture(),c);
 for(const mutate of [l=>delete l.packages['node_modules/@example/extension'],l=>l.packages['node_modules/@example/extension'].resolved='file:/other.tgz',l=>l.packages['node_modules/@example/extension'].integrity='sha512-different',l=>l.packages['node_modules/@example/extension/node_modules/@hivemagnus/ardent']={version:'3.0.0',integrity:c.integrity,resolved:'https://registry.npmjs.org/ardent.tgz'},l=>l.packages['node_modules/@example/extension'].link=true]){const l=fixture();mutate(l);assert.throws(()=>validateDependencyLock(l,c));}
});

test('large recovery hashes stream without changing digest or accepting symlink aliases',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');const {fileHash}=await import('./migrate-legacy-ardent.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ardent-digest-'));
 try{const file=path.join(dir,'archive'),bytes=Buffer.alloc(3*1024*1024+37,42);fs.writeFileSync(file,bytes);assert.equal(fileHash(file),crypto.createHash('sha256').update(bytes).digest('hex'));fs.symlinkSync(file,path.join(dir,'alias'));assert.throws(()=>fileHash(path.join(dir,'alias')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('streamed journal proofs retain binary, unknown state and stable key order and detect every original-column mutation',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {journalSnapshot}=await import('./migrate-legacy-ardent.mjs');const db=new DatabaseSync(':memory:');
 try{db.exec('CREATE TABLE journal(id TEXT PRIMARY KEY,state TEXT,bytes BLOB); CREATE TABLE keyed(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID');db.prepare('INSERT INTO journal VALUES(?,?,?)').run('retained','unknown',Buffer.from([0,255,3]));db.exec("INSERT INTO keyed VALUES('b',2),('a',1)");
 const original=journalSnapshot(db);assert.equal(original.journal.count,1);assert.equal(original.keyed.count,2);
 db.exec('ALTER TABLE journal ADD COLUMN additive TEXT; CREATE TABLE extension(id TEXT)');assert.deepEqual(journalSnapshot(db,original).journal,original.journal);assert.deepEqual(journalSnapshot(db,original).keyed,original.keyed);
 db.prepare('UPDATE journal SET bytes=?').run(Buffer.from([0,255,4]));assert.notEqual(journalSnapshot(db,original).journal.sha256,original.journal.sha256);db.prepare('UPDATE journal SET bytes=?').run(Buffer.from([0,255,3]));db.exec("UPDATE journal SET state='completed'");assert.notEqual(journalSnapshot(db,original).journal.sha256,original.journal.sha256);db.exec('DELETE FROM keyed');assert.equal(journalSnapshot(db,original).keyed.count,0);
 }finally{db.close();}
});
