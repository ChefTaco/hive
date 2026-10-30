import { UsageError } from "./errors.js";

export type FlagKind = "boolean" | "string" | "repeat";

export interface ParsedFlags {
  booleans: Set<string>;
  strings: Map<string, string>;
  repeats: Map<string, string[]>;
  positionals: string[];
}

const ALIASES: Record<string, string> = { "-y": "--yes", "-h": "--help", "-v": "--version" };

/** Parses `--flag`, `--flag value` and `--flag=value` against a spec; unknown flags are usage errors. */
export function parseFlags(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>, command: string): ParsedFlags {
  const parsed: ParsedFlags = { booleans: new Set(), strings: new Map(), repeats: new Map(), positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    if (raw === "--") {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!raw.startsWith("-") || raw === "-") {
      parsed.positionals.push(raw);
      continue;
    }
    const equals = raw.indexOf("=");
    const name = ALIASES[raw] ?? (equals > 0 ? raw.slice(0, equals) : raw);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option ${name} for \`hive ${command}\`; run \`hive ${command} --help\``);
    if (kind === "boolean") {
      if (equals > 0) throw new UsageError(`${name} does not take a value`);
      parsed.booleans.add(name);
      continue;
    }
    let value: string | undefined;
    if (equals > 0) value = raw.slice(equals + 1);
    else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
      index += 1;
    }
    if (value === "") throw new UsageError(`${name} needs a value`);
    if (kind === "string") parsed.strings.set(name, value);
    else parsed.repeats.set(name, [...(parsed.repeats.get(name) ?? []), value]);
  }
  return parsed;
}
