import type { Writable } from "node:stream";

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 } as const;
export type Color = keyof typeof CODES;

/** Colors only for a terminal, honoring NO_COLOR and FORCE_COLOR. */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY);
}

export function paint(text: string, color: Color, enabled = colorEnabled()): string {
  return enabled ? `\u001b[${CODES[color]}m${text}\u001b[0m` : text;
}

export interface Output {
  info(line?: string): void;
  step(line: string): void;
  ok(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  heading(line: string): void;
  readonly color: boolean;
}

export function createOutput(stdout: Writable & { isTTY?: boolean } = process.stdout, stderr: Writable = process.stderr): Output {
  const color = colorEnabled(stdout);
  const write = (stream: Writable, text: string) => stream.write(`${text}\n`);
  return {
    color,
    info: (line = "") => write(stdout, line),
    step: (line) => write(stdout, `${paint("•", "blue", color)} ${line}`),
    ok: (line) => write(stdout, `${paint("✓", "green", color)} ${line}`),
    warn: (line) => write(stderr, `${paint("!", "yellow", color)} ${line}`),
    error: (line) => write(stderr, `${paint("✗", "red", color)} ${line}`),
    heading: (line) => write(stdout, `\n${paint(line, "bold", color)}`),
  };
}

/** Replaces all but the first four characters of a secret, for change summaries. */
export function mask(value: string): string {
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}••••`;
}
