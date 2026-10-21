import fs from "node:fs";
import path from "node:path";

try {
  if (typeof process.loadEnvFile === "function") {
    if (fs.existsSync(".env")) {
      process.loadEnvFile(".env");
    } else if (fs.existsSync("../../.env")) {
      process.loadEnvFile("../../.env");
    } else {
      // Traverse up to find root .env
      let dir = process.cwd();
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, ".env");
        if (fs.existsSync(candidate)) {
          process.loadEnvFile(candidate);
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
} catch {
  // .env may not exist
}
