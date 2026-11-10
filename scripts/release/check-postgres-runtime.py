#!/usr/bin/env python3
# Disposable old-to-new PostgreSQL runtime, ownership and recovery acceptance.
import argparse,subprocess,uuid,time,json
parser=argparse.ArgumentParser();parser.add_argument('--baseline',required=True);parser.add_argument('--candidate',required=True);parser.add_argument('--major',required=True,choices=['17','18']);parser.add_argument('--platform',choices=['linux/amd64','linux/arm64']);a=parser.parse_args()
prefix='hive-pg-runtime-'+uuid.uuid4().hex[:12];names=set();volumes=set()
def call(*args,check=True):
 if args and args[0]=='run' and a.platform:args=('run','--platform',a.platform,*args[1:])
 r=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=120)
 if check and r.returncode:raise RuntimeError(r.stderr+r.stdout)
 return r

def cmd(*args):return call(*args).stdout.strip()
def volume(suffix):
 name=prefix+'-'+suffix;volumes.add(name);cmd('volume','create',name);return name

def mount(v,target='/data'):return 'type=volume,source='+v+',target='+target+',volume-nocopy'
def args(v):return ['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount',mount(v),'--tmpfs','/var/run/postgresql:uid=1000,gid=1000,mode=700','--tmpfs','/tmp:uid=1000,gid=1000,mode=700','-e','PGDATA=/data/pgdata','-e','POSTGRES_PASSWORD=synthetic-fixture-password','-e','LANG=en_US.utf8']
def start(suffix,v,image):
 name=prefix+'-'+suffix;names.add(name);cmd('run','-d','--name',name,*args(v),image);end=time.monotonic()+30
 while time.monotonic()<end:
  r=call('exec',name,'psql','-U','postgres','-d','postgres','-AtX','-c','SELECT 1',check=False)
  if r.returncode==0 and cmd('exec',name,'cat','/proc/1/comm')=='postgres':return name
  if cmd('inspect','--format','{{.State.Running}}',name)=='false':raise RuntimeError(call('logs',name).stdout+call('logs',name).stderr)
  time.sleep(.1)
 raise RuntimeError(call('logs',name).stdout+call('logs',name).stderr)
def stop(name):cmd('stop','--time','15',name);cmd('rm',name);names.remove(name)
def sql(name,text):return cmd('exec',name,'psql','-U','postgres','-d','postgres','-AtX','-v','ON_ERROR_STOP=1','-c',text)
def helper(v,script,other=None):return cmd('run','--rm','--user','0','--entrypoint','sh','--mount',mount(v),*(['--mount',mount(other,'/copy')] if other else []),a.candidate,'-c',script)
try:
 fresh_data=volume('fresh');helper(fresh_data,'chown 1000:1000 /data')
 fresh=start('fresh',fresh_data,a.candidate)
 assert cmd('exec',fresh,'sh','-c','stat -c "%u:%g %a" "$PGDATA/.hive-runtime-collation"')=='1000:1000 600'
 stop(fresh)
 print('PASS: fresh non-root initialization and protected runtime receipt',flush=True)
 data=volume('data');helper(data,'chown 1000:1000 /data')
 old=start('old',data,a.baseline)
 sql(old,"CREATE TABLE proof (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO proof VALUES(1,'retained synthetic value'); CREATE EXTENSION pg_trgm; CREATE INDEX proof_search ON proof USING gin(value gin_trgm_ops);")
 sql(old,"CREATE COLLATION proof_icu(provider=icu,locale='und'); CREATE TABLE collation_proof(value text COLLATE proof_icu UNIQUE); INSERT INTO collation_proof VALUES('alpha'),('beta'),('gamma');")
 sql(old,'CREATE DATABASE "fixture=quoted name";')
 before=sql(old,"SELECT json_agg(json_build_object('name',datname,'collation',datcollversion)) FROM pg_database")
 stop(old)
 # The candidate must refuse automatic startup before migration, without opening a server.
 refused=call('run','--rm',*args(data),a.candidate,check=False)
 assert refused.returncode!=0 and 'requires backed-up offline reconciliation' in refused.stderr
 assert helper(data,'test ! -e /data/pgdata/.hive-runtime-collation; echo absent')=='absent'
 # Authentication failure on a disposable copy must leave HBA intact, no receipt and no listener.
 failed=volume('failed');helper(data,'tar cf - -C /data . | tar xpf - -C /copy',failed)
 helper(failed,"printf 'local all all reject\n' > /data/pgdata/pg_hba.conf")
 hba=helper(failed,'sha256sum /data/pgdata/pg_hba.conf')
 r=call('run','--rm',*args(failed),a.candidate,'hive-pg-reconcile',check=False)
 assert r.returncode!=0
 assert helper(failed,'sha256sum /data/pgdata/pg_hba.conf')==hba
 assert helper(failed,'test ! -e /data/pgdata/.hive-runtime-collation; test ! -e /data/pgdata/postmaster.pid; echo failed-closed')=='failed-closed'
 print('PASS: missing-receipt startup refusal and authentication failure without weakening HBA',flush=True)
 result=cmd('run','--rm',*args(data),a.candidate,'hive-pg-reconcile');assert 'reconciled with indexes rebuilt' in result
 repeat=cmd('run','--rm',*args(data),a.candidate,'hive-pg-reconcile');assert 'already reconciled' in repeat
 new=start('new',data,a.candidate)
 assert sql(new,"SET enable_seqscan=off; SELECT string_agg(value,',' ORDER BY value) FROM collation_proof").endswith('alpha,beta,gamma')
 duplicate=call('exec',new,'psql','-U','postgres','-d','postgres','-AtX','-v','ON_ERROR_STOP=1','-c',"INSERT INTO collation_proof VALUES('beta')",check=False)
 assert duplicate.returncode!=0 and 'duplicate key value' in duplicate.stderr
 assert sql(new,'SELECT id,value FROM proof')=='1|retained synthetic value'
 assert sql(new,"SELECT count(*) FROM pg_database WHERE datallowconn AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)")=='0'
 assert sql(new,"SELECT xpath('/proof/text()', xmlparse(document '<proof>retained</proof>'))::text")=='{retained}'
 assert sql(new,"SELECT count(*) FROM proof WHERE value % 'retained synthetic value'")=='1'
 sql(new,"INSERT INTO proof VALUES(2,'post-upgrade synthetic value')")
 cmd('exec',new,'pg_dump','-U','postgres','-d','postgres','--format=custom','--file=/data/proof.dump')
 assert 'TABLE DATA public proof' in cmd('exec',new,'pg_restore','--list','/data/proof.dump')
 cmd('exec',new,'pg_basebackup','-U','postgres','-D','/data/snapshot','--checkpoint=fast','--wal-method=stream')
 stop(new)
 # Restore the physical backup with its original ownership and runtime receipt.
 restore_args=args(data);restore_args[restore_args.index('PGDATA=/data/pgdata')]='PGDATA=/data/snapshot'
 restored=prefix+'-restored';names.add(restored);cmd('run','-d','--name',restored,*restore_args,a.candidate)
 end=time.monotonic()+30
 while time.monotonic()<end:
  r=call('exec',restored,'psql','-U','postgres','-d','postgres','-AtX','-c','SELECT count(*) FROM proof',check=False)
  if r.returncode==0:
   assert r.stdout.strip()=='2';break
  if cmd('inspect','--format','{{.State.Running}}',restored)=='false':raise RuntimeError(cmd('logs',restored))
  time.sleep(.1)
 else:raise RuntimeError(cmd('logs',restored))
 assert sql(restored,"SELECT count(*) FROM pg_database WHERE datallowconn AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)")=='0'
 assert 'collation version mismatch' not in cmd('logs',restored)
 print('PASS: non-root UID 1000, quoted database name, reindex/refresh, repeat, retained/new records, pg_trgm, XML, logical dump and physical restore',flush=True)
 print(json.dumps({'major':a.major,'uid':1000,'oldDatabaseMetadata':json.loads(before),'retainedRows':1,'postUpgradeRows':1,'physicalRestoreRows':2,'newRuntimeCollationMismatch':False}),flush=True)
finally:
 for n in names:call('rm','-f',n,check=False)
 for v in volumes:call('volume','rm',v,check=False)
