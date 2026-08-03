import { loadRootEnv } from "./env";
import { createAdminApp } from "./app";
import { createAdminDependencies } from "./dependencies";

const rootEnv = loadRootEnv();
console.log(`ADMIN_API_TOKEN: ${rootEnv.adminTokenConfigured ? "configured" : "missing"}`);
console.log(`AI_CREDENTIAL_ENCRYPTION_KEY: ${rootEnv.credentialEncryptionKeyConfigured ? "configured" : "missing"}`);

const dependencies = createAdminDependencies({ env: process.env });
const port = Number(process.env.ADMIN_API_PORT || 4300);
const host = process.env.ADMIN_API_HOST || "127.0.0.1";

createAdminApp(dependencies).listen(port, host, () => {
  console.log(
    `AI-adm-D1 API listening on ${host}:${port} (legacy book AI: ${dependencies.ai.name}; gateway default: ${dependencies.gatewayConfig.defaultProvider})`
  );
});
