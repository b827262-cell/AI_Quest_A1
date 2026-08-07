import { hashAdminPassword } from "../apps/AI-adm-D1/src/server/ai/admin-auth.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (!password) {
  console.error("read password from stdin");
  process.exitCode = 1;
} else {
  process.stdout.write(`${hashAdminPassword(password)}\n`);
}

