#!/usr/bin/env node
// Two host inventories over real pinned SSH, with isolated Compose projects on
// the developer host. This does not certify two physical machines or suite APIs.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { fixtureCatalog, hiveRegistryComponent } from './suite-catalog.mjs';
import { startRegistryImage } from './registry-image-fixture.mjs';
const root=resolve(import.meta.dirname,'../..'),index=process.argv.indexOf('--output');
assert(index>=0 && process.argv[index+1],'--output NEW_PRIVATE_DIRECTORY is required');
const output=resolve(process.argv[index+1]);assert(!existsSync(output));assert(/^\/[A-Za-z0-9_./-]+$/.test(output));mkdirSync(output,{recursive:true,mode:0o700});chmodSync(output,0o700);
const put=(path,value,mode=0o600)=>{writeFileSync(path,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2));chmodSync(path,mode);};
const run=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).trim();
const docker=(...args)=>run('docker',args);
const id='ssh-proof-'+randomBytes(5).toString('hex'),username=userInfo().username;
assert.notEqual(process.getuid(),0,'Use an unprivileged operator with Docker access');
const user=`${process.getuid()}:${process.getgid()}`,image='node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const configFile=join(output,'installation.json'),releaseFile=join(output,'release.json'),sshConfig=join(output,'ssh.conf');
const addresses={first:join(output,'first'),second:join(output,'second')};
const listener=createServer().listen(0,'127.0.0.1');await new Promise(done=>listener.once('listening',done));const sshPort=listener.address().port;await new Promise(done=>listener.close(done));
let daemon,logDescriptor,registryImage,passed=false;
const projects=[id+'-first',id+'-second'];
function hive(command,...extra){try{return run(join(root,'hive.sh'),[command,'--config',configFile,'--manifest',releaseFile,'--trust-key',join(output,'publisher.pub'),'--non-interactive','--yes',...extra],{maxBuffer:8*1024*1024});}catch(error){put(join(output,command+'-failure.log'),String(error.stdout||'')+'\n'+String(error.stderr||''));throw error;}}
try{
 for(const name of ['host','client','wrong-host'])run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(output,name)]);
 put(join(output,'authorized_keys'),readFileSync(join(output,'client.pub')));
 const known='[127.0.0.1]:'+sshPort+' '+readFileSync(join(output,'host.pub'),'utf8');put(join(output,'known_hosts'),known);
 const bin=join(output,'bin');mkdirSync(bin,{mode:0o700});const actualDocker=run('sh',['-c','command -v docker']);
 put(join(bin,'docker'),`#!/usr/bin/env bash\nif [[ "\${1:-}" == compose && "\${2:-}" == -f && "\${3:-}" == '${addresses.second}/candidate.'*.json && " $* " == *' up '* && ! -e '${output}/activation-interrupted' ]]; then\n touch '${output}/activation-interrupted'\n exit 23\nfi\nexec '${actualDocker}' "$@"\n`,0o700);
 put(join(output,'sshd.conf'),`Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${output}/host\nPidFile ${output}/sshd.pid\nAuthorizedKeysFile ${output}/authorized_keys\nAllowUsers ${username}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nUsePAM no\nPermitRootLogin no\nAllowTcpForwarding no\nX11Forwarding no\nPermitTTY no\nSetEnv PATH=${bin}:${process.env.PATH}\nSubsystem sftp internal-sftp\n`);
 put(sshConfig,`Host first.example.com second.example.com\n HostName 127.0.0.1\n Port ${sshPort}\n UserKnownHostsFile ${output}/known_hosts\n IdentityFile ${output}/client\n IdentityAgent none\n IdentitiesOnly yes\n StrictHostKeyChecking yes\n BatchMode yes\n ConnectTimeout 5\n LogLevel ERROR\n`);
 const {openSync,closeSync}=await import('node:fs');logDescriptor=openSync(join(output,'sshd.log'),'wx',0o600);
 daemon=spawn('/usr/sbin/sshd',['-D','-e','-f',join(output,'sshd.conf')],{stdio:['ignore',logDescriptor,logDescriptor]});await new Promise(done=>setTimeout(done,200));closeSync(logDescriptor);logDescriptor=undefined;
 assert.equal(run('ssh',['-F',sshConfig,username+'@first.example.com','command -v docker']),join(bin,'docker'),'Fixture SSH shell did not use the controlled failure adapter');
 const components={},secrets={};
 for(const host of Object.keys(addresses)){
  const directory=addresses[host],name=host+'-probe';mkdirSync(join(directory,'config',name),{recursive:true,mode:0o700});
  secrets[host]=randomBytes(32).toString('hex');put(join(directory,'config',name+'.env'),'SYNTHETIC_CREDENTIAL='+secrets[host]+'\nSUBJECT_ID=synthetic-'+host+'-account\n');
  put(join(directory,'config',name,'service.mjs'),`import http from 'node:http';import{DatabaseSync}from'node:sqlite';const database=new DatabaseSync('/data/state.sqlite');database.exec('CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,credential TEXT); CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER);');database.prepare('INSERT OR IGNORE INTO accounts VALUES (?,?)').run(process.env.SUBJECT_ID,process.env.SYNTHETIC_CREDENTIAL);database.exec("INSERT OR IGNORE INTO counters VALUES('enrollment',1)");const server=http.createServer((req,res)=>res.end('ready')).listen(8080,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>{database.close();process.exit(0)}));`);
  components[name]={host,envFile:join(directory,'config',name+'.env'),configDirectory:join(directory,'config',name)};
 }
 registryImage=await startRegistryImage(id);
 components['hive-registry']={host:'first',envFile:join(addresses.first,'config/hive-registry.env'),configDirectory:join(addresses.first,'config/hive-registry')};
 const config={schema:1,installation:id,release:'0.1.0',profile:'custom',origin:'https://console.example.com',hosts:Object.fromEntries(Object.entries(addresses).map(([host,directory])=>[host,{target:username+'@'+host+'.example.com',sshConfig,directory}])),components,agents:[],inference:[]};
 const release={schema:1,version:'0.1.0',profiles:{core:Object.keys(components),full:Object.keys(components)},components:Object.fromEntries(Object.keys(components).map(name=>[name,name==='hive-registry'?hiveRegistryComponent(registryImage.image,user):{image,storageFormat:'synthetic-v1',catalog:fixtureCatalog(name),service:{user,command:['node','/config/service.mjs'],healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],interval:'1s',timeout:'3s',retries:20}}}]))};
 put(configFile,config);put(releaseFile,release);run('openssl',['genpkey','-algorithm','ED25519','-out',join(output,'publisher.key')]);run('openssl',['pkey','-in',join(output,'publisher.key'),'-pubout','-out',join(output,'publisher.pub')]);run('openssl',['pkeyutl','-sign','-inkey',join(output,'publisher.key'),'-rawin','-in',releaseFile,'-out',releaseFile+'.sig']);
 // Reject an unknown host key before any ownership, data or transaction writes.
 put(join(output,'known_hosts'),'[127.0.0.1]:'+sshPort+' '+readFileSync(join(output,'wrong-host.pub'),'utf8'));
 let rejected=false;try{hive('doctor');}catch{rejected=true;}assert(rejected);
 for(const directory of Object.values(addresses))assert(!existsSync(join(directory,'installation.json')));
 put(join(output,'known_hosts'),known);
 let interrupted=false;try{hive('install');}catch{interrupted=true;}assert(interrupted && existsSync(join(output,'activation-interrupted')),'Second-host activation was not interrupted');
 for(const project of projects)assert.equal(docker('ps','-q','--filter','label=com.docker.compose.project='+project),'','A host writer remained active after the suite hold');
 const secondEnvironment=join(addresses.second,'config/second-probe.env'),originalEnvironment=readFileSync(secondEnvironment);
 put(secondEnvironment,'SYNTHETIC_CREDENTIAL=unreviewed-synthetic-change\nSUBJECT_ID=synthetic-second-account\n');
 let driftRejected=false;try{hive('install');}catch{driftRejected=readFileSync(join(output,'install-failure.log'),'utf8').includes('Deployment input artifacts changed');}
 assert(driftRejected,'An interrupted run accepted changed credential input');put(secondEnvironment,originalEnvironment);
 put(join(output,'resume.log'),hive('install'));
 const readState=host=>{
  const service=host+'-probe',definition=join(addresses[host],'compose.json');
  return JSON.parse(docker('compose','-f',definition,'exec','-T',service,'node','--input-type=module','-e',`import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';const db=new DatabaseSync('/data/state.sqlite',{readOnly:true});const account=db.prepare('SELECT * FROM accounts').get();console.log(JSON.stringify({id:account.id,credentialSHA256:createHash('sha256').update(account.credential).digest('hex'),enrollments:db.prepare("SELECT value FROM counters WHERE name='enrollment'").get().value}));db.close();`));
 };
 const before=Object.fromEntries(Object.keys(addresses).map(host=>[host,readState(host)]));
 for(const host of Object.keys(addresses)){assert.equal(before[host].id,'synthetic-'+host+'-account');assert.equal(before[host].credentialSHA256,createHash('sha256').update(secrets[host]).digest('hex'));assert.equal(before[host].enrollments,1);}
 put(join(output,'repeat.log'),hive('install'));
 assert.deepEqual(Object.fromEntries(Object.keys(addresses).map(host=>[host,readState(host)])),before);
 put(join(output,'backup.log'),hive('backup','--archive','paired'));
 put(join(output,'rehearse.log'),hive('rehearse','--archive','paired'));
 const ownership=Object.fromEntries(Object.keys(addresses).map(host=>[host,JSON.parse(readFileSync(join(addresses[host],'installation.json'),'utf8')).uuid]));
 assert.notEqual(ownership.first,ownership.second);
 for(const host of Object.keys(addresses)){const result=JSON.parse(readFileSync(join(addresses[host],'rehearsals/paired/result.json'),'utf8'));assert.equal(result.result,'passed');assert.equal(result.installationUUID,ownership[host]);}
 put(join(output,'result.json'),{schema:1,result:'passed',productionCutover:false,physicalHosts:1,sshTargets:2,checks:['real strict SSH/SFTP transport with no global SSH changes','wrong host-key refusal before ownership writes','second-host activation interruption holds all writers','changed mounted credentials rejected during interrupted execution','exact retry and repeat retain independent account IDs and credentials','one enrollment per product','host-bound backups and independent isolated restore rehearsals'],states:before});
 passed=true;console.log('PASS: two SSH host inventories, strict trust, cross-host activation hold/resume, stable independent credentials/IDs, repeat execution and separate restore rehearsals.');
}catch(error){console.error('Private multi-host proof retained at '+output);throw error;}
finally{
 for(const host of Object.keys(addresses))for(const file of [join(addresses[host],'rehearsals/paired/isolated.json'),join(addresses[host],'compose.json')])if(existsSync(file))try{docker('compose','-f',file,'down','--remove-orphans');}catch{}
 for(const project of projects)for(const container of docker('ps','-aq','--filter','label=com.docker.compose.project='+project).split(/\s+/).filter(Boolean))try{docker('rm','-f',container);}catch{}
 if(daemon){daemon.kill('SIGTERM');await new Promise(done=>{if(daemon.exitCode!==null)done();else daemon.once('close',done);});}
 registryImage?.stop();
 if(!passed)console.error('Only generated local SSH credentials and disposable stores were selected.');
}
