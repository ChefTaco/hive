import { existsSync } from "node:fs";
import { consoleUrl, listeners, type Listener } from "./endpoints.js";
import { EnvDocument } from "./envfile.js";
import { probeHttp } from "./net.js";
import { paint, type Output } from "./output.js";
import type { HivePaths } from "./paths.js";
import { installedServer } from "./runtime.js";
import { START_ORDER, type ServiceName } from "./services.js";
import { probeStore, STORES, type StoreProbe } from "./stores.js";
import { MEMORY_TOKEN_VAR, tokenExpiry } from "./token.js";
import { displayUrl } from "./privacy.js";
import { probeCa, processAlive, readPidFile } from "./supervisor.js";

export interface ListenerStatus {
  plane: Listener["plane"];
  url: string;
  healthy: boolean;
  detail: string;
}

export interface ServiceStatus {
  service: ServiceName;
  installed: string | null;
  listeners: ListenerStatus[];
  store?: { name: string; url: string; state: StoreProbe };
}

export interface StatusReport {
  home: string;
  launcher: { running: boolean; pid?: number };
  services: ServiceStatus[];
  consoleUrl: string | null;
  memoryTokenExpires: string | null;
  ok: boolean;
}

export function configuredServices(paths: HivePaths): ServiceName[] {
  return START_ORDER.filter((service) => existsSync(paths.envFile(service)));
}

/** Health of every configured service. Works whether or not `hive start` runs in another terminal. */
export async function collectStatus(paths: HivePaths): Promise<StatusReport> {
  const ca = probeCa(paths);
  const pid = readPidFile(paths);
  const services = await Promise.all(configuredServices(paths).map(async (service): Promise<ServiceStatus> => {
    const doc = EnvDocument.load(paths.envFile(service));
    const probes = await Promise.all(listeners(service, doc).map(async (entry): Promise<ListenerStatus> => {
      const probe = await probeHttp(entry.healthUrl, { ca, timeoutMs: 3000 });
      return { plane: entry.plane, url: displayUrl(entry.url), healthy: probe.ok, detail: probe.ok ? "healthy" : probe.error ?? `HTTP ${probe.status}` };
    }));
    const status: ServiceStatus = { service, installed: installedServer(paths, service)?.version ?? null, listeners: probes };
    if (service === "memory" && doc.get("HIVEMEM_TS_PERSISTENCE") !== "memory") {
      const url = doc.get("HIVEMEM_QDRANT_URL") ?? STORES.qdrant.url(STORES.qdrant.defaultPort);
      status.store = { name: "qdrant", url: displayUrl(url), state: await probeStore("qdrant", url) };
    }
    if (service === "iam") {
      const url = doc.get("REDIS_URL") ?? "redis://localhost:6379";
      status.store = { name: "redis", url: displayUrl(url), state: await probeStore("redis", url) };
    }
    return status;
  }));
  const routerFile = paths.envFile("router");
  const router = existsSync(routerFile) ? EnvDocument.load(routerFile) : null;
  const token = router?.get(MEMORY_TOKEN_VAR);
  const exp = token ? tokenExpiry(token) : null;
  return {
    home: paths.home,
    launcher: pid && processAlive(pid.pid) ? { running: true, pid: pid.pid } : { running: false },
    services,
    consoleUrl: router ? displayUrl(consoleUrl(router)) : null,
    memoryTokenExpires: exp ? new Date(exp * 1000).toISOString() : null,
    ok: services.length > 0 && services.every((service) => service.listeners.every((entry) => entry.healthy)),
  };
}

export function printStatus(report: StatusReport, output: Output): void {
  output.info(`Hive in ${report.home}`);
  output.info(`  hive start: ${report.launcher.running ? `running (pid ${report.launcher.pid})` : "not running"}`);
  if (report.services.length === 0) {
    output.info("  No services are configured. Run `hive init`.");
    return;
  }
  for (const service of report.services) {
    for (const entry of service.listeners) {
      const label = service.service === "router" ? `router ${entry.plane}` : service.service;
      const mark = entry.healthy ? paint("up  ", "green", output.color) : paint("down", "red", output.color);
      output.info(`  ${mark}  ${label.padEnd(13)} ${entry.url.padEnd(28)} ${entry.detail}`);
    }
    if (service.store) {
      const mark = service.store.state === "ok" ? paint("up  ", "green", output.color) : paint("down", "red", output.color);
      output.info(`  ${mark}  ${service.store.name.padEnd(13)} ${service.store.url.padEnd(28)} ${service.store.state === "ok" ? "reachable" : service.store.state}`);
    }
    if (!service.installed) output.info(`        ${service.service} is not installed; run \`hive install ${service.service}\``);
  }
  if (report.consoleUrl) output.info(`  Console: ${report.consoleUrl}`);
  if (report.memoryTokenExpires) output.info(`  Router's HiveMem token valid until ${report.memoryTokenExpires}`);
}
