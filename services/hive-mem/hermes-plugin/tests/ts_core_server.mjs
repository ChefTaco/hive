import { createHiveMemServer, signToken } from "../../ts-core/dist/src/index.js";

const jwtSecret = "hermes_dual_stack_test_secret_32_bytes";
const token = signToken(jwtSecret, {
  sub: "hermes-ts-agent",
  role: "admin",
  scope: "admin:queue memories:read memories:write sessions:read sessions:write context:read",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

const server = createHiveMemServer({ jwtSecret });

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TS core server did not bind to a TCP port");
  console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token }));
});
