#!/usr/bin/env python3
# Disposable old-to-new PostgreSQL runtime, ownership and recovery acceptance.
import argparse,subprocess,uuid,time,json
parser=argparse.ArgumentParser();parser.add_argument('--baseline',required=True);parser.add_argument('--candidate',required=True);parser.add_argument('--major',required=True,choices=['17','18']);parser.add_argument('--platform',choices=['linux/amd64','linux/arm64']);parser.add_argument('--version');parser.add_argument('--previous');a=parser.parse_args()
prefix='hive-pg-runtime-'+uuid.uuid4().hex[:12];names=set();volumes=set()
def call(*args,check=True,stdin=None):
 if args and args[0]=='run' and a.platform:args=('run','--platform',a.platform,*args[1:])
 r=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=120,input=stdin)
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
 if a.version:assert sql(fresh,'SHOW server_version').split()[0]==a.version
 stop(fresh)
 print('PASS: fresh non-root initialization and protected runtime receipt',flush=True)
 data=volume('data');helper(data,'chown 1000:1000 /data')
 old=start('old',data,a.baseline)
 sql(old,"CREATE TABLE proof (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO proof VALUES(1,'retained synthetic value'); CREATE EXTENSION pg_trgm; CREATE INDEX proof_search ON proof USING gin(value gin_trgm_ops);")
 sql(old,"CREATE FUNCTION fixture_reindex(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN IF current_setting('fixture.fail_reindex',true)='on' THEN RAISE EXCEPTION 'synthetic reindex failure'; END IF; RETURN value; END $$; CREATE INDEX fixture_reindex_failure ON proof(fixture_reindex(value));")
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
 reindex_failed=volume('reindex-failed');helper(data,'tar cf - -C /data . | tar xpf - -C /copy',reindex_failed)
 helper(reindex_failed, "printf \"\\nfixture.fail_reindex = 'on'\\n\" >> /data/pgdata/postgresql.auto.conf")
 r=call('run','--rm',*args(reindex_failed),a.candidate,'hive-pg-reconcile',check=False)
 assert r.returncode!=0 and 'synthetic reindex failure' in r.stderr
 assert helper(reindex_failed,'test ! -e /data/pgdata/.hive-runtime-collation; test ! -e /data/pgdata/postmaster.pid; echo failed-closed')=='failed-closed'
 # Single-user inspection of the disposable failed copy needs the same arbitrary-
 # UID mapping as upstream initdb. It never admits a server or changes HBA.
 inspection="umask 077; work=$(mktemp -d /tmp/inspect.XXXXXXXX); printf 'postgres:x:1000:1000:fixture:/tmp:/bin/false\\n' > \"$work/passwd\"; printf 'postgres:x:1000:\\n' > \"$work/group\"; export LD_PRELOAD=/usr/lib/libnss_wrapper.so NSS_WRAPPER_PASSWD=\"$work/passwd\" NSS_WRAPPER_GROUP=\"$work/group\"; exec postgres --single -D \"$PGDATA\" postgres"
 inspected=call('run','--rm','--interactive',*args(reindex_failed),'--entrypoint','sh',a.candidate,'-c',inspection,stdin="SELECT CASE WHEN datallowconn THEN 'BAD TEMPLATE FLAG' ELSE 'TEMPLATE FLAG RESTORED' END FROM pg_database WHERE datname='template0';\n")
 assert 'TEMPLATE FLAG RESTORED' in inspected.stdout and 'BAD TEMPLATE FLAG' not in inspected.stdout
 print('PASS: reindex failure restores template admission, stops the server and writes no receipt',flush=True)

 result=cmd('run','--rm',*args(data),a.candidate,'hive-pg-reconcile');assert 'reconciled with indexes rebuilt' in result
 repeat=cmd('run','--rm',*args(data),a.candidate,'hive-pg-reconcile');assert 'already reconciled' in repeat
 new=start('new',data,a.candidate)
 assert sql(new,"SET enable_seqscan=off; SELECT string_agg(value,',' ORDER BY value) FROM collation_proof").endswith('alpha,beta,gamma')
 duplicate=call('exec',new,'psql','-U','postgres','-d','postgres','-AtX','-v','ON_ERROR_STOP=1','-c',"INSERT INTO collation_proof VALUES('beta')",check=False)
 assert duplicate.returncode!=0 and 'duplicate key value' in duplicate.stderr
 assert sql(new,'SELECT id,value FROM proof')=='1|retained synthetic value'
 assert sql(new,"SELECT count(*) FROM pg_database WHERE datallowconn AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)")=='0'
 assert sql(new,"SELECT xpath('/proof/text()', xmlparse(document '<proof>retained</proof>'))::text")=='{retained}'
 assert cmd('exec',new,'apk','info','-v','-e','libxslt')=='libxslt-1.1.45-r8'
 assert sql(new,"CREATE EXTENSION IF NOT EXISTS xml2")=='CREATE EXTENSION'
 assert sql(new,"SELECT xslt_process('<doc>retained</doc>', '<xsl:stylesheet version=\"1.0\" xmlns:xsl=\"http://www.w3.org/1999/XSL/Transform\"><xsl:output method=\"text\"/><xsl:template match=\"/\"><xsl:value-of select=\"/doc\"/></xsl:template></xsl:stylesheet>')")=='retained'
 assert sql(new,"SELECT count(*) FROM proof WHERE value % 'retained synthetic value'")=='1'
 # Restores and operators can create new databases from template0; its catalog
 # collation metadata must be reconciled too, without changing its admission flag.
 assert sql(new,"SELECT datallowconn FROM pg_database WHERE datname='template0'")=='f'
 sql(new,'CREATE DATABASE restored_template_fixture TEMPLATE template0')
 assert cmd('exec',new,'psql','-U','postgres','-d','restored_template_fixture','-AtX','-v','ON_ERROR_STOP=1','-c',"SELECT count(*) FROM pg_collation WHERE collversion IS NOT NULL AND collversion IS DISTINCT FROM pg_collation_actual_version(oid)")=='0'
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
 # A minor update, or a library rebuild of the same minor, of the same hardened runtime: data
 # written by the previously published image starts directly on the candidate, never on an
 # older server. The collation receipt is unchanged, so no
 # reconciliation, rebuild or storage transition runs, and the explicit command is a no-op.
 if a.previous:
  prior=volume('prior');helper(prior,'chown 1000:1000 /data')
  p=start('prior',prior,a.previous)
  sql(p,"CREATE EXTENSION pg_trgm; CREATE TABLE minor_proof (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO minor_proof VALUES(1,'minor synthetic value'); CREATE INDEX minor_search ON minor_proof USING gin(value gin_trgm_ops);")
  prior_version=sql(p,'SHOW server_version_num');stop(p)
  receipt=helper(prior,'cat /data/pgdata/.hive-runtime-collation')
  assert receipt==cmd('run','--rm','--entrypoint','cat',a.candidate,'/usr/share/hive/postgres-runtime-id')
  minor=start('minor',prior,a.candidate)
  assert prior_version[:2]==sql(minor,'SHOW server_version_num')[:2]==a.major and int(sql(minor,'SHOW server_version_num'))>=int(prior_version)
  assert sql(minor,"SET enable_seqscan=off; SELECT id FROM minor_proof WHERE value % 'minor synthetic value'").splitlines()[-1]=='1'
  sql(minor,"INSERT INTO minor_proof VALUES(2,'after minor update')");stop(minor)
  assert helper(prior,'cat /data/pgdata/.hive-runtime-collation')==receipt
  assert 'already reconciled' in cmd('run','--rm',*args(prior),a.candidate,'hive-pg-reconcile')
  print('PASS: minor update from the previous image keeps the runtime receipt and data without reconciliation',flush=True)
 print(json.dumps({'major':a.major,'uid':1000,'oldDatabaseMetadata':json.loads(before),'retainedRows':1,'postUpgradeRows':1,'physicalRestoreRows':2,'newRuntimeCollationMismatch':False}),flush=True)
finally:
 for n in names:call('rm','-f',n,check=False)
 for v in volumes:call('volume','rm',v,check=False)
