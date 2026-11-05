import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase, RegistryStore } from './store.js';

process.umask(0o077);
const config = loadConfig();
const db = openDatabase({ dataDirectory: config.dataDirectory, autoMigrate: config.autoMigrate, readOnly: config.readOnly });
const store = new RegistryStore(db, config.installation);
const server = createServer(createApp({ store, installation: config.installation, readToken: config.readToken, writeToken: config.writeToken, readOnly: config.readOnly, log: (line) => console.log(line) }));
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.listen(config.port, config.host, () => console.log(JSON.stringify({ message: 'hive-registry listening', port: config.port, readOnly: config.readOnly })));

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  // Finish in-flight requests, then close SQLite cleanly so the WAL is checkpointed
  // before a backup archives the stopped data directory.
  const force = setTimeout(() => server.closeAllConnections(), 5_000);
  force.unref();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
