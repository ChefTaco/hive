import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Package root: `src/cli` and `dist/cli` both sit two levels below it. */
export const PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..')
export const MIGRATIONS_DIR = join(PACKAGE_ROOT, 'prisma', 'migrations')
export const SEED_SCRIPT = join(PACKAGE_ROOT, 'dist', 'prisma', 'seed.js')
export const RESET_ADMIN_SCRIPT = join(PACKAGE_ROOT, 'dist', 'scripts', 'reset-admin-password.js')

type Source = Record<string, string | undefined>

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/** `${HIVE_HOME:-~/.hive}` */
export function hiveHome(source: Source = process.env): string {
  return resolve(expandHome(present(source['HIVE_HOME']) ? source['HIVE_HOME'] : '~/.hive'))
}

/** `${IAM_DATA_DIR:-${HIVE_HOME:-~/.hive}/iam}` */
export function iamDataDir(source: Source = process.env): string {
  const configured = source['IAM_DATA_DIR']
  return present(configured) ? resolve(expandHome(configured)) : join(hiveHome(source), 'iam')
}

/** Same resolution the Prisma better-sqlite3 adapter applies (relative to cwd). */
export function sqlitePathFromUrl(url: string): string {
  const path = url.replace(/^file:/, '')
  return isAbsolute(path) ? path : resolve(path)
}
