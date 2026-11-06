// Developer-only coordinated authentication proof for this driver's fresh,
// disposable two-inventory fixture. Never accepts an existing installation.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createServer,connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { sudoHost } from './sudo-target.mjs';

export async function restoredPeerRehearsal({ output, addresses, config, docker, put, request, credentials, identities, consoleHost=config.console.host }) {
  assert(/^distributed-[a-f0-9]{10}$/.test(config.installation), 'Only this fresh developer fixture may be selected');
  assert.equal(config.origin, 'https://localhost:' + config.console.httpsPort);
  const evidence=join(output,'peer-auth'); assert(!existsSync(evidence)); mkdirSync(evidence,{mode:0o700});
  const paths={}, originals={};
  for(const [host,directory] of Object.entries(addresses)) {
    assert.equal(resolve(directory),resolve(output,host));
    const source=join(directory,'rehearsals/distributed'), isolated=JSON.parse(readFileSync(join(source,'isolated.json'),'utf8'));
    assert(isolated.name.startsWith('rehearsal-'+config.installation+'-'+host+'-'));
    assert(Object.values(isolated.networks).every(network=>network.internal===true),'Every original restore network must be internal');
    originals[host]=fingerprint(source);
    const destination=join(evidence,host); mkdirSync(destination,{mode:0o700});
    // As root (scripts/suite/sudo-host.sh), each copy keeps its owners, as a host restore does.
    for(const part of ['config','data']) {
      if(sudoHost) execFileSync('cp',['-a','--',join(source,part),join(destination,part)]);
      else cpSync(join(source,part),join(destination,part),{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true});
    }
    for(const service of Object.values(isolated.services)) for(const mount of service.volumes??[]) {
      assert(mount.type==='bind' && mount.source.startsWith(source+'/'),'Restore contains an unexpected mount');
      mount.source=destination+mount.source.slice(source.length);
    }
    for(const service of Object.values(isolated.services)) if(service.env_file) service.env_file=service.env_file.map(file=>{assert(file.startsWith(source+'/'));return destination+file.slice(source.length);});
    paths[host]={source,destination,originalCompose:join(directory,'compose.json'),isolatedCompose:join(source,'isolated.json'),file:join(destination,'peer.compose.json'),compose:isolated};
  }
  const network=config.installation+'-peer-auth'; let created=false,proofResult,relay;const sockets=new Set();
  try {
    // Browser review has completed. Stop all original disposable writers before
    // reusing their exact console origin; remove only this fixture's networks.
    for(const item of Object.values(paths)) {
      docker('compose','-f',item.originalCompose,'down','--remove-orphans');
      docker('compose','-f',item.isolatedCompose,'down','--remove-orphans');
    }
    docker('network','create','--internal','--label','hive.disposable-fixture='+config.installation,network); created=true;
    const ports={oathweave:4200,emberpath:9443,hivemem:18790,hiveskills:4030,magnus:4000,cindertrace:4101,chattermost:8065};
    for(const [host,item] of Object.entries(paths)) {
      item.compose.name+='-peer'; item.compose.networks.peer={external:true,name:network};
      for(const [name,service] of Object.entries(item.compose.services)) {
        assert(!service.ports,'Restore unexpectedly publishes ports');
        assert.equal(service.environment.HIVE_REHEARSAL,'true');
        if(ports[name] || ['ingress','hivexui','emberfold'].includes(name)) {
          if(!service.networks)service.networks=['default'];
          if(Array.isArray(service.networks))service.networks.push('peer');else service.networks.peer={};
        }
        if(name==='chattermost') {
          service.environment.AUTHENTICATED_REHEARSAL='true';
          const env=parseEnv(readFileSync(service.env_file[0],'utf8')),url=new URL(env.DATABASE_URL);
          url.searchParams.set('options','-c default_transaction_read_only=on'); service.environment.DATABASE_URL=url.toString();
        }
        if(name==='ingress') {
          // Docker does not expose published ports on an internal-only bridge.
          // The operator's loopback relay below forwards verified TLS bytes.
          for(const [product,port] of Object.entries(ports)) {
            const label=product.toUpperCase();service.environment[label+'_ENDPOINT']='https://'+product+':'+port;service.environment[label+'_TLS_NAME']='localhost';
          }
          service.environment.EMBERPATH_API_ENDPOINT='https://emberpath:4020';service.environment.EMBERPATH_API_TLS_NAME='localhost';
          const caddy=join(item.destination,'config/ingress/Caddyfile'),original=readFileSync(caddy,'utf8'),marker='{$HIVE_CONSOLE_HOST} {';
          assert(original.includes(marker));
          assert(original.startsWith('{\n'));
          put(caddy,original.replace(/^\{\n/,'{\n\torder route first\n').replace(marker,marker+`\n\t# Disposable clone accepts only reads and authentication.\n\t@rehearsal_mutation {\n\t\tnot method GET HEAD\n\t\tnot path /api/oathweave/auth/login /api/oathweave/oauth/authorize /api/oathweave/oauth/token /api/oathweave/browser/logout /api/v4/users/login /api/v4/users/login/type /api/v4/users/logout /api/v4/auth/oathweave/session /api/chattermost/api/v4/auth/oathweave/session /api/cindertrace/auth/local/login\n\t}\n\troute @rehearsal_mutation {\n\t\trespond "null" 503\n\t}\n`));
        }
      }
      put(item.file,item.compose);
    }
    const identity=paths.identity;
    docker('compose','-f',identity.file,'up','-d','--wait','--wait-timeout','90','oathweave');
    const identityId=docker('compose','-f',identity.file,'ps','-q','oathweave'),identityIp=JSON.parse(docker('inspect',identityId))[0].NetworkSettings.Networks[network].IPAddress;assert(identityIp);
    for(const item of Object.values(paths)) {
      for(const [name,service] of Object.entries(item.compose.services)) if(ports[name] && name!=='oathweave') {
        service.extra_hosts={'localhost.':identityIp};
        service.environment.OATHWEAVE_JWKS_URL='https://localhost.:4200/api/v1/oauth/jwks';
        service.environment.OATHWEAVE_USERINFO_URL='https://localhost.:4200/api/v1/oauth/userinfo';
        if(name==='chattermost') {
          // The native wrapper intentionally prioritizes its protected runtime
          // file over process environment. Change both derived copies only.
          const projected=service.env_file[0],base=parseEnv(readFileSync(projected,'utf8'));
          assert.equal(base.CHATTERMOST_ENV_FILE,'/config/runtime.env');
          const mount=service.volumes.find(value=>value.target==='/config');assert(mount);
          for(const file of [projected,join(mount.source,'runtime.env')]) {
            const env=parseEnv(readFileSync(file,'utf8'));
            for(const key of ['DATABASE_URL','OATHWEAVE_JWKS_URL','OATHWEAVE_USERINFO_URL'])env[key]=service.environment[key];
            put(file,Object.entries(env).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n');
          }
        }
      }
      put(item.file,item.compose); docker('compose','-f',item.file,'up','-d','--wait','--wait-timeout','120');
    }
    const ingressId=docker('compose','-f',paths[consoleHost].file,'ps','-q','ingress'),ingressIp=JSON.parse(docker('inspect',ingressId))[0].NetworkSettings.Networks[network].IPAddress;assert(ingressIp);
    relay=createServer(client=>{
      const peer=connect({host:ingressIp,port:8443});sockets.add(client);sockets.add(peer);
      client.on('error',()=>peer.destroy());peer.on('error',()=>client.destroy());
      client.on('close',()=>{sockets.delete(client);peer.destroy();});peer.on('close',()=>{sockets.delete(peer);client.destroy();});
      client.pipe(peer);peer.pipe(client);
    });
    await new Promise((done,reject)=>{relay.once('error',reject);relay.listen(config.console.httpsPort,'127.0.0.1',done);});
    put(join(evidence,'transport.json'),{schema:1,loopbackOnly:true,tlsTermination:false,origin:config.origin,peerIngress:ingressIp,backendNetworksInternal:true});
    const chatCompose=paths[consoleHost].file;
    const chatSnapshot=()=>docker('compose','-f',chatCompose,'exec','-T','chattermost-postgres','psql','-U','chattermost_app','-d','chattermost','-At','-c','SELECT value FROM "RuntimeState";');
    const before=chatSnapshot();
    // The restored Hive Registry answers public lookups through the ingress and refuses writes.
    const registrySummary=await request('/api/registry/v1/installation');assert.equal(registrySummary.status,200);assert.equal(registrySummary.body.id,config.installation);
    assert.throws(()=>docker('compose','-f',paths[consoleHost].file,'exec','-T','hive-registry','node','/app/dist/cli.js','request','DELETE','/v1/products/any-product','write'),'A restored registry accepted a write');
    const browserHeaders={Origin:config.origin,'X-Oathweave-Browser':'true'};
    const login=await request('/api/oathweave/auth/login',{username:credentials.SEED_ADMIN_USERNAME,password:credentials.SEED_ADMIN_PASSWORD},browserHeaders);assert.equal(login.status,200,'Restored original password failed');
    const cookie=login.headers['set-cookie'].find(value=>value.startsWith('__Host-oathweave_sso=')).split(';')[0],headers={...browserHeaders,Cookie:cookie},tokens={};
    const routes={oathweave:'/api/oathweave/auth/me',emberpath:'/api/emberpath/auth/me',hivemem:'/api/hivemem/agents',hiveskills:'/api/hiveskills/admin/skills',cindertrace:'/api/cindertrace/security-fusion/overview',magnus:'/api/magnus/console/session'};
    for(const product of [...Object.keys(routes),'chattermost']) {
      const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
      const code=await request('/api/oathweave/oauth/authorize',{clientId:'hivexui-'+product,redirectUri:config.origin+'/auth/callback',responseType:'code',codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256',scope:'openid profile',state,nonce},headers);assert.equal(code.status,200);assert.equal(code.body.state,state);
      const token=await request('/api/oathweave/oauth/token',{grant_type:'authorization_code',client_id:'hivexui-'+product,code:code.body.code,code_verifier:verifier,redirect_uri:config.origin+'/auth/callback'},headers);assert.equal(token.status,200);tokens[product]=token.body.access_token;
      const payload=JSON.parse(Buffer.from(tokens[product].split('.')[1],'base64url'));assert.equal(payload.sub,identities['identity-id']);assert.equal(payload.aud,product);
    }
    for(const [product,path] of Object.entries(routes))assert.equal((await request(path,null,{Authorization:'Bearer '+tokens[product]})).status,200,'Restored peer authorization failed: '+product);
    assert.equal((await request(routes.emberpath,null,{Authorization:'Bearer '+tokens.oathweave})).status,401);
    const exchange=await request('/api/chattermost/api/v4/auth/oathweave/session',{}, {Authorization:'Bearer '+tokens.chattermost,Origin:config.origin});assert.equal(exchange.status,200);
    const chatCookie=exchange.headers['set-cookie'].find(value=>value.startsWith('MMSID=')).split(';')[0];
    const chatHeaders={Cookie:chatCookie,Origin:config.origin};assert.equal((await request('/api/v4/users/me',null,chatHeaders)).status,200);
    const proof=JSON.parse(readFileSync(join(output,'full-chat-proof.json'),'utf8'));
    assert.equal((await request('/api/v4/posts/'+proof.postId,null,chatHeaders)).status,200,'Restored chat content failed authorized read');
    assert(proof.fileId && proof.fileSha256,'The fresh fixture must include a retained attachment');
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(proof.fileId) && /^[a-f0-9]{64}$/.test(proof.fileSha256),'The retained attachment has an unexpected identifier or digest');
    // Run the native client inside the isolated peer bridge, retaining original
    // origin checks and verified TLS. Secrets live in a protected clone file.
    const nativeProof=join(paths[consoleHost].destination,'config/chattermost/peer-read-proof.mjs');
    put(nativeProof,`import assert from 'node:assert/strict';import {createRequire} from 'node:module';import fs from 'node:fs';import https from 'node:https';import {createHash} from 'node:crypto';const WebSocket=createRequire('/app/package.json')('ws'),ca=fs.readFileSync('/config/authority.pem'),headers=${JSON.stringify({...chatHeaders,Host:new URL(config.origin).host})};
      const bytes=await new Promise((done,reject)=>{https.get(${JSON.stringify('https://ingress:8443/api/v4/files/'+encodeURIComponent(proof.fileId))},{ca,servername:'localhost',headers},response=>{assert.equal(response.statusCode,200);const parts=[];response.on('data',p=>parts.push(p));response.on('end',()=>done(Buffer.concat(parts)));}).on('error',reject);});assert.equal(createHash('sha256').update(bytes).digest('hex'),${JSON.stringify(proof.fileSha256)});
      const ws=new WebSocket('wss://ingress:8443/api/v4/websocket',{ca,servername:'localhost',headers});await new Promise((done,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(Error('Restored socket timeout'));},8000);ws.on('error',reject);ws.on('message',raw=>{const message=JSON.parse(raw);if(message.event==='hello')ws.send(JSON.stringify({seq:1,action:'ping',data:{}}));if(message.seq_reply===1){assert.equal(message.status,'OK');clearTimeout(timer);ws.close();done();}});});console.log('PASS restored native attachment and authenticated WSS ping');`);
    // A new file in the product's own configuration belongs to its owner, as the copy does.
    if(sudoHost) execFileSync('chown',['--reference',join(paths[consoleHost].destination,'config/chattermost'),nativeProof]);
    put(join(evidence,'native-read-proof.log'),docker('compose','-f',chatCompose,'exec','-T','chattermost','node','/config/peer-read-proof.mjs'));

    assert.equal((await request('/api/v4/posts',{channel_id:'invalid',message:'must not write'},chatHeaders)).status,503);
    assert.equal((await request('/api/emberpath/providers',{name:'forbidden'}, {Authorization:'Bearer '+tokens.emberpath})).status,503);
    const nativeEnv=parseEnv(readFileSync(join(paths[consoleHost].destination,'config/chattermost.env'),'utf8'));
    assert.equal((await request('/api/v4/users/login',{login_id:nativeEnv.ADMIN_USERNAME,password:nativeEnv.ADMIN_PASSWORD},{Origin:config.origin})).status,200);
    // Tokens are demonstrably live immediately before revocation.
    assert.equal((await request(routes.cindertrace,null,{Authorization:'Bearer '+tokens.cindertrace})).status,200);
    assert.equal((await request('/api/oathweave/browser/logout',{},headers)).status,200);
    for(const product of ['emberpath','hivemem','hiveskills','cindertrace'])assert.equal((await request(routes[product],null,{Authorization:'Bearer '+tokens[product]})).status,401,'Restored revoked token accepted: '+product);
    // Magnus documents online revocation within 15 seconds of logout.
    let magnusRevoked;for(let attempt=0;attempt<25&&magnusRevoked!==401;attempt++){if(attempt)await new Promise(done=>setTimeout(done,1000));magnusRevoked=(await request(routes.magnus,null,{Authorization:'Bearer '+tokens.magnus})).status;}
    assert.equal(magnusRevoked,401,'Restored revoked token accepted: magnus');
    assert.equal((await request('/api/v4/users/me',null,chatHeaders)).status,401,'Restored bound chat session ignored revocation');
    assert.equal(chatSnapshot(),before,'Authenticated clone changed durable chat records');
    proofResult={schema:1,result:'passed',productionCutover:false,helperSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),physicalHosts:1,sshInventories:2,checks:['original restored config and data preserved separately','one active disposable clone set; original writers stopped','same issuer, keys, client registrations, IDs and original passwords','verified HTTPS peers on isolated internal bridge; no external endpoints reachable','six resource PKCE, restored product reads, wrong audience rejection','restored native chat password, retained post/attachment read and authenticated WSS ping','unexpired resource and bound chat cookie revoked online','durable mutations refused; original chat RuntimeState unchanged','restored Hive Registry answers public lookups and refuses writes']};
  } catch(error) {
    for(const [host,item] of Object.entries(paths))if(existsSync(item.file))try {
      put(join(evidence,host+'-containers.log'),docker('compose','-f',item.file,'logs','--no-color','--tail','250'));
    } catch {}
    throw error;
  } finally {
    for(const socket of sockets)socket.destroy();
    if(relay)await new Promise(done=>relay.close(()=>done()));
    for(const item of Object.values(paths))if(existsSync(item.file))try{docker('compose','-f',item.file,'down','--remove-orphans');}catch{}
    if(created)try{docker('network','rm',network);}catch{}
    for(const [host,item] of Object.entries(paths)) {
      assert.equal(fingerprint(item.source),originals[host],'Original isolated restore bytes changed');
      assert.equal(docker('ps','-q','--filter','label=com.docker.compose.project='+item.compose.name),'','A disposable peer writer remains active');
    }
  }
  if(proofResult)put(join(evidence,'result.json'),proofResult);
}
function fingerprint(root) {
  const hash=createHash('sha256');
  function walk(directory){for(const name of readdirSync(directory).sort()){const file=join(directory,name),info=lstatSync(file);hash.update(file.slice(root.length));hash.update(JSON.stringify([info.mode,info.uid,info.gid]));if(info.isDirectory())walk(file);else if(info.isFile())hash.update(readFileSync(file));else throw Error('Unexpected restore file type');}}
  walk(root);return hash.digest('hex');
}
