import { readFileSync } from 'node:fs';
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const environment = z.object({
  HIVE_REGISTRY_INSTALLATION: id,
  HIVE_REGISTRY_DATA_DIR: z.string().startsWith('/').default('/data'),
  HIVE_REGISTRY_HOST: z.string().min(1).default('0.0.0.0'),
  HIVE_REGISTRY_PORT: z.coerce.number().int().min(1).max(65535).default(8095),
  HIVE_REGISTRY_READ_TOKEN_FILE: z.string().startsWith('/').default('/config/read-token'),
  HIVE_REGISTRY_WRITE_TOKEN_FILE: z.string().startsWith('/').default('/config/write-token'),
  HIVE_AUTO_MIGRATE: z.enum(['true', 'false']).default('false'),
  HIVE_REHEARSAL: z.enum(['true', 'false']).default('false'),
});

export type Config = {
  installation: string;
  dataDirectory: string;
  host: string;
  port: number;
  readToken: string;
  writeToken: string;
  autoMigrate: boolean;
  readOnly: boolean;
};

function token(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error(`Registry credential file ${path} is not a valid credential`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environment.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid Hive Registry environment: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  const values = parsed.data;
  const readToken = token(values.HIVE_REGISTRY_READ_TOKEN_FILE);
  const writeToken = token(values.HIVE_REGISTRY_WRITE_TOKEN_FILE);
  if (readToken === writeToken) throw new Error('Hive Registry read and write credentials must differ');
  return {
    installation: values.HIVE_REGISTRY_INSTALLATION,
    dataDirectory: values.HIVE_REGISTRY_DATA_DIR,
    host: values.HIVE_REGISTRY_HOST,
    port: values.HIVE_REGISTRY_PORT,
    readToken,
    writeToken,
    autoMigrate: values.HIVE_AUTO_MIGRATE === 'true',
    readOnly: values.HIVE_REHEARSAL === 'true',
  };
}
