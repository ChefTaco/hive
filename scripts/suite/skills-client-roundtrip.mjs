#!/usr/bin/env node
// Isolated root staging proof; never mounts a host profile or privileged socket.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync,copyFileSync,existsSync,chmodSync,readFileSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { generateKeyPairSync,sign,createHash } from 'node:crypto';
const options={};for(let i=2;i<process.argv.length;i+=2){assert(['--output','--skills-root'].includes(process.argv[i])&&process.argv[i+1]);options[process.argv[i].slice(2)]=resolve(process.argv[i+1])}assert(options.output&&options['skills-root']&&!existsSync(options.output),'Select new private --output and --skills-root');
const output=options.output;mkdirSync(output,{recursive:true,mode:0o700});chmodSync(output,0o700);
const put=(name,value)=>writeFileSync(join(output,name),value,{mode:0o600});
const {buildNativeClient}=await import(join(options['skills-root'],'scripts/build-native-client.mjs'));
const artifact=buildNativeClient({sourceRoot:options['skills-root'],output:join(output,'artifact'),url:'https://artifacts.example.com/hiveskills-client-1.2.2.tar.gz',nodeVersion:'v24.22.3'});
copyFileSync(join(output,'artifact','hiveskills-client-'+artifact.version+'.tar.gz'),join(output,'client.tgz'));
copyFileSync(resolve(import.meta.dirname,'skills-integration-host.sh'),join(output,'helper.sh'));
const manifest=JSON.stringify({schema:1,version:'1.2.2',profiles:{core:['hiveskills','magnus'],full:['hiveskills','magnus']},components:Object.fromEntries(['hiveskills','magnus'].map(name=>[name,{image:'example.com/fixture@sha256:'+('0'.repeat(64)),service:{user:'1000:1000',healthcheck:{test:['CMD','true']}}}])),nativeClients:{hiveskills:artifact}}),keys=generateKeyPairSync('ed25519');put('manifest.fixture.json',manifest);put('signature.fixture',sign(null,Buffer.from(manifest),keys.privateKey));put('trust.fixture.pub',keys.publicKey.export({format:'pem',type:'spki'}));
put('input.json',JSON.stringify({digest:createHash('sha256').update(manifest).digest('hex'),skillsClientArchive:'/fixture/client.tgz',placements:{hiveskills:{}},skillsDeployment:{registryId:'fixture-registry',clientVersion:artifact.version,executor:{origin:'https://magnus.example.com',credentialFile:'/fixture/executor'},targets:[{target:'fixture-target',host:'fixture-host',nodeId:'fixture-existing-node',agentTarget:'fixture-native',owner:'node',home:'/opt/operator',hermesHome:'/opt/operator/hermes',environmentFile:'/opt/operator/native.env',clientDirectory:'/opt/skills-client',nodeBinary:'/usr/local/bin/node'}]}}));
put('executor','obviously-fake-protected-backend-token-for-fixture');
const publicRoot=resolve(import.meta.dirname,'../..'),runtimeFiles=execFileSync('bash',['-c','source "$HIVE_ROOT/scripts/suite/controller.sh"; hive_runtime_files'],{encoding:'utf8',env:{...process.env,HIVE_ROOT:publicRoot}}).trim().split('\n');
for(const file of runtimeFiles){const destination=join(output,'runtime',file);mkdirSync(dirname(destination),{recursive:true,mode:0o700});copyFileSync(join(publicRoot,file),destination)}
const payload=JSON.parse(readFileSync(join(output,'input.json')));put('installation.json',JSON.stringify({schema:1,installation:'fixture',release:'1.2.2',profile:'custom',origin:'https://console.example.com',hosts:{'fixture-host':{target:'local',directory:'/opt/suite'}},components:{hiveskills:{host:'fixture-host'},magnus:{host:'fixture-host'}},agents:[],inference:[],skillsDeployment:payload.skillsDeployment}));

put('Dockerfile',`FROM node:24.22.3-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends jq openssl curl && rm -rf /var/lib/apt/lists/*\nCOPY . /fixture\nRUN chmod 700 /fixture && install -d -o node -g node -m 700 /opt/operator /opt/operator/hermes && printf 'HIVE_SKILLS_URL=https://skills.example.com\\nHIVE_SKILLS_TARGET_TOKEN=obviously-fake-protected-native-token-for-fixture\\n' > /opt/operator/native.env && chown node:node /opt/operator/native.env && chmod 600 /opt/operator/native.env\nENTRYPOINT ["bash","/fixture/proof.sh"]\n`);
put('proof.sh',`set -euo pipefail
source /fixture/helper.sh
directory=/fixture; plan=fixture; host=fixture-host; input=$(cat /fixture/input.json)
before=$(sha256sum /opt/operator/native.env /fixture/executor)
skills_integration_preflight
skills_integration_stage
skills_integration_preflight
artifact=$(skills_integration_artifact); item=$(jq -c '.skillsDeployment.targets[0]' <<< "$input")
skills_integration_verify_client "$item" "$artifact"
client=/opt/skills-client/$(jq -er .sha256 <<< "$artifact")
first=$(stat -c '%i:%Y' "$client/hermes-sync.mjs")
skills_integration_stage
[[ "$first" == "$(stat -c '%i:%Y' "$client/hermes-sync.mjs")" ]]
[[ "$before" == "$(sha256sum /opt/operator/native.env /fixture/executor)" ]]
# Non-root may verify an existing exact immutable artifact but never stage a new one.
chmod 755 /fixture; chmod 644 /fixture/{input.json,manifest.fixture.json,signature.fixture,trust.fixture.pub,helper.sh}
runuser -u node -- bash -c 'set -euo pipefail; source /fixture/helper.sh; directory=/fixture;plan=fixture;host=fixture-host;input=$(jq "del(.placements.hiveskills)" /fixture/input.json);skills_integration_preflight;skills_integration_stage'
# Exercise the actual CLI against the prepared immutable client. Network isolation
# intentionally leaves readiness held while protected proposals remain reviewable.
install -d -m 700 /opt/suite/config
printf '{"installation":"fixture","host":"fixture-host"}\\n' > /opt/suite/installation.json
printf 'KEEP_IMMUTABLE=true\\n' > /opt/suite/config/immutable.env
immutable=$(sha256sum /opt/suite/config/immutable.env)
status=0; bash /fixture/runtime/hive.sh skills-prepare --config /fixture/installation.json --manifest /fixture/manifest.fixture.json --signature /fixture/signature.fixture --trust-key /fixture/trust.fixture.pub --non-interactive --yes > /fixture/command.log 2>&1 || status=$?
[[ $status == 2 ]] || { cat /fixture/command.log >&2; exit 22; }
proposal=$(find /opt/suite/config/skills-proposals -name '*.json')
jq -e '.activated==false and .operatorActionRequired==true and .nativeTargets["fixture-native"].registryId=="fixture-registry" and (.magnusGrants["fixture-registry"].tokenSha256|length)==64' "$proposal" >/dev/null
! grep -q 'obviously-fake-protected-backend-token-for-fixture' "$proposal"
[[ "$immutable" == "$(sha256sum /opt/suite/config/immutable.env)" ]]
# Changed existing bytes must be retained, rejected and never overwritten.
printf '\\n// fixture tamper\\n' >> "$client/hermes-sync.mjs"
changed=$(sha256sum "$client/hermes-sync.mjs")
if skills_integration_stage >/dev/null 2>&1; then exit 21; fi
[[ "$changed" == "$(sha256sum "$client/hermes-sync.mjs")" ]]
printf 'exact-client-stage-pass\\n'
`);
const run=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
let image;try{run(['build','-q','-t','skills-client-staging:proof',output]);image=run(['image','inspect','skills-client-staging:proof','--format','{{.Id}}']).trim();const logs=run(['run','--rm','--network','none','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID','--security-opt','no-new-privileges:true',image]);put('proof.log',logs);assert.match(logs,/exact-client-stage-pass/);put('result.json',JSON.stringify({schema:1,passed:true,image,artifactSHA256:artifact.sha256,clientSHA256:artifact.files['hermes-sync.mjs'],scope:'Disposable root container and synthetic owner profile; no production mounts or services',checks:['signed-release','exact-public-client-file-pins','root-only-new-stage','existing-client-nonroot-verification','repeat-inode-preserved','credentials-unchanged','tampered-existing-client-held-without-overwrite','actual-cli-held-with-protected-reference-only-proposal','immutable-bootstrap-environment-unchanged']},null,2)+'\n');console.log('Isolated immutable Skills client staging passed.')}catch(error){put('failure.log',String(error.stderr??error.message));throw Error('Isolated Skills client staging failed; inspect protected evidence')}
