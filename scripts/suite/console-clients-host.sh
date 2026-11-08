#!/usr/bin/env bash
# hive.sh console-clients, on the Oathweave host. Transported verbatim by the controller; the
# reviewed client list arrives as JSON on standard input. The change runs in one transaction in
# the running Oathweave container, against its own store and its own browser policies.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
die() { printf 'Console clients: %s\n' "$*" >&2; exit 1; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
jq -e '.placements.oathweave!=null' <<< "$input" >/dev/null || die 'Oathweave is not placed on this host'
[[ -f "$directory/compose.json" ]] || die 'The suite is not active on this host'
clients=$(jq -c .consoleClients <<< "$input")
jq -e 'type=="array" and length>0 and all(.[]; (.id|test("^hivexui-[a-z][a-z0-9-]{0,47}$")) and (.permissions|type=="array" and length>0) and (.redirectUris|length==1))' <<< "$clients" >/dev/null || die 'Invalid client list'
# shellcheck disable=SC2016
code='import {prisma} from "/app/apps/iam-core/dist/db/client.js";import assert from "node:assert/strict";
const clients=JSON.parse(process.argv[1]);
const policies=JSON.parse(process.env.IAM_BROWSER_CLIENT_POLICIES||"{}");
for(const c of clients){const p=policies[c.id];
 assert(p&&p.audience===c.audience&&JSON.stringify([...new Set(p.permissions)].sort())===JSON.stringify([...c.permissions].sort()),"Oathweave runs without the reviewed browser policy for "+c.id+": add it to IAM_BROWSER_CLIENT_POLICIES and recreate Oathweave first");}
const ids=clients.map(c=>c.id);
const snapshot=async(tx)=>JSON.stringify([
 (await tx.user.findMany()).sort((a,b)=>a.id<b.id?-1:1),
 (await tx.role.findMany()).filter(r=>r.name!=="SUITE_ADMIN").sort((a,b)=>a.id<b.id?-1:1),
 (await tx.client.findMany()).filter(c=>!ids.includes(c.id)).sort((a,b)=>a.id<b.id?-1:1),
 (await tx.userRoleAssignment.findMany()).sort((a,b)=>(a.userId+" "+a.roleId)<(b.userId+" "+b.roleId)?-1:1)]);
const createdClients=[];let addedPermissions=[];
// Compared inside the transaction: anything else that would change rolls everything back.
await prisma.$transaction(async(tx)=>{
 const before=await snapshot(tx);
 const role=await tx.role.findUnique({where:{name:"SUITE_ADMIN"}});
 assert(role,"This Oathweave store has no SUITE_ADMIN role: fresh setup and migrate-native create it; grant the permissions through Oathweave instead");
 for(const c of clients){const existing=await tx.client.findUnique({where:{id:c.id}});
  if(existing){assert.equal(existing.clientType,"public",c.id+" exists and is not a public client");assert(JSON.parse(existing.redirectUris).includes(c.redirectUris[0]),c.id+" exists with another console callback");continue;}
  await tx.client.create({data:{id:c.id,name:c.id,description:"HiveXUI "+c.audience+" browser client",clientType:"public",active:true,firstParty:c.firstParty,redirectUris:JSON.stringify(c.redirectUris),grantTypes:JSON.stringify(["authorization_code"]),allowedIps:"[]"}});createdClients.push(c.id);}
 const current=JSON.parse(role.permissions);addedPermissions=[...new Set(clients.flatMap(c=>c.permissions))].filter(p=>!current.includes(p));
 if(addedPermissions.length)await tx.role.update({where:{id:role.id},data:{permissions:JSON.stringify([...current,...addedPermissions])}});
 assert.equal(await snapshot(tx),before,"Existing identity records would change");
});
console.log(JSON.stringify({createdClients,addedPermissions,existingRecordsUnchanged:true}));await prisma.$disconnect();process.exit(0);'
docker compose -f "$directory/compose.json" exec -T oathweave node --input-type=module -e "$code" "$clients" | grep '^{' | tail -1
