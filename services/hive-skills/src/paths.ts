import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Both src/ and dist/ are directly below the package root. */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const bundledDeployScript = resolve(packageRoot, 'scripts/deploy-hermes-agent.sh');
export const bundledSeedSource = resolve(packageRoot, 'registry-sources/hivemem');
