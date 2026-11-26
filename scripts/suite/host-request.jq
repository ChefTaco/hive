# The request hive_host sends to a host script, on standard input with the program.
# Input: the installation configuration. Every $variable is an --arg/--argjson that hive_host
# (scripts/suite/controller.sh) sets from the controller's state. One field per line, so a
# reviewer can see what reaches a host; keep it that way.
{
  directory:.hosts[$host].directory,
  minimumFreeMiB:(.hosts[$host].minimumFreeMiB // 2048),
  origin,
  host:$host,
  installation:$installation,
  version:$version,
  digest:$digest,
  plan:$plan,
  controllerSourceSHA256:$controller,
  controllerArchiveSHA256:$controllerArchive,
  registry:$registry,
  memoryCredential:$memoryCredential,
  auditCollection:$auditCollection,
  magnusTrust:$magnusTrust,
  cindertrace:$cindertrace,
  magnusAgent:$magnusAgent,
  abortStep:$abortStep,
  action:$action,
  operation:$operation,
  archive:$archive,
  allowMigrations:$allowMigrations,
  placements:(.components|with_entries(select(.value.host==$host))),
  console:(if .console.host==$host then .console else null end),
  bootstrap:(.bootstrap // null),
  bootstrapImages:$images,
  bootstrapIdentityIds:$identityIds,
  bootstrapServiceUsers:$serviceUsers,
  magnusMemoryIdentity:(.components.magnus!=null and .components.hivemem!=null and .components.oathweave!=null and .components.magnus.host==.components.oathweave.host),
  ingressTemplate:$ingressTemplate,
  integrityScript:$integrityScript,
  snapshotTool:$snapshotTool,
  nativeBackupTool:$nativeBackupTool,
  nativeRecovery:($nativeRecovery.hosts[$host] // null),
  nativeRecoveryConfigurationSHA256:$recoveryConfig,
  nativeRecoveryManifestSemanticSHA256:$recoverySemantic,
  skillsDeployment:(.skillsDeployment // null),
  skillsRelease:{manifest:$skillsManifest,signature:$skillsSignature,trust:$skillsTrust},
  skillsTokenSHA256:$skillsTokenSHA,
  nativeMigration:(.nativeMigration // null),
  dataTool:$dataTool,
  adminScript:$adminScript,
  reviewedLinks:$reviewedLinks,
  tokenDigest:$tokenDigest,
  tokenTtlSeconds:$tokenTtlSeconds,
  agents:[.agents[]|select(.host==$host)],
  inference:[.inference[]|select(.host==$host)]
}
+ (if .external then {external:.external} else {} end)
+ (if $consoleClients!=null then {consoleClients:$consoleClients} + (if env.HIVE_CONSOLE_CLIENTS_CHECK=="true" then {consoleClientsCheck:true} else {} end) else {} end)
+ (if $adminAccess!=null then {adminAccess:$adminAccess} else {} end)
+ (if $retention!=null then {retention:$retention} else {} end)
+ (if $addProduct!=null then {addProduct:$addProduct} else {} end)
+ (if $diagnostics!=null then {diagnostics:$diagnostics} else {} end)
+ (if $backupTransfer!=null then {backupTransfer:$backupTransfer} else {} end)
+ (if $uninstall!=null then {uninstall:$uninstall} else {} end)
+ (if $magnusNodeKeysOnly==true then {magnusNodeKeysOnly:true} else {} end)
