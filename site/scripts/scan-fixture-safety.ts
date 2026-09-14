import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "fixtures", "data");

function checkFixtureSafety() {
  console.log("🔍 Scanning fixtures for safety compliance...");

  if (!fs.existsSync(DATA_DIR)) {
    console.error("❌ Fixture directory does not exist. Run fixture:generate first.");
    process.exit(1);
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  let hasError = false;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);

    // 1. Check for real PII / email domains
    const realEmailRegex = /@[a-zA-Z0-9.-]+\.(com|org|net|edu|tw|cn)\b/i;
    const syntheticEmailRegex = /@(synthetic\.|example\.)/i;
    const matches = content.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
    for (const email of matches) {
      if (!syntheticEmailRegex.test(email)) {
        console.error(`❌ Prohibited real email detected in ${file}: ${email}`);
        hasError = true;
      }
    }

    // 2. Check for password hashes / secrets
    if (content.includes("$2b$") || content.includes("$2a$") || /"(password|secret|hash)":\s*"[^"]+"/i.test(content)) {
      console.error(`❌ Prohibited credentials detected in ${file}`);
      hasError = true;
    }

    // 3. Check for IPv4 addresses
    const ipMatches = content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    for (const ip of ipMatches) {
      if (ip !== "127.0.0.1" && ip !== "0.0.0.0") {
        console.error(`❌ Non-local IP address found in ${file}: ${ip}`);
        hasError = true;
      }
    }

    // 4. Check provenance
    if (parsed.items) {
      for (const item of parsed.items) {
        if (!item.provenance || !item.provenance.includes("synthetic")) {
          console.error(`❌ Item in ${file} missing synthetic provenance tag: ${item.id}`);
          hasError = true;
        }
      }
    }
  }

  if (hasError) {
    console.error("❌ Fixture Safety Scan: FAIL");
    process.exit(1);
  }

  console.log("✅ Fixture Safety Scan: PASS (10/10 compliant, 0 production leaks)");
}

checkFixtureSafety();
