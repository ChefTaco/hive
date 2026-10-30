export const COMMANDS = ['start', 'migrate', 'check', 'env-schema', 'reset-admin'] as const
export type Command = (typeof COMMANDS)[number]

export interface CliOptions {
  command: Command | 'help' | 'version'
  envFiles: string[]
  migrate: boolean
}

export class UsageError extends Error {}

export const USAGE = `Usage: hive-iam-server [command] [options]

Hive IAM: OAuth 2.0 / OpenID Connect identity service.

Commands:
  start         Start the server (default). Applies pending database migrations
                and, on an empty database, creates the initial admin account.
  migrate       Apply pending migrations (and the first-start bootstrap), then exit.
  check         Validate configuration, TLS files, data directory, signing keys
                and Redis. Prints a report and exits 0 (ok) or 1 (problems).
                Starts no listeners and writes nothing.
  env-schema    Print the supported environment variables as JSON.
  reset-admin   Set the admin password from IAM_RESET_PASSWORD (and optionally
                IAM_RESET_USERNAME / IAM_RESET_EMAIL), then exit.

Options:
  --env-file <path>  Load variables from a dotenv file before reading the
                     configuration. Variables already in the environment win.
                     May be given more than once (earlier files win).
  --no-migrate       start: do not apply migrations; refuse to start if any
                     are pending.
  -h, --help         Show this help.
  -v, --version      Print the version.

Data defaults to \${HIVE_HOME:-~/.hive}/iam. See https://github.com/ChefTaco/hive/tree/main/services/hive-iam/apps/iam-core#readme
`

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { command: 'start', envFiles: [], migrate: true }
  let commandSeen = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '-h' || arg === '--help' || arg === 'help') return { ...options, command: 'help' }
    if (arg === '-v' || arg === '--version') return { ...options, command: 'version' }
    if (arg === '--env-file') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new UsageError('--env-file needs a path')
      options.envFiles.push(value)
      index++
      continue
    }
    if (arg.startsWith('--env-file=')) {
      const value = arg.slice('--env-file='.length)
      if (!value) throw new UsageError('--env-file needs a path')
      options.envFiles.push(value)
      continue
    }
    if (arg === '--no-migrate') {
      options.migrate = false
      continue
    }
    if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`)
    if (commandSeen) throw new UsageError(`unexpected argument ${arg}`)
    if (!(COMMANDS as readonly string[]).includes(arg)) throw new UsageError(`unknown command ${arg}`)
    options.command = arg as Command
    commandSeen = true
  }
  return options
}
