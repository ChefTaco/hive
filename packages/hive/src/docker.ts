import { spawn, spawnSync } from "node:child_process";

export interface DockerRunSpec {
  name: string;
  image: string;
  /** Host interface the port is published on; always loopback here. */
  hostIp: string;
  hostPort: number;
  containerPort: number;
  volume?: { name: string; target: string };
}

/**
 * Reads the docker one-liner a server prints in its env-schema, for example
 * `docker run -d --name hive-qdrant -p 127.0.0.1:6333:6333 -v hive-qdrant:/qdrant/storage qdrant/qdrant:v1.18.1`.
 * Returns null for anything more elaborate, so the caller can fall back to
 * printing the command as is.
 */
export function parseDockerRun(command: string): DockerRunSpec | null {
  const tokens = command.trim().split(/\s+/u);
  if (tokens[0] !== "docker" || tokens[1] !== "run") return null;
  let name: string | undefined;
  let publish: string | undefined;
  let volume: string | undefined;
  let image: string | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-d" || token === "--detach") continue;
    if (token === "--name") name = tokens[++index];
    else if (token === "-p" || token === "--publish") publish = tokens[++index];
    else if (token === "-v" || token === "--volume") volume = tokens[++index];
    else if (token.startsWith("-")) return null;
    else if (image === undefined) image = token;
    else return null;
  }
  const ports = /^(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):(\d+)$/u.exec(publish ?? "");
  if (!name || !image || !ports) return null;
  const spec: DockerRunSpec = { name, image, hostIp: ports[1] ?? "127.0.0.1", hostPort: Number(ports[2]), containerPort: Number(ports[3]) };
  if (volume) {
    const [volumeName, target] = volume.split(":");
    if (!volumeName || !target || volumeName.includes("/")) return null;
    spec.volume = { name: volumeName, target };
  }
  return spec;
}

export function dockerRunArgs(spec: DockerRunSpec): string[] {
  return [
    "run", "-d", "--name", spec.name,
    "-p", `${spec.hostIp}:${spec.hostPort}:${spec.containerPort}`,
    ...(spec.volume ? ["-v", `${spec.volume.name}:${spec.volume.target}`] : []),
    spec.image,
  ];
}

export function dockerCommandLine(spec: DockerRunSpec): string {
  return `docker ${dockerRunArgs(spec).join(" ")}`;
}

/** Docker CLI present and the daemon reachable. */
export function dockerAvailable(): { ok: boolean; detail: string } {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
  if (result.error) return { ok: false, detail: "the docker command is not installed" };
  if (result.status !== 0) return { ok: false, detail: `docker is installed but the daemon is not reachable (${(result.stderr || "").trim().split("\n")[0] ?? ""})` };
  return { ok: true, detail: `Docker ${result.stdout.trim()}` };
}

export type ContainerState = "running" | "stopped" | "missing";

export function containerState(name: string): ContainerState {
  const result = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", name], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return "missing";
  return result.stdout.trim() === "true" ? "running" : "stopped";
}

/** Runs a docker command with its output shown to the user. */
export function docker(args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
