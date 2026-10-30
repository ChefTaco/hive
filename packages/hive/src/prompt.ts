import { createInterface, type Interface } from "node:readline";
import { CliError } from "./errors.js";
import type { Output } from "./output.js";

export interface Prompter {
  /** Yes/no question. Enter takes the default. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** Free-text question. Enter takes the default. */
  ask(question: string, defaultValue: string): Promise<string>;
  close(): void;
}

export interface PrompterOptions {
  /** `--yes`: take the default answer of every question without asking. */
  yes: boolean;
  output: Output;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  terminal?: NodeJS.WritableStream;
}

const NOT_INTERACTIVE = "this step asks a question, but standard input is not a terminal. Re-run with --yes to accept the default answers, or run it in a terminal.";

/**
 * Reads answers line by line from a terminal. The terminal stays in its normal
 * (cooked) mode, so it echoes and edits lines itself, child processes inherit
 * a sane terminal, and answers typed ahead are queued instead of lost.
 */
export function createPrompter(options: PrompterOptions): Prompter {
  const input = options.input ?? process.stdin;
  const terminal = options.terminal ?? process.stdout;
  let rl: Interface | null = null;
  const queued: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  const nextLine = (prompt: string): Promise<string> => {
    if (!input.isTTY) throw new CliError(NOT_INTERACTIVE);
    if (!rl) {
      rl = createInterface({ input, terminal: false });
      rl.on("line", (line) => {
        const resolve = waiting.shift();
        if (resolve) resolve(line);
        else queued.push(line);
      });
      rl.on("close", () => {
        ended = true;
        for (const resolve of waiting.splice(0)) resolve(null);
      });
    }
    terminal.write(prompt);
    const ready = queued.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (ended) return Promise.reject(new CliError("standard input closed before the question was answered"));
    return new Promise((resolve, reject) => {
      waiting.push((line) => (line === null ? reject(new CliError("standard input closed before the question was answered")) : resolve(line)));
    });
  };

  return {
    async confirm(question, defaultYes = true) {
      const hint = defaultYes ? "[Y/n]" : "[y/N]";
      if (options.yes) {
        options.output.info(`? ${question} ${hint} ${defaultYes ? "yes" : "no"} (--yes)`);
        return defaultYes;
      }
      for (;;) {
        const answer = (await nextLine(`? ${question} ${hint} `)).trim().toLowerCase();
        if (answer === "") return defaultYes;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        options.output.info("  Please answer y or n.");
      }
    },
    async ask(question, defaultValue) {
      if (options.yes) {
        options.output.info(`? ${question} [${defaultValue}] ${defaultValue} (--yes)`);
        return defaultValue;
      }
      const answer = (await nextLine(`? ${question} [${defaultValue}] `)).trim();
      return answer === "" ? defaultValue : answer;
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}

/** Answers questions from a list, for tests. Throws when it runs out. */
export function scriptedPrompter(answers: string[], asked: string[] = []): Prompter {
  const next = (question: string): string => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected question: ${question}`);
    return answer;
  };
  return {
    async confirm(question, defaultYes = true) {
      const answer = next(question).trim().toLowerCase();
      return answer === "" ? defaultYes : answer.startsWith("y");
    },
    async ask(question, defaultValue) {
      const answer = next(question).trim();
      return answer === "" ? defaultValue : answer;
    },
    close() {},
  };
}
