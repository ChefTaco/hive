import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

const KEY_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;
const SAFE_VALUE = /^[A-Za-z0-9_./:@,+=%~-]*$/u;

/**
 * An env file edited in place: comments, order and unrelated lines are kept,
 * and values are read with Node's own dotenv parser (the one `--env-file` uses).
 */
export class EnvDocument {
  private lines: string[];

  constructor(text = "") {
    this.lines = text === "" ? [] : text.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");
  }

  static load(path: string): EnvDocument {
    return new EnvDocument(readFileSync(path, "utf8"));
  }

  static loadIfExists(path: string): EnvDocument | null {
    return existsSync(path) ? EnvDocument.load(path) : null;
  }

  values(): Record<string, string> {
    const parsed = parseEnv(this.toString());
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }

  get(key: string): string | undefined {
    const value = this.values()[key];
    return value === undefined || value === "" ? undefined : value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Replaces the last assignment of `key` (dropping earlier ones), or appends. */
  set(key: string, value: string): void {
    const line = `${key}=${quote(value)}`;
    const indexes = this.lines.flatMap((text, index) => (KEY_PATTERN.exec(text)?.[1] === key ? [index] : []));
    const last = indexes.at(-1);
    if (last === undefined) {
      this.lines.push(line);
      return;
    }
    this.lines[last] = line;
    for (const index of indexes.slice(0, -1).reverse()) this.lines.splice(index, 1);
  }

  append(...lines: string[]): void {
    this.lines.push(...lines);
  }

  toString(): string {
    return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
  }
}

/** Quotes a value only when it needs it; refuses values Node's parser cannot round-trip. */
export function quote(value: string): string {
  if (/[\r\n]/u.test(value)) throw new Error("env values cannot contain line breaks");
  if (SAFE_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  throw new Error("cannot write an env value containing both quote characters");
}

export function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Writes `text` owner-only (0600), atomically, creating the directory (0700) if needed. */
export function writePrivateFile(path: string, text: string): void {
  ensurePrivateDir(dirname(path));
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
