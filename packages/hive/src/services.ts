export const SERVICE_NAMES = ["memory", "router", "iam"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** Dependencies first: IAM and HiveMem must be healthy before the Router starts. */
export const START_ORDER: readonly ServiceName[] = ["iam", "memory", "router"];

export interface ServiceDef {
  name: ServiceName;
  title: string;
  packageName: string;
  bin: string;
  summary: string;
  /** External store the server needs, set up by `hive init`. */
  store: "qdrant" | "redis" | null;
  /** Native add-ons whose install scripts must run (npm 12 blocks them unless allowed). */
  nativeModules: readonly string[];
}

export const SERVICES: Record<ServiceName, ServiceDef> = {
  memory: {
    name: "memory",
    title: "HiveMem",
    packageName: "@hivemagnus/hivemem-server",
    bin: "hivemem-server",
    summary: "long-term memory API for agents (needs Qdrant)",
    store: "qdrant",
    nativeModules: [],
  },
  router: {
    name: "router",
    title: "Hive Router",
    packageName: "@hivemagnus/hive-router",
    bin: "hive-router",
    summary: "model gateway and the Hive console (signs in through IAM when it is set up, shows HiveMem in the console when it is set up)",
    store: null,
    nativeModules: ["better-sqlite3"],
  },
  iam: {
    name: "iam",
    title: "Hive IAM",
    packageName: "@hivemagnus/hive-iam-server",
    bin: "hive-iam-server",
    summary: "identity provider: users, roles, OAuth clients (needs Redis)",
    store: "redis",
    nativeModules: ["better-sqlite3", "argon2"],
  },
};

export function isServiceName(value: string): value is ServiceName {
  return (SERVICE_NAMES as readonly string[]).includes(value);
}

/** Parses `memory,router` or `all`; throws a message naming the bad entry. */
export function parseServiceList(values: readonly string[]): ServiceName[] {
  const names = values.flatMap((value) => value.split(/[\s,]+/u)).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (names.includes("all")) return sortServices(SERVICE_NAMES);
  const unknown = names.filter((name) => !isServiceName(name));
  if (unknown.length > 0) throw new Error(`unknown service ${unknown.map((name) => `"${name}"`).join(", ")}; choose from ${SERVICE_NAMES.join(", ")} or all`);
  return sortServices(names as ServiceName[]);
}

/** De-duplicated, in start order. */
export function sortServices(names: readonly ServiceName[]): ServiceName[] {
  return START_ORDER.filter((name) => names.includes(name));
}
