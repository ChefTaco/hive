#!/usr/bin/env node
// A separate, explicit migration of an existing managed Ardent installation.
// It never initializes profiles, rotates credentials or restores a live database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function fileHash(file) {
  regular(file);const h=crypto.createHash('sha256'),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),buffer=Buffer.alloc(1024*1024);
  try {for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null));)h.update(buffer.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd)}
}
function regular(file) { const s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink(),'Expected a regular file');return s; }
function read(file) { regular(file);return fs.readFileSync(file); }
function atomic(file,value,mode=0o600,owner) {
  const tmp=file+'.'+crypto.randomUUID();const fd=fs.openSync(tmp,'wx',mode);
  try {fs.writeFileSync(fd,value);fs.fchmodSync(fd,mode);if(owner)fs.fchownSync(fd,owner.uid,owner.gid);fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
}
export function translateLegacyConfig(text) {
  const lines=text.match(/^  chattermost:/gm)??[];
  assert(lines.length<=1,'Ambiguous legacy channel configuration');
  assert(!lines.length||!/^  mattermost:/m.test(text),'Both legacy and current channel keys are present');
  return lines.length?text.replace(/^  chattermost:/m,'  mattermost:'):text;
}
export function translateDisabledJobs(text) {
  const document=JSON.parse(text);assert(Array.isArray(document.jobs)&&Number.isSafeInteger(document.revision)&&document.revision>0,'Invalid job definitions');
  let changed=false;
  for(const job of document.jobs) {
    if(job.owner==='hermes') {assert(job.enabled===false,'An enabled legacy job needs an explicit ownership handoff');job.owner='external';changed=true;}
    else assert(['ardent','external'].includes(job.owner),'Unknown job owner requires review');
  }
  if(!changed)return text;
  assert(document.revision<Number.MAX_SAFE_INTEGER,'Job revision overflow');document.revision++;
  return JSON.stringify(document,null,2)+'\n';
}
export function managedUnit(home,profile,pkg) {
  assert(/^[A-Za-z0-9_/-]+$/.test(home)&&/^[A-Za-z0-9_-]{1,64}$/.test(profile)&&/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(pkg),'Unsafe managed unit input');
  return `[Unit]\nDescription=Magnus Ardent ${profile}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${home}/.ardent/profiles/${profile}\nEnvironment=ARDENT_HOME=${home}/.ardent\nExecStart=/usr/bin/node ${home}/.local/share/ardent/node_modules/${pkg}/dist/cli.js --profile ${profile} gateway run\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=75\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}
function tree(root) {
  const files=[];
  function visit(dir) {for(const name of fs.readdirSync(dir).sort()) {const f=path.join(dir,name),s=fs.lstatSync(f),rel=path.relative(root,f);assert(s.isFile()||s.isDirectory()||s.isSymbolicLink(),'Unsupported filesystem entry');files.push([rel,s.mode&0o7777,s.uid,s.gid,s.isFile()?fileHash(f):s.isSymbolicLink()?fs.readlinkSync(f):null]);if(s.isDirectory())visit(f)}}
  visit(root);return hash(JSON.stringify(files));
}
export function validateConfig(c) {
  assert(c&&typeof c==='object'&&!Array.isArray(c),'A migration configuration is required');
  const keys=['id','owner','profiles','legacyPackage','legacyVersion','version','archive','integrity','recordRoot','agentRoot','quiesceUserUnits','compatibilityCheck','extensions'];assert(Object.keys(c).every(k=>keys.includes(k)),'Unknown migration setting');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.id)&&/^[a-z_][a-z0-9_-]{0,31}$/.test(c.owner),'Invalid migration identity');
  assert(c.quiesceUserUnits===undefined||(Array.isArray(c.quiesceUserUnits)&&new Set(c.quiesceUserUnits).size===c.quiesceUserUnits.length&&c.quiesceUserUnits.every(u=>/^[A-Za-z0-9_@.-]+\.(timer|service)$/.test(u)&&!u.startsWith('-')&&!u.startsWith('ardent@'))),'Name reviewed auxiliary user units explicitly');
  assert(Array.isArray(c.profiles)&&c.profiles.length>0&&new Set(c.profiles).size===c.profiles.length&&c.profiles.every(p=>/^[A-Za-z0-9_-]{1,64}$/.test(p)),'Name each profile exactly once');
  assert(/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(c.legacyPackage)&&c.legacyPackage!=='@hivemagnus/ardent','Name the legacy scoped package explicitly');
  assert(/^\d+\.\d+\.\d+$/.test(c.legacyVersion)&&/^\d+\.\d+\.\d+$/.test(c.version),'Exact stable versions required');assert(Number(c.version.split('.')[0])>=3,'Select the public native SQLite runtime');
  assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(c.integrity),'Published SHA-512 integrity required');
  for(const k of ['archive','recordRoot','agentRoot'])assert(typeof c[k]==='string'&&path.isAbsolute(c[k])&&path.normalize(c[k])===c[k]&&!/[\r\n]/.test(c[k]),'Absolute normalized paths required');
  if(c.compatibilityCheck!==undefined){const v=c.compatibilityCheck;assert(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===2&&typeof v.path==='string'&&path.isAbsolute(v.path)&&path.normalize(v.path)===v.path&&!/[\r\n]/.test(v.path)&&/^[a-f0-9]{64}$/.test(v.sha256),'A pinned compatibility checker is required');}
  if(c.extensions!==undefined)validateExtensions(c.extensions,c);
  return c;
}
const normalizedPath=v=>typeof v==='string'&&path.isAbsolute(v)&&path.normalize(v)===v&&!/[\r\n]/.test(v);
export function validateExtensions(e,c) {
  assert(e&&typeof e==='object'&&!Array.isArray(e)&&Object.keys(e).sort().join(',')==='packages,profiles','Explicit extension packages and profile bindings required');
  const [major,minor]=c.version.split('.').map(Number);assert(major>3||(major===3&&minor>=1),'Extensions require Ardent 3.1 or later');
  assert(Array.isArray(e.packages)&&e.packages.length>0&&e.packages.length<=32,'Bounded extension packages required');
  const names=new Set();
  for(const p of e.packages) {
    assert(p&&Object.keys(p).sort().join(',')==='archive,integrity,name,version'&&/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(p.name)&&p.name!=='@hivemagnus/ardent'&&!names.has(p.name),'Unique extension package names required');names.add(p.name);
    assert(/^\d+\.\d+\.\d+$/.test(p.version)&&/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)&&normalizedPath(p.archive),'Pinned extension version, archive and integrity required');
  }
  assert(e.profiles&&typeof e.profiles==='object'&&!Array.isArray(e.profiles),'Profile extensions required');assert.deepEqual(Object.keys(e.profiles).sort(),[...c.profiles].sort(),'Bind every profile explicitly');
  for(const v of Object.values(e.profiles)) {
    assert(v&&Object.keys(v).sort().join(',')==='files,plugins'&&Array.isArray(v.plugins)&&v.plugins.length>0&&v.plugins.length<=32&&new Set(v.plugins).size===v.plugins.length,'Explicit unique plugins required');
    assert(v.plugins.every(s=>typeof s==='string'&&s.length<=500&&[...names].some(n=>s===n||(s.startsWith(n+'/')&&s.slice(n.length+1).split('/').every(x=>/^[A-Za-z0-9_.-]+$/.test(x)&&x!=='.'&&x!=='..')))),'Each plugin must belong to a pinned package');
    assert(Array.isArray(v.files)&&v.files.length<=32,'Bounded binding files required');const targets=new Set();
    for(const f of v.files) {
      assert(f&&Object.keys(f).sort().join(',')==='sha256,source,target'&&normalizedPath(f.source)&&/^[a-f0-9]{64}$/.test(f.sha256)&&typeof f.target==='string'&&/^\.extensions\/[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9.-]{0,63}\.json$/.test(f.target)&&!targets.has(f.target),'Unique protected JSON binding targets required');targets.add(f.target);
    }
  }
  return e;
}
export function translatedProfileConfig(text,extension) {
  const next=translateLegacyConfig(text);if(!extension)return next;
  assert(!/^plugins\s*:/m.test(next),'Existing plugins require an explicit reconciliation');
  return next.replace(/\n*$/,'\n')+'plugins: '+JSON.stringify(extension.plugins)+'\n';
}
export function preservedJobs(text,version) {
  const [major,minor]=version.split('.').map(Number);
  // Modern schedulers retain external owner labels and their original revision.
  return major>3||(major===3&&minor>=1)?text:translateDisabledJobs(text);
}
export function validateDependencyLock(lock,c) {
  assert(lock.lockfileVersion>=3&&lock.packages&&typeof lock.packages==='object','A complete runtime lockfile is required');
  const expected=new Map([['node_modules/@hivemagnus/ardent',{version:c.version,integrity:c.integrity,archive:c.extensions?'core-package.tgz':'package.tgz'}],
    ...(c.extensions?.packages??[]).map((p,i)=>['node_modules/'+p.name,{...p,archive:'extension-'+i+'.tgz'}])]);
  for(const [name,p]of Object.entries(lock.packages)) {
    if(name==='')continue;
    assert(!p.link&&typeof p.integrity==='string'&&/^sha(256|384|512)-/.test(p.integrity),'Locked dependency integrity is missing');
    const pin=expected.get(name);
    if(pin)assert(p.version===pin.version&&p.integrity===pin.integrity&&p.resolved==='file:'+pin.archive,'Locked candidate identity differs');
    else assert(typeof p.resolved==='string'&&p.resolved.startsWith('https://registry.npmjs.org/')&&!name.endsWith('/node_modules/@hivemagnus/ardent'),'Dependency origin or runtime peer differs');
  }
  for(const name of expected.keys())assert(lock.packages[name],'Reviewed package is absent from lockfile');
}
function rootControlled(directory) {
  let f=directory;
  for(;;) {const s=fs.lstatSync(f);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&(s.mode&0o022)===0,'Record and archive ancestors must remain root-controlled');if(f===path.dirname(f))break;f=path.dirname(f)}
}
export function journalSnapshot(db,prior) {
const result={};
for(const t of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
 const quote=s=>'"'+s.replaceAll('"','""')+'"',q=quote(t.name),info=db.prepare('PRAGMA table_info('+q+')').all(),cols=prior?.[t.name]?.columns??info.map(c=>c.name);
 const order=/WITHOUT\s+ROWID/i.test(t.sql)?info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>quote(c.name)).join(','):'rowid';assert(order,'Journal has no stable row order');
 const h=crypto.createHash('sha256');let count=0;
 for(const row of db.prepare('SELECT '+cols.map(quote).join(',')+' FROM '+q+' ORDER BY '+order).iterate()){h.update(JSON.stringify(cols.map(c=>row[c]),(_,v)=>typeof v==='bigint'?String(v):v)+'\n');count++;}
 result[t.name]={columns:cols,count,sha256:h.digest('hex')};}

return result;
}
export const PROBE=String.raw`
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const [root,mode,file,other]=process.argv.slice(2);const {default:Database}=await import(pathToFileURL(root+'/dist/sqlite.js'));
if(mode==='backup'){const d=new Database(file,{readonly:true,fileMustExist:true});await d.backup(other);d.close();process.exit(0)}
if(mode==='migrate'||mode==='rollback-probe'){const {TaskStore,TaskSchema,SessionSchema}=await import(pathToFileURL((mode==='migrate'?root:other)+'/dist/store.js'));const s=new TaskStore(file);if(mode==='rollback-probe'){for(const [table,schema]of [['tasks',TaskSchema],['sessions',SessionSchema]]){assert(schema,'Legacy reader schema is unavailable');for(const row of s.db.prepare('SELECT * FROM '+table).iterate())schema.parse(row);}}s.close();}
const d=new Database(file,{readonly:true,fileMustExist:true});assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.equal(d.pragma('foreign_key_check').length,0);
const prior=other&&mode==='compare'?JSON.parse(fs.readFileSync(other,'utf8')):null;const result={};
Object.assign(result,(${journalSnapshot.toString()})(d,prior));
if(prior)for(const [name,v]of Object.entries(prior))assert.deepEqual(result[name],v,'Existing journal rows changed during migration: '+name);
d.close();console.log(JSON.stringify(result));`;
export function assertRecoveryPhase(record,action) {
  if(action==='cancel-before-promotion')assert((['prepared','backed-up'].includes(record.phase)||(record.phase==='held'&&['prepared','quiesced','backed-up'].includes(record.failedPhase)))&&!record.retainedRuntime&&!record.retainedPrevious,'Only a proven pre-promotion failure can be cancelled');
  else assert(['held','awaiting-auth'].includes(record.phase)&&record.failedPhase==='activated','Only a held service activation can be finished; promotion is never replayed');
}
export function classifyReadiness(config,status,body) {
  if(status===200&&body.status==='ready'&&Array.isArray(body.problems)&&body.problems.length===0)return {ready:true};
  assert(status===503&&config.execution.backend==='codex'&&config.providers.codex.auth_mode==='chatgpt'&&JSON.stringify(body.problems)===JSON.stringify(['Codex login required']),'An unrelated dependency or runtime failure blocks activation');
  return {ready:false,requiresCodexLogin:true};
}
export async function main(argv=process.argv.slice(2)) {
  assert(argv.length===2&&['prepare','quiesce','apply','check-held','start-for-auth','finish','verify','cancel-before-promotion','repair-disabled-jobs','rollback-code'].includes(argv[0]),'Usage: node scripts/migrate-legacy-ardent.mjs ACTION ROOT_OWNED_CONFIG.json');
  assert(process.platform==='linux'&&process.getuid()===0,'Run this explicit native migration as root on Linux');
  const configFile=path.resolve(argv[1]),st=regular(configFile);assert(st.uid===0&&(st.mode&0o077)===0,'Migration configuration must be root-owned and private');
  const configBytes=read(configFile),c=validateConfig(JSON.parse(configBytes));
  rootControlled(path.dirname(configFile));rootControlled(path.dirname(c.recordRoot));
  const account=fs.readFileSync('/etc/passwd','utf8').split('\n').map(l=>l.split(':')).find(a=>a[0]===c.owner);assert(account,'Owner is unavailable');
  const owner={uid:Number(account[2]),gid:Number(account[3])},home=account[5];assert(owner.uid>0&&/^\/[A-Za-z0-9_/-]+$/.test(home),'A regular service account is required');
  for(const f of [home,path.join(home,'.local'),path.join(home,'.local/share'),path.join(home,'.ardent'),path.join(home,'.ardent/profiles')]) {const s=fs.lstatSync(f);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===owner.uid,'Owner directories must be unaliased and owned');}
  fs.mkdirSync(c.recordRoot,{recursive:true,mode:0o700});rootControlled(c.recordRoot);
  const recordDir=path.join(c.recordRoot,c.id);fs.mkdirSync(recordDir,{mode:0o700,recursive:true});rootControlled(recordDir);
  const lock=path.join(c.recordRoot,'.lock');const lockFd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,id:c.id}));fs.fsyncSync(lockFd);
  const log=fs.openSync(path.join(recordDir,'diagnostic.private.log'),'a',0o600);
  function run(args,{asOwner=false,input,inputFd,allowFailure=false,cwd,timeout=600000}={}) {
    if(asOwner)args=['runuser','-u',c.owner,'--','env',`HOME=${home}`,`XDG_RUNTIME_DIR=/run/user/${owner.uid}`,...args];
    const r=spawnSync(args[0],args.slice(1),{input,cwd,...(inputFd===undefined?{}:{stdio:[inputFd,'pipe','pipe']}),encoding:'utf8',timeout,maxBuffer:64*1024*1024,env:{...process.env,HOME:asOwner?home:'/root'}});
    if(r.stdout)fs.writeSync(log,r.stdout);if(r.stderr)fs.writeSync(log,r.stderr);
    if(!allowFailure)assert(r.status===0,'A migration command failed; inspect the private diagnostic');return r;
  }
  const file=path.join(recordDir,'record.json');let record=fs.existsSync(file)?JSON.parse(read(file)):{schema:1,id:c.id,configurationSHA256:hash(configBytes),phase:'new',machineIdSHA256:hash(read('/etc/machine-id'))};
  assert(record.configurationSHA256===hash(configBytes),'Migration configuration changed');
  const install=path.join(home,'.local/share/ardent'),stage=path.join(home,`.local/share/.ardent-migration-${c.id}`),rehearsal=path.join(home,`.local/share/.ardent-rehearsal-${c.id}`),pkg=path.join(stage,'node_modules/@hivemagnus/ardent'),legacy=path.join(install,'node_modules',c.legacyPackage);
  function save(phase) {record.phase=phase;record.updatedAt=new Date().toISOString();atomic(file,JSON.stringify(record,null,2)+'\n');}
  const unit=p=>path.join(home,'.config/systemd/user',`ardent@${p}.service`);
  const profile=p=>path.join(home,'.ardent/profiles',p);
  function system(action,p,allowFailure=false) {return run(['/usr/bin/systemctl','--user',action,`ardent@${p}.service`],{asOwner:true,allowFailure,timeout:100000});}
  function auxiliary(action,units) {for(const u of units)run(['/usr/bin/systemctl','--user',action,u],{asOwner:true});}
  function resumeAuxiliary() {auxiliary('start',record.activeAuxiliaryUnits??[]);}
  function meta() {return Object.fromEntries(c.profiles.map(p=>[p,{config:hash(read(path.join(profile(p),'config.yaml'))),env:hash(read(path.join(profile(p),'.env'))),unit:hash(read(unit(p))),...(c.extensions?{jobs:fs.existsSync(path.join(profile(p),'jobs/active.json'))?fileHash(path.join(profile(p),'jobs/active.json')):null}:{})}]));}
  function noPending() {
    const states=c.profiles.map(p=>path.join(profile(p),'state')+path.sep);
    for(const p of c.profiles)assert(!fs.existsSync(path.join(profile(p),'state/gateway.lock')),'An execution lock remains; inspect uncertain work before continuing');
    for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)&&Number(p)!==process.pid)) {
      let names;try{names=fs.readdirSync('/proc/'+pid+'/fd')}catch{continue}
      for(const name of names){let target;try{target=fs.readlinkSync('/proc/'+pid+'/fd/'+name)}catch{continue}assert(!states.some(root=>target.startsWith(root)),'Another process still holds profile state; stop its writer before continuing');}
    }
  }
  function ownerFile(f,bytes,mode=0o600) {
    const program="const fs=require('fs'),p=require('path');const [file,mode]=process.argv.slice(1);const tmp=file+'.'+require('crypto').randomUUID();const fd=fs.openSync(tmp,'wx',Number(mode));try{fs.writeFileSync(fd,fs.readFileSync(0));fs.fchmodSync(fd,Number(mode));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);const d=fs.openSync(p.dirname(file),'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}";
    run(['/usr/bin/node','-e',program,f,String(mode)],{asOwner:true,input:bytes});
  }
  function move(from,to) {assert(!fs.existsSync(to),'Move destination already exists');run(['/usr/bin/mv','-T','--no-clobber','--',from,to],{asOwner:true});assert(!fs.existsSync(from)&&fs.existsSync(to),'Ownership transfer did not complete');}
  function probe(target,mode,db,other) {return run(['/usr/bin/node',path.join(rehearsal,'probe.mjs'),target,mode,db,...(other?[other]:[])],{asOwner:true}).stdout;}
  function protectedInput(file,maximum) {
    rootControlled(path.dirname(file));const st=regular(file);assert(st.uid===0&&st.nlink===1&&(st.mode&0o077)===0&&st.size<=maximum&&fs.realpathSync(file)===file,'Extension input must be private, bounded and root-controlled');return read(file);
  }
  function bindingFiles(p,destination,sourceRoot) {
    for(const f of c.extensions?.profiles[p].files??[]) {
      const bytes=sourceRoot?read(path.join(sourceRoot,p,f.target)):protectedInput(f.source,256*1024);
      assert(hash(bytes)===f.sha256,'Extension binding digest differs');JSON.parse(bytes);
      const parent=path.dirname(path.join(destination,f.target));
      let current=destination;for(const part of path.relative(destination,parent).split(path.sep)){current=path.join(current,part);if(!fs.existsSync(current))run(['/usr/bin/mkdir','-m','700',current],{asOwner:true});const st=fs.lstatSync(current);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===owner.uid&&(st.mode&0o077)===0,'Binding directory ownership differs');}
      const target=path.join(destination,f.target);assert(!fs.existsSync(target),'An existing extension binding requires explicit reconciliation');ownerFile(target,bytes);
    }
  }
  function packageDigest(directory) {
    const code=`import {packageTreeDigest} from ${JSON.stringify(pathToFileURL(path.join(c.agentRoot,'current/node_modules/@hivemagnus/magnus-agent/dist/executors/ardent-manager.js')).href)};console.log(await packageTreeDigest(process.argv[1]));`;
    const digest=run(['/usr/bin/node','--input-type=module','-e',code,directory]).stdout.trim();assert(/^[a-f0-9]{64}$/.test(digest),'Candidate receipt digest is invalid');return digest;
  }
  async function acceptance() {
    const active=path.join(install,'node_modules/@hivemagnus/ardent');assert(JSON.parse(read(path.join(active,'package.json'))).version===c.version,'Active version differs');
    for(const p of c.profiles) {assert(read(unit(p)).toString()===managedUnit(home,p,'@hivemagnus/ardent'),'Managed service definition differs');const r=run(['/usr/bin/node',path.join(active,'dist/cli.js'),'--profile',p,'acceptance'],{asOwner:true});assert(JSON.parse(r.stdout).ok,'Profile acceptance did not pass');assert(hash(read(path.join(profile(p),'.env')))===record.profiles[p].env,'Profile credentials changed');}
  }
  function migrateJobs(p,original) {
    const f=path.join(profile(p),'jobs/active.json'),next=preservedJobs(original,c.version);if(next===original)return;
    const current=read(f).toString();assert(current===original||current===next,'Job definitions changed since the stopped archive');
    assert(system('is-active',p,true).stdout.trim()!=='active','Stop the gateway before translating disabled jobs');
    run(['/usr/bin/node',path.join(install,'node_modules/@hivemagnus/ardent/dist/cli.js'),'--profile',p,'jobs','definitions','validate','--source','/dev/stdin'],{asOwner:true,input:next});
    record.jobsMigration??={};record.jobsMigration[p]={originalSHA256:hash(original),targetSHA256:hash(next),revision:JSON.parse(next).revision};save('held');
    const previous=path.join(profile(p),'jobs/revisions',JSON.parse(original).revision+'-'+hash(original)+'.json');
    run(['/usr/bin/mkdir','-p',path.dirname(previous)],{asOwner:true});if(fs.existsSync(previous))assert(read(previous).toString()===original,'Existing job revision differs');else ownerFile(previous,original);
    if(current!==next)ownerFile(f,next,regular(f).mode&0o777);
  }
  try {
    if(argv[0]==='cancel-before-promotion') {
      assertRecoveryPhase(record,argv[0]);assert(hash(read('/etc/machine-id'))===record.machineIdSHA256,'Host identity differs');assert.deepEqual(meta(),record.profiles,'Original configuration or services changed');assert(tree(install)===record.runtimeSHA256,'Original runtime changed');assert((fs.existsSync(install+'.previous')?tree(install+'.previous'):null)===record.previousSHA256,'Older checkpoint changed');assert(!fs.existsSync(install+'.legacy-'+c.id)&&!fs.existsSync(install+'.previous.legacy-'+c.id),'A promotion path exists');
      for(const p of c.profiles)system('start',p);if(record.agentWasActive)run(['systemctl','start','magnus-agent']);resumeAuxiliary();save('cancelled');console.log(JSON.stringify({id:c.id,phase:'cancelled',originalRuntimePreserved:true}));return;
    }
    if(argv[0]==='verify') {assert(record.phase==='complete','Migration is not complete');await acceptance();console.log(JSON.stringify({id:c.id,version:c.version,verified:true}));return;}
    if(['finish','check-held','start-for-auth','repair-disabled-jobs','rollback-code'].includes(argv[0])) {
      assertRecoveryPhase(record,argv[0]);assert(record.retainedRuntime===install+'.legacy-'+c.id&&record.retainedPrevious===install+'.previous.legacy-'+c.id,'Retained paths differ');
      const ackFile=path.join(recordDir,'backup-ack.json'),ast=regular(ackFile);assert(ast.uid===0&&(ast.mode&0o077)===0,'Acknowledgement ownership differs');assert('sha512-'+crypto.createHash('sha512').update(read(c.archive)).digest('base64')===c.integrity,'Published archive integrity differs');const ack=JSON.parse(read(ackFile));assert(ack.sha256===record.backupSHA256&&ack.machineIdSHA256===record.machineIdSHA256&&ack.configurationSHA256===record.configurationSHA256,'Recovery acknowledgement differs');
      assert(fileHash(path.join(recordDir,'recovery.tar.gz'))===record.backupSHA256&&hash(read('/etc/machine-id'))===record.machineIdSHA256,'Recovery archive or host differs');
      assert(tree(record.retainedRuntime)===record.runtimeSHA256,'Retained legacy runtime changed');if(record.previousSHA256)assert(tree(record.retainedPrevious)===record.previousSHA256,'Retained older checkpoint changed');
      assert(hash(read(path.join(install,'package-lock.json')))===record.candidateLockSHA256,'Candidate lock changed');
      if(record.extensionBundleSha256)assert(fileHash(path.join(install,'extension-bundle.json'))===record.extensionBundleSha256,'Extension receipt changed');
      const receipt=JSON.parse(read(path.join(install,'package-receipt.json')));assert(receipt.name==='@hivemagnus/ardent'&&receipt.version===c.version&&receipt.sha256===hash(read(c.archive)),'Active package receipt differs');
      for(const p of c.profiles)assert(hash(read(path.join(profile(p),'.env')))===record.profiles[p].env&&read(unit(p)).toString()===managedUnit(home,p,'@hivemagnus/ardent'),'Credentials or managed units changed');
      if(!record.candidateRuntimeSHA256) {
        // Older prepared records can recover only after a new independent rebuild of
        // the exact frozen public dependency closure. Never trust a mutable receipt alone.
        const rebuilt=path.join(home,'.local/share/.ardent-rebuild-'+c.id+'-'+crypto.randomUUID());assert(!fs.existsSync(rebuilt),'Forensic rebuild path exists');run(['/usr/bin/mkdir','-m','700',rebuilt],{asOwner:true});
        for(const n of ['package.tgz','package.json','package-lock.json'])ownerFile(path.join(rebuilt,n),read(path.join(install,n)),regular(path.join(install,n)).mode&0o777);
        run(['/usr/bin/npm','ci','--prefix',rebuilt,'--omit=dev','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],{asOwner:true});
        ownerFile(path.join(rebuilt,'package-receipt.json'),JSON.stringify(receipt)+'\n',0o644);
        assert(tree(rebuilt)===tree(install),'Frozen runtime rebuild differs');record.candidateRuntimeSHA256=tree(rebuilt);
        // Recover the exact intended configuration from the retained stopped archive.
        record.targetConfigSHA256={};
        for(const p of c.profiles){const original=run(['tar','-xOzf',path.join(recordDir,'recovery.tar.gz'),'.ardent/profiles/'+p+'/config.yaml']).stdout;assert(hash(original)===record.profiles[p].config,'Original config backup differs');record.targetConfigSHA256[p]=hash(translatedProfileConfig(original,c.extensions?.profiles[p]));}
      }
      assert(tree(install)===record.candidateRuntimeSHA256,'Active runtime bytes changed');for(const p of c.profiles)for(const f of c.extensions?.profiles[p].files??[])assert(fileHash(path.join(profile(p),f.target))===f.sha256,'Active binding changed');for(const p of c.profiles)assert(hash(read(path.join(profile(p),'config.yaml')))===record.targetConfigSHA256[p],'Target configuration differs');
      const normalize=text=>text.split(/\r?\n/).filter(l=>!l.startsWith('ARDENT_STAGED_PACKAGE=')).join('\n').replace(/\n*$/,'\n');assert(normalize(read(path.join(c.agentRoot,'.env')).toString())===normalize(record.agentEnvironment),'Agent enrollment or configuration changed');
      if(argv[0]==='rollback-code') {
        assert(!record.jobsMigration,'Reconcile translated job revisions before selecting code rollback');
        const candidate=install+'.public-'+c.id;assert(!fs.existsSync(candidate)&&!fs.existsSync(install+'.previous'),'Rollback destination conflicts');
        const originals={};for(const p of c.profiles){const config=run(['tar','-xOzf',path.join(recordDir,'recovery.tar.gz'),'.ardent/profiles/'+p+'/config.yaml']).stdout;assert(hash(config)===record.profiles[p].config,'Original configuration differs');originals[p]=config;}
        record.rollbackAgentWasActive=record.agentWasActive;save('stopping-rollback');run(['systemctl','stop','magnus-agent']);auxiliary('stop',c.quiesceUserUnits??[]);for(const p of c.profiles)system('stop',p);noPending();
        // Rehearse the old reader against current journals. Preserve these copies and
        // every original row; rollback transfers code and configuration only.
        const active=path.join(install,'node_modules/@hivemagnus/ardent'),old=path.join(record.retainedRuntime,'node_modules',c.legacyPackage);
        for(const p of c.profiles)for(const n of fs.readdirSync(path.join(profile(p),'state')).filter(n=>n.endsWith('.sqlite')||n.endsWith('.db'))){const copy=path.join(rehearsal,'rollback-current-'+p+'-'+n);assert(!fs.existsSync(copy),'Rollback journal checkpoint exists');probe(active,'backup',path.join(profile(p),'state',n),copy);const before=probe(active,'snapshot',copy);ownerFile(copy+'.before.json',before);probe(active,'rollback-probe',copy,old);probe(active,'compare',copy,copy+'.before.json');}
        save('rolling-back-code');move(install,candidate);move(record.retainedRuntime,install);if(record.previousSHA256)move(record.retainedPrevious,install+'.previous');
        for(const p of c.profiles){ownerFile(path.join(profile(p),'config.yaml'),originals[p],regular(path.join(profile(p),'config.yaml')).mode&0o777);ownerFile(unit(p),managedUnit(home,p,c.legacyPackage),0o644);}
        const env=path.join(c.agentRoot,'.env'),es=regular(env);if(es.uid===owner.uid)ownerFile(env,record.agentEnvironment,es.mode&0o777);else{rootControlled(path.dirname(env));atomic(env,record.agentEnvironment,es.mode&0o777,{uid:es.uid,gid:es.gid});}
        assert(tree(install)===record.runtimeSHA256,'Restored code differs');assert.deepEqual(meta(),record.profiles,'Original settings differ');run(['/usr/bin/systemctl','--user','daemon-reload'],{asOwner:true});for(const p of c.profiles)system('start',p);resumeAuxiliary();if(record.agentWasActive)run(['systemctl','start','magnus-agent']);record.retainedPublicRuntime=candidate;save('rolled-back-code');console.log(JSON.stringify({id:c.id,phase:'rolled-back-code',currentJournalsPreserved:true,rollbackRehearsed:true}));return;
      }
      if(argv[0]==='repair-disabled-jobs') {
        noPending();for(const p of c.profiles){const f=path.join(profile(p),'jobs/active.json');if(fs.existsSync(f)){const original=run(['tar','-xOzf',path.join(recordDir,'recovery.tar.gz'),'.ardent/profiles/'+p+'/jobs/active.json']).stdout;migrateJobs(p,original);}}
        save('held');console.log(JSON.stringify({id:c.id,phase:'held',disabledJobsTranslated:true}));return;
      }
      for(const [p,j]of Object.entries(record.jobsMigration??{}))assert(hash(read(path.join(profile(p),'jobs/active.json')))===j.targetSHA256,'Translated job definitions changed');
      if(argv[0]==='check-held'){save('held');console.log(JSON.stringify({id:c.id,phase:'held',runtimeAndRecoveryVerified:true}));return;}
      save('activated');for(const p of c.profiles)system('start',p);
      if(argv[0]==='start-for-auth') {
        let waiting=false;
        for(const p of c.profiles) {
          const program=`import fs from 'node:fs';import {parseEnv} from 'node:util';import {loadConfig} from ${JSON.stringify(pathToFileURL(path.join(install,'node_modules/@hivemagnus/ardent/dist/config.js')).href)};const {config}=await loadConfig(process.argv[1]);const env=parseEnv(fs.readFileSync(process.argv[1]+'/.env','utf8'));const base='http://'+config.api.host+':'+config.api.port;const r=await fetch(base+'/api/v1/status',{headers:{Authorization:'Bearer '+env[config.api.token_env]}});const d=await r.json();if(!r.ok||d.version!==process.argv[2]||d.profile!==config.profile||d.backend!==config.execution.backend)throw Error('Runtime identity differs');const ready=await fetch(base+'/health/ready');const body=await ready.json();const assert=(v,m)=>{if(!v)throw Error(m)};const classify=${classifyReadiness.toString()};console.log(JSON.stringify(classify(config,ready.status,body)));`;
          let result;
          for(let i=0;;i++){const r=run(['/usr/bin/node','--input-type=module','-e',program,profile(p),c.version],{asOwner:true,allowFailure:true});if(r.status===0){result=JSON.parse(r.stdout);break}if(i>=30)throw Error('Management identity did not pass');await new Promise(r=>setTimeout(r,1000));}
          waiting ||= result.requiresCodexLogin===true;
        }
        if(waiting){record.failedPhase='activated';record.dependency='Codex sign-in required';if(record.agentWasActive)run(['systemctl','start','magnus-agent']);resumeAuxiliary();save('awaiting-auth');console.log(JSON.stringify({id:c.id,phase:'awaiting-auth',version:c.version,managementVerified:true,backendPreserved:true}));return;}
      }
      for(let i=0;;i++){try{await acceptance();break}catch(e){if(i>=30)throw e;await new Promise(r=>setTimeout(r,1000));}}
      if(record.agentWasActive)run(['systemctl','start','magnus-agent']);resumeAuxiliary();save('complete');console.log(JSON.stringify({id:c.id,phase:'complete',version:c.version,activationFinished:true}));return;
    }
    if(argv[0]==='quiesce'&&record.phase==='backed-up'){assert(fileHash(path.join(recordDir,'recovery.tar.gz'))===record.backupSHA256,'Recovery archive changed');for(const p of c.profiles)assert(tree(profile(p))===record.profileStateSHA256[p],'Quiesced profile changed');noPending();console.log(JSON.stringify({id:c.id,phase:'backed-up',backup:path.join(recordDir,'recovery.tar.gz'),backupSHA256:record.backupSHA256,machineIdSHA256:record.machineIdSHA256,configurationSHA256:record.configurationSHA256}));return;}
    assert(['new','prepared','backed-up'].includes(record.phase),'An interrupted or completed migration must be inspected; it is never replayed automatically');
    const oldPackage=JSON.parse(read(path.join(legacy,'package.json')));assert(fs.realpathSync(install)===install&&fs.realpathSync(legacy)===legacy&&oldPackage.version===c.legacyVersion&&oldPackage.name===c.legacyPackage,'Legacy runtime differs');
    const adoption=JSON.parse(read(path.join(install,'context-adoption.json')));assert(adoption.schema_version===1&&typeof adoption.release_id==='string','A known legacy adoption record is required');
    const all=fs.readdirSync(path.join(home,'.ardent/profiles'),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();assert.deepEqual([...c.profiles].sort(),all,'The plan must cover every profile sharing this runtime');
    for(const p of c.profiles) {assert(read(unit(p)).toString()===managedUnit(home,p,c.legacyPackage),'Legacy service has unreviewed customization');if(record.phase!=='backed-up')assert(system('is-active',p).stdout.trim()==='active','Each legacy profile must be healthy before preparation');}
    assert(regular(c.archive).size<5*1024*1024,'Runtime archive exceeds the supported bound');assert('sha512-'+crypto.createHash('sha512').update(read(c.archive)).digest('base64')===c.integrity,'Release archive differs from published integrity');
    if(record.phase==='new') {
      assert(c.compatibilityCheck,'Custom builds require an explicit capability compatibility check before migration');
      rootControlled(path.dirname(c.compatibilityCheck.path));const checker=regular(c.compatibilityCheck.path);assert(checker.uid===0&&(checker.mode&0o022)===0&&hash(read(c.compatibilityCheck.path))===c.compatibilityCheck.sha256,'Compatibility checker ownership or digest differs');
      assert(!fs.existsSync(stage)&&!fs.existsSync(rehearsal),'Candidate paths already exist');
      run(['/usr/bin/mkdir','-m','700',stage,rehearsal],{asOwner:true});const coreArchive=c.extensions?'core-package.tgz':'package.tgz';ownerFile(path.join(stage,coreArchive),read(c.archive));
      const dependencies={'@hivemagnus/ardent':'file:./'+coreArchive};
      for(const [i,p]of (c.extensions?.packages??[]).entries()){const bytes=protectedInput(p.archive,16*1024*1024);assert('sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')===p.integrity,'Extension archive integrity differs');ownerFile(path.join(stage,'extension-'+i+'.tgz'),bytes);dependencies[p.name]='file:./extension-'+i+'.tgz';}
      ownerFile(path.join(stage,'package.json'),JSON.stringify({name:'ardent-native-runtime',version:c.version,private:true,dependencies})+'\n');
      run(['/usr/bin/npm','install','--prefix',stage,'--omit=dev','--no-audit','--no-fund','--ignore-scripts','--strict-peer-deps','--registry=https://registry.npmjs.org'],{asOwner:true});
      if(c.extensions) {
        const packages=c.extensions.packages.map((p,i)=>({name:p.name,version:p.version,archive:'extension-'+i+'.tgz',integrity:p.integrity,packageTreeSha256:packageDigest(path.join(stage,'node_modules',p.name))}));
        ownerFile(path.join(stage,'extension-bundle.json'),JSON.stringify({schemaVersion:1,packages})+'\n');record.extensionBundleSha256=fileHash(path.join(stage,'extension-bundle.json'));
        run(['/usr/bin/mkdir','-m','700',path.join(stage,'profile-files')],{asOwner:true});
        for(const p of c.profiles){const destination=path.join(stage,'profile-files',p);run(['/usr/bin/mkdir','-m','700',destination],{asOwner:true});bindingFiles(p,destination);}
      }
      const manifest=JSON.parse(read(path.join(pkg,'package.json')));assert(manifest.name==='@hivemagnus/ardent'&&manifest.version===c.version,'Candidate package identity differs');
      const lock=JSON.parse(read(path.join(stage,'package-lock.json')));validateDependencyLock(lock,c);record.candidateLockSHA256=hash(read(path.join(stage,'package-lock.json')));run(['/usr/bin/npm','audit','--prefix',stage,'--omit=dev','--audit-level=high'],{asOwner:true});
      ownerFile(path.join(rehearsal,'probe.mjs'),PROBE);record.profiles=meta();record.targetConfigSHA256=Object.fromEntries(c.profiles.map(p=>[p,hash(translatedProfileConfig(read(path.join(profile(p),'config.yaml')).toString(),c.extensions?.profiles[p]))]));record.runtimeSHA256=tree(install);record.previousSHA256=fs.existsSync(install+'.previous')?tree(install+'.previous'):null;record.adoptionSHA256=hash(read(path.join(install,'context-adoption.json')));
      for(const p of c.profiles) {
        const copy=path.join(rehearsal,p);run(['/usr/bin/cp','-a','--reflink=auto',profile(p),copy],{asOwner:true});
        for(const name of fs.readdirSync(path.join(copy,'state')).filter(n=>n.endsWith('.sqlite')||n.endsWith('.db'))) {const db=path.join(copy,'state',name);run(['/usr/bin/rm','-f','--',db,db+'-wal',db+'-shm'],{asOwner:true});probe(pkg,'backup',path.join(profile(p),'state',name),db);const before=probe(pkg,'snapshot',db);ownerFile(db+'.before.json',before);probe(pkg,'migrate',db);probe(pkg,'compare',db,db+'.before.json');probe(pkg,'rollback-probe',db,legacy);probe(pkg,'compare',db,db+'.before.json');}
        bindingFiles(p,copy,path.join(stage,'profile-files'));
        ownerFile(path.join(copy,'config.yaml'),translatedProfileConfig(read(path.join(copy,'config.yaml')).toString(),c.extensions?.profiles[p]));
        const jobs=path.join(copy,'jobs/active.json');if(fs.existsSync(jobs)){ownerFile(jobs,preservedJobs(read(jobs).toString(),c.version));run(['/usr/bin/node',path.join(pkg,'dist/cli.js'),'--profile-path',copy,'jobs','definitions','validate','--source',jobs],{asOwner:true});}
        const d=run(['/usr/bin/node',path.join(pkg,'dist/cli.js'),'--profile-path',copy,'doctor'],{asOwner:true});const result=JSON.parse(d.stdout);assert(result.config_valid&&result.runtime_problems.length===0,'Candidate profile validation failed');
        run(['/usr/bin/node',c.compatibilityCheck.path,p,legacy,pkg,copy],{asOwner:true});
        for(const n of fs.readdirSync(path.join(copy,'state')).filter(n=>n.endsWith('.sqlite')||n.endsWith('.db')))probe(pkg,'compare',path.join(copy,'state',n),path.join(copy,'state',n)+'.before.json');
      }
      record.preparedRuntimeSHA256=tree(stage);save('prepared');
    }
    if(argv[0]==='prepare') {console.log(JSON.stringify({id:c.id,phase:record.phase,profiles:c.profiles,restoreAndRollbackRehearsed:true}));return;}
    assert.deepEqual(meta(),record.profiles,'Protected configuration or services changed after preparation');assert(tree(install)===record.runtimeSHA256,'Legacy runtime changed after preparation');assert((fs.existsSync(install+'.previous')?tree(install+'.previous'):null)===record.previousSHA256,'Older checkpoint changed after preparation');
    if(c.compatibilityCheck)assert(hash(read(c.compatibilityCheck.path))===c.compatibilityCheck.sha256,'Compatibility checker changed after preparation');
    if(record.preparedRuntimeSHA256)assert(tree(stage)===record.preparedRuntimeSHA256,'Prepared candidate bytes changed');
    if(argv[0]==='quiesce') {
    record.agentEnvironment=read(path.join(c.agentRoot,'.env')).toString();const agentEnvInfo=regular(path.join(c.agentRoot,'.env'));assert([0,owner.uid].includes(agentEnvInfo.uid),'Agent environment owner differs');
    record.agentWasActive=run(['systemctl','is-active','magnus-agent'],{allowFailure:true}).status===0;
    // Stop remote lifecycle admission and reviewed observers before taking a stopped archive.
    const auxiliaries=[...(c.quiesceUserUnits??[])].sort((a,b)=>Number(b.endsWith('.timer'))-Number(a.endsWith('.timer')));record.activeAuxiliaryUnits=auxiliaries.filter(u=>run(['/usr/bin/systemctl','--user','is-active',u],{asOwner:true,allowFailure:true}).status===0);
    save('stopping');auxiliary('stop',auxiliaries);
    if(record.agentWasActive)run(['systemctl','stop','magnus-agent']);
    for(const p of c.profiles)system('stop',p);
    noPending();save('quiesced');
    const backup=path.join(recordDir,'recovery.tar.gz'),items=[path.relative(home,install),'.ardent',...(c.extensions?[path.relative(home,stage)]:[])];if(fs.existsSync(install+'.previous'))items.push(path.relative(home,install+'.previous'));
    for(const p of c.profiles)items.push(path.relative(home,unit(p)));
    run(['tar','--sparse','-czf',backup,'-C',home,'--',...items]);run(['gzip','-t',backup]);fs.chmodSync(backup,0o600);record.backupSHA256=fileHash(backup);
    // Independently restore the actual quiesced profile bytes and verify all original rows.
    const restored=path.join(rehearsal,'restored');run(['/usr/bin/mkdir','-m','700',restored],{asOwner:true});
    const backupFd=fs.openSync(backup,'r');try{run(['tar','-xzf','-','-C',restored,'--no-same-owner','--same-permissions','--',...c.profiles.map(p=>'.ardent/profiles/'+p)],{asOwner:true,inputFd:backupFd});}finally{fs.closeSync(backupFd)}
    for(const p of c.profiles)for(const n of fs.readdirSync(path.join(profile(p),'state')).filter(n=>n.endsWith('.sqlite')||n.endsWith('.db'))) {
      const source=path.join(profile(p),'state',n),copy=path.join(restored,'.ardent/profiles',p,'state',n),before=probe(pkg,'snapshot',source);ownerFile(copy+'.before.json',before);probe(pkg,'compare',copy,copy+'.before.json');probe(pkg,'migrate',copy);probe(pkg,'compare',copy,copy+'.before.json');probe(pkg,'rollback-probe',copy,legacy);probe(pkg,'compare',copy,copy+'.before.json');
    }
    for(const p of c.profiles) {
      const copy=path.join(restored,'.ardent/profiles',p);
      bindingFiles(p,copy,path.join(stage,'profile-files'));ownerFile(path.join(copy,'config.yaml'),translatedProfileConfig(read(path.join(copy,'config.yaml')).toString(),c.extensions?.profiles[p]));
      run(['/usr/bin/node',c.compatibilityCheck.path,p,legacy,pkg,copy],{asOwner:true});
      for(const n of fs.readdirSync(path.join(copy,'state')).filter(n=>n.endsWith('.sqlite')||n.endsWith('.db')))probe(pkg,'compare',path.join(copy,'state',n),path.join(copy,'state',n)+'.before.json');
    }
    record.profileStateSHA256=Object.fromEntries(c.profiles.map(p=>[p,tree(profile(p))]));save('backed-up');console.log(JSON.stringify({id:c.id,phase:'backed-up',backup,backupSHA256:record.backupSHA256,machineIdSHA256:record.machineIdSHA256,configurationSHA256:record.configurationSHA256}));return;
    }
    assert(argv[0]==='apply'&&record.phase==='backed-up','Quiesce, verify the off-host backup and acknowledge it before applying');
    const ackFile=path.join(recordDir,'backup-ack.json'),ackStat=regular(ackFile);assert(ackStat.uid===0&&(ackStat.mode&0o077)===0,'Backup acknowledgement must be root-owned and private');const ack=JSON.parse(read(ackFile));assert(ack.sha256===record.backupSHA256&&ack.machineIdSHA256===record.machineIdSHA256&&ack.configurationSHA256===record.configurationSHA256,'Off-host backup acknowledgement differs');assert(fileHash(path.join(recordDir,'recovery.tar.gz'))===record.backupSHA256,'Recovery archive changed');assert(hash(read('/etc/machine-id'))===record.machineIdSHA256,'Host identity differs');
    assert(hash(read(path.join(stage,'package-lock.json')))===record.candidateLockSHA256,'Candidate dependency lock changed');
    noPending();for(const p of c.profiles){assert(system('is-active',p,true).stdout.trim()!=='active','Legacy gateway restarted after quiescence');assert(tree(profile(p))===record.profileStateSHA256[p],'Quiesced profile changed after backup');}
    assert(run(['systemctl','is-active','magnus-agent'],{allowFailure:true}).status!==0,'Lifecycle admission resumed after quiescence');
    const digest=packageDigest(pkg);
    ownerFile(path.join(stage,'package-receipt.json'),JSON.stringify({schemaVersion:1,name:'@hivemagnus/ardent',version:c.version,sha256:hash(read(c.archive)),packageTreeSha256:digest,...(record.extensionBundleSha256?{extensionBundleSha256:record.extensionBundleSha256}:{})})+'\n',0o644);
    record.candidateRuntimeSHA256=tree(stage);record.retainedRuntime=install+'.legacy-'+c.id;record.retainedPrevious=install+'.previous.legacy-'+c.id;
    assert(!fs.existsSync(record.retainedRuntime)&&!fs.existsSync(record.retainedPrevious),'Retained runtime paths conflict');
    save('promoting');
    // Both old prefixes retain their bytes, ownership, modes and inodes, including adoption proofs.
    move(install,record.retainedRuntime);if(fs.existsSync(install+'.previous'))move(install+'.previous',record.retainedPrevious);move(stage,install);
    for(const p of c.profiles) {bindingFiles(p,profile(p),path.join(install,'profile-files'));ownerFile(path.join(profile(p),'config.yaml'),translatedProfileConfig(read(path.join(profile(p),'config.yaml')).toString(),c.extensions?.profiles[p]),regular(path.join(profile(p),'config.yaml')).mode&0o777);ownerFile(unit(p),managedUnit(home,p,'@hivemagnus/ardent'),0o644);}
    const artifactRoot='/opt/hive-native-artifacts';rootControlled('/opt');if(!fs.existsSync(artifactRoot))fs.mkdirSync(artifactRoot,{mode:0o755});rootControlled(artifactRoot);const staged=path.join(artifactRoot,c.id);assert(!fs.existsSync(staged),'Native artifact staging path already exists');fs.mkdirSync(staged,{recursive:true,mode:0o755});rootControlled(staged);
    const archive=path.join(staged,'ardent-package.tgz'),sidecar=path.join(staged,'ardent-package.json');atomic(archive,read(c.archive),0o644);const detail=JSON.stringify({name:'@hivemagnus/ardent',version:c.version,sha256:hash(read(c.archive))})+'\n';atomic(sidecar,detail,0o644);atomic(path.join(staged,'component-manifest.json'),JSON.stringify({component:'agent',files:[{path:'ardent-package.tgz',sha256:hash(read(c.archive))},{path:'ardent-package.json',sha256:hash(detail)}]})+'\n',0o644);
    const env=path.join(c.agentRoot,'.env'),es=regular(env);const newEnv=record.agentEnvironment.split(/\r?\n/).filter(l=>!l.startsWith('ARDENT_STAGED_PACKAGE=')).join('\n').replace(/\n*$/,'\n')+'ARDENT_STAGED_PACKAGE='+archive+'\n';if(es.uid===owner.uid)ownerFile(env,newEnv,es.mode&0o777);else{rootControlled(path.dirname(env));atomic(env,newEnv,es.mode&0o777,{uid:es.uid,gid:es.gid});}
    run(['/usr/bin/systemctl','--user','daemon-reload'],{asOwner:true});record.failedPhase='activated';save('activated');
    for(const p of c.profiles){const f=path.join(profile(p),'jobs/active.json');if(fs.existsSync(f))migrateJobs(p,read(f).toString());}save('activated');
    for(const p of c.profiles)system('start',p);
    for(let i=0;;i++){try{await acceptance();break}catch(e){if(i>=30)throw e;await new Promise(r=>setTimeout(r,1000));}}
    assert(tree(record.retainedRuntime)===record.runtimeSHA256,'Retained legacy runtime changed');if(record.previousSHA256)assert(tree(record.retainedPrevious)===record.previousSHA256,'Retained older checkpoint changed');
    if(record.agentWasActive)run(['systemctl','start','magnus-agent']);resumeAuxiliary();save('complete');console.log(JSON.stringify({id:c.id,phase:'complete',version:c.version,profiles:c.profiles,backupSHA256:record.backupSHA256,legacyRuntimeRetained:true}));
  } catch(e) {
    fs.writeSync(log,String(e.stack??e)+'\n');if(record.phase!=='held')record.failedPhase=record.phase;record.error='Migration stopped; inspect the private diagnostic and retained recovery archive';
    // Never restore data or replay an interrupted promotion. Preserve every recorded checkpoint.
    if(['stopping','quiesced','prepared','backed-up'].includes(record.phase)) {for(const p of c.profiles)system('start',p,true);if(record.agentWasActive)run(['systemctl','start','magnus-agent'],{allowFailure:true});for(const u of record.activeAuxiliaryUnits??[])run(['/usr/bin/systemctl','--user','start',u],{asOwner:true,allowFailure:true});}
    if(['promoting','activated'].includes(record.phase))for(const p of c.profiles)system('stop',p,true);
    save('held');throw e;
  } finally {fs.closeSync(log);fs.closeSync(lockFd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error('Legacy Ardent migration stopped. Inspect its private record; do not replay a held transition.');process.exitCode=1});
