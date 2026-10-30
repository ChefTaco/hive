import { spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { ensurePrivateDir } from "./envfile.js";
import type { HivePaths } from "./paths.js";

export interface TlsFiles {
  caCert: string;
  caKey: string;
  cert: string;
  key: string;
}

export function tlsFiles(paths: HivePaths): TlsFiles {
  return {
    caCert: join(paths.tls, "ca.crt"),
    caKey: join(paths.tls, "ca.key"),
    cert: join(paths.tls, "server.crt"),
    key: join(paths.tls, "server.key"),
  };
}

export const OPENSSL_MISSING = "openssl is needed to create the local TLS certificates but was not found on PATH. Install it (Debian/Ubuntu: sudo apt install openssl; Fedora: sudo dnf install openssl; macOS ships one, or brew install openssl), or re-run with --no-tls to serve plain HTTP on 127.0.0.1 only.";

export function opensslVersion(): string | null {
  const result = spawnSync("openssl", ["version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Names every server certificate covers, plus the optional --hostname. */
export function certificateNames(hostname?: string): string[] {
  const names = ["localhost", "127.0.0.1", "::1"];
  if (hostname && !names.includes(hostname)) names.push(hostname);
  return names;
}

export function subjectAltName(names: readonly string[]): string {
  return names.map((name) => (isIP(name) ? `IP:${name}` : `DNS:${name}`)).join(",");
}

/** Names on an existing certificate, normalized to the form certificateNames uses. */
export function namesOnCertificate(pem: string | Buffer): string[] {
  const san = new X509Certificate(pem).subjectAltName ?? "";
  return san.split(",").map((entry) => entry.trim()).flatMap((entry) => {
    const [kind, ...rest] = entry.split(":");
    const value = rest.join(":").trim().toLowerCase();
    if (kind === "DNS") return [value];
    if (kind === "IP Address") return [value === "0:0:0:0:0:0:0:1" ? "::1" : value];
    return [];
  });
}

export type ServerCertStatus = { state: "ok" } | { state: "missing" } | { state: "unusable"; reason: string };

/** Is the existing server certificate signed by our CA, valid for 30+ days, and covering `names`? */
export function inspectServerCertificate(files: TlsFiles, names: readonly string[], now = new Date()): ServerCertStatus {
  if (!existsSync(files.cert) || !existsSync(files.key)) return { state: "missing" };
  try {
    const cert = new X509Certificate(readFileSync(files.cert));
    if (existsSync(files.caCert)) {
      const ca = new X509Certificate(readFileSync(files.caCert));
      if (!cert.verify(ca.publicKey)) return { state: "unusable", reason: "it was not signed by the local CA in the same directory" };
    }
    const daysLeft = (new Date(cert.validTo).getTime() - now.getTime()) / 86_400_000;
    if (daysLeft < 30) return { state: "unusable", reason: daysLeft <= 0 ? "it has expired" : `it expires in ${Math.floor(daysLeft)} days` };
    const covered = namesOnCertificate(readFileSync(files.cert));
    const missing = names.filter((name) => !covered.includes(name.toLowerCase()));
    if (missing.length > 0) return { state: "unusable", reason: `it does not cover ${missing.join(", ")}` };
    return { state: "ok" };
  } catch (error) {
    return { state: "unusable", reason: `it cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

function openssl(args: string[], cwd: string): void {
  const result = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (result.error) throw new CliError(OPENSSL_MISSING);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").filter(Boolean).at(-1) ?? `exit code ${result.status}`;
    throw new CliError(`openssl ${args[0]} failed: ${detail}`);
  }
}

const CA_CONFIG = `[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Hive local CA
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

function serverExtensions(names: readonly string[]): string {
  return `basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${subjectAltName(names)}
`;
}

/** Creates the local CA (once) and a server certificate for `names` with openssl. */
export function createCertificates(paths: HivePaths, names: readonly string[], options: { newCa: boolean }): TlsFiles {
  const files = tlsFiles(paths);
  ensurePrivateDir(paths.tls);
  const work = mkdtempSync(join(paths.tls, ".work-"));
  try {
    if (options.newCa || !existsSync(files.caCert) || !existsSync(files.caKey)) {
      writeFileSync(join(work, "ca.cnf"), CA_CONFIG);
      openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650", "-keyout", "ca.key", "-out", "ca.crt", "-config", "ca.cnf"], work);
      chmodSync(join(work, "ca.key"), 0o600);
      renameSync(join(work, "ca.key"), files.caKey);
      renameSync(join(work, "ca.crt"), files.caCert);
    }
    writeFileSync(join(work, "server.ext"), serverExtensions(names));
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"], work);
    openssl(["x509", "-req", "-sha256", "-days", "825", "-in", "server.csr", "-CA", files.caCert, "-CAkey", files.caKey, "-set_serial", `0x${randomBytes(12).toString("hex")}`, "-out", "server.crt", "-extfile", "server.ext"], work);
    chmodSync(join(work, "server.key"), 0o600);
    renameSync(join(work, "server.key"), files.key);
    renameSync(join(work, "server.crt"), files.cert);
    chmodSync(files.cert, 0o644);
    chmodSync(files.caCert, 0o644);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return files;
}
