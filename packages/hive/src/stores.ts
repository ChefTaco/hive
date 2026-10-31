import { spawnSync } from "node:child_process";
import { containerState, docker, dockerAvailable, dockerCommandLine, dockerRunArgs, parseDockerRun, type DockerRunSpec } from "./docker.js";
import { hostPort, isPortFree, nextFreePort, probeQdrant, probeRedis } from "./net.js";
import type { Output } from "./output.js";
import type { Prompter } from "./prompt.js";
import type { StoreDependency } from "./schema.js";
import type { LauncherState, StoreName } from "./state.js";
import { displayUrl } from "./privacy.js";

export const STORES: Record<StoreName, { title: string; envVar: string; defaultPort: number; service: "memory" | "iam"; url: (port: number) => string }> = {
  qdrant: { title: "Qdrant", envVar: "HIVEMEM_QDRANT_URL", defaultPort: 6333, service: "memory", url: (port) => `http://127.0.0.1:${port}` },
  // Published on 127.0.0.1 only, so the throwaway Redis needs no password.
  redis: { title: "Redis", envVar: "REDIS_URL", defaultPort: 6379, service: "iam", url: (port) => `redis://127.0.0.1:${port}` },
};

export type StoreProbe = "ok" | "auth-required" | "other-service" | "down";

export async function probeStore(store: StoreName, url: string): Promise<StoreProbe> {
  if (store === "qdrant") {
    const result = await probeQdrant(url);
    return result === "not-qdrant" ? "other-service" : result;
  }
  const { host, port } = hostPort(url, 6379);
  const result = await probeRedis(host, port);
  return result === "not-redis" ? "other-service" : result;
}

/** Host port a container publishes `containerPort` on (configured, so it also works while stopped). */
export function containerHostPort(name: string, containerPort: number): number | null {
  const result = spawnSync("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", name], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  try {
    const bindings = JSON.parse(result.stdout) as Record<string, Array<{ HostPort?: string }> | null> | null;
    const hostPortText = bindings?.[`${containerPort}/tcp`]?.[0]?.HostPort;
    return hostPortText && /^\d+$/u.test(hostPortText) ? Number(hostPortText) : null;
  } catch {
    return null;
  }
}

export async function waitForStore(store: StoreName, url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeStore(store, url)) === "ok") return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export interface StoreContext {
  output: Output;
  prompter: Prompter;
  state: LauncherState;
  dockerPrefix: string;
}

function specFor(store: StoreName, dependency: StoreDependency, prefix: string, hostPortNumber: number): DockerRunSpec | null {
  const spec = parseDockerRun(dependency.docker);
  if (!spec) return null;
  return {
    ...spec,
    name: `${prefix}-${store}`,
    hostIp: "127.0.0.1",
    hostPort: hostPortNumber,
    ...(spec.volume ? { volume: { name: `${prefix}-${store}`, target: spec.volume.target } } : {}),
  };
}

function manualInstructions(context: StoreContext, store: StoreName, url: string, dependency: StoreDependency, spec: DockerRunSpec | null): void {
  const title = STORES[store].title;
  context.output.warn(`${title} is not running at ${displayUrl(url)}. Start it before \`hive start\`, for example:`);
  context.output.info(`    ${spec ? dockerCommandLine(spec) : dependency.docker}`);
  context.output.info(`  or install ${title} natively and point ${STORES[store].envVar} in the ${STORES[store].service}.env file at it.`);
}

async function startContainer(context: StoreContext, store: StoreName, spec: DockerRunSpec, url: string): Promise<boolean> {
  const title = STORES[store].title;
  const existing = containerState(spec.name);
  if (existing === "stopped") {
    if (!(await context.prompter.confirm(`Start the existing ${spec.name} container (${title})?`, true))) return false;
    if ((await docker(["start", spec.name])) !== 0) throw new Error(`docker start ${spec.name} failed`);
  } else if (existing === "missing") {
    context.output.info(`  ${dockerCommandLine(spec)}`);
    if (!(await context.prompter.confirm(`Start ${title} in Docker with this command?`, true))) return false;
    if ((await docker(dockerRunArgs(spec))) !== 0) throw new Error(`docker run for ${title} failed; see the Docker output above`);
  }
  context.output.step(`waiting for ${title} at ${displayUrl(url)}`);
  if (!(await waitForStore(store, url))) throw new Error(`${title} did not answer at ${displayUrl(url)} within 60 seconds; check \`docker logs ${spec.name}\``);
  context.state.containers[store] = { name: spec.name, image: spec.image, hostPort: spec.hostPort, ...(spec.volume ? { volume: spec.volume.name } : {}) };
  context.output.ok(`${title} is running in container ${spec.name} at ${displayUrl(url)}`);
  return true;
}

/**
 * Finds or starts the store a service needs and returns its URL. Order:
 * an explicit or already configured URL; an existing launcher container; a
 * server already answering on the port (after asking); otherwise a new Docker
 * container on a free loopback port (after asking), or printed instructions.
 */
export async function resolveStore(context: StoreContext, store: StoreName, dependency: StoreDependency, options: { url?: string | undefined; preferredPort?: number | undefined }): Promise<string> {
  const title = STORES[store].title;
  const docker = dockerAvailable();
  if (options.url) {
    const url = options.url;
    const probe = await probeStore(store, url);
    if (probe === "ok") {
      context.output.ok(`${title} answers at ${displayUrl(url)}`);
      return url;
    }
    const managed = context.state.containers[store];
    const { host, port } = hostPort(url, STORES[store].defaultPort);
    const loopback = host === "127.0.0.1" || host === "::1";
    if (probe === "down" && loopback && docker.ok) {
      let spec = specFor(store, dependency, context.dockerPrefix, port);
      // Reuse the container an earlier `hive init` started for this port, even under another prefix.
      if (spec && managed && managed.hostPort === port) {
        spec = { ...spec, name: managed.name, image: managed.image, ...(managed.volume && spec.volume ? { volume: { name: managed.volume, target: spec.volume.target } } : {}) };
      }
      if (spec && (await startContainer(context, store, spec, url))) return url;
    }
    if (probe === "auth-required") context.output.warn(`${title} at ${displayUrl(url)} requires credentials; put them in the URL in the ${STORES[store].service}.env file.`);
    else if (probe === "other-service") context.output.warn(`Something other than ${title} answers at ${displayUrl(url)}.`);
    else manualInstructions(context, store, url, dependency, specFor(store, dependency, context.dockerPrefix, port));
    return url;
  }

  let port = options.preferredPort ?? STORES[store].defaultPort;
  const url = STORES[store].url(port);
  const probe = await probeStore(store, url);
  if (probe === "ok" && (await context.prompter.confirm(`${title} is already running at ${displayUrl(url)}. Use it for ${store === "qdrant" ? "HiveMem" : "Hive IAM"}?`, true))) {
    return url;
  }
  if (probe !== "down" || !(await isPortFree(port))) {
    const next = await nextFreePort(port + 1, new Set());
    if (probe === "auth-required") context.output.info(`  ${title} at ${displayUrl(url)} requires a password; using port ${next} for a separate ${title}.`);
    else if (probe === "other-service") context.output.info(`  Port ${port} is used by something other than ${title}; using port ${next}.`);
    else if (probe === "down") context.output.info(`  Port ${port} is in use; using port ${next} for ${title}.`);
    port = next;
  }
  const finalUrl = STORES[store].url(port);
  const spec = specFor(store, dependency, context.dockerPrefix, port);
  if (spec) {
    const existing = docker.ok ? containerState(spec.name) : "missing";
    if (existing !== "missing") {
      const published = containerHostPort(spec.name, spec.containerPort);
      const reuseUrl = STORES[store].url(published ?? port);
      if (published === null || !(await context.prompter.confirm(`A container named ${spec.name} already exists (${existing}, port ${published ?? "unknown"}). Use it?`, true))) {
        throw new Error(`a Docker container named ${spec.name} already exists; remove it (docker rm ${spec.name}) or choose another --docker-prefix`);
      }
      if (await startContainer(context, store, { ...spec, hostPort: published }, reuseUrl)) return reuseUrl;
      manualInstructions(context, store, reuseUrl, dependency, spec);
      return reuseUrl;
    }
  }
  if (!docker.ok || !spec) {
    if (!docker.ok) context.output.info(`  Docker is not available (${docker.detail}).`);
    manualInstructions(context, store, finalUrl, dependency, spec);
    return finalUrl;
  }
  if (await startContainer(context, store, spec, finalUrl)) return finalUrl;
  manualInstructions(context, store, finalUrl, dependency, spec);
  return finalUrl;
}

/** For `hive start`: restart a launcher-managed container whose store is down. */
export async function ensureStoreRunning(context: { output: Output; state: LauncherState }, store: StoreName, url: string): Promise<void> {
  if ((await probeStore(store, url)) === "ok") return;
  const title = STORES[store].title;
  const managed = context.state.containers[store];
  const { port } = hostPort(url, STORES[store].defaultPort);
  if (managed && managed.hostPort === port && dockerAvailable().ok && containerState(managed.name) === "stopped") {
    context.output.step(`starting the ${managed.name} container (${title})`);
    if ((await docker(["start", managed.name])) !== 0) throw new Error(`docker start ${managed.name} failed`);
    if (await waitForStore(store, url)) return;
    throw new Error(`${title} did not answer at ${displayUrl(url)} within 60 seconds after docker start; check \`docker logs ${managed.name}\``);
  }
  throw new Error(`${title} is not reachable at ${displayUrl(url)} (${STORES[store].envVar} in ${STORES[store].service}.env). Start it, or run \`hive init\` to set it up.`);
}
