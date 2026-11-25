const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const baseDir = "D:\\era-voice-assistant";
const asarPath = "C:\\Users\\MSI\\AppData\\Local\\Programs\\ERA AI Assistant\\resources\\app.asar";
const tempDir = "C:\\Users\\MSI\\AppData\\Local\\Temp\\era_asar_temp";
const distServer = path.join(baseDir, "dist", "server.cjs");

console.log("[Deploy] Step 1: Building server.ts with esbuild (full bundle)...");
execSync("npx esbuild server.ts --bundle --platform=node --format=cjs --sourcemap --outfile=dist/server.cjs", {
  cwd: baseDir,
  stdio: "inherit"
});

// Verify no unbundled genai
const builtCode = fs.readFileSync(distServer, "utf8");
if (builtCode.includes('require("@google/genai")') || builtCode.includes("require('@google/genai')")) {
  console.error("ERROR: dist/server.cjs contains unbundled require('@google/genai')! Aborting.");
  process.exit(1);
}

console.log("[Deploy] Step 2: Extracting app.asar...");
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
execSync(`npx @electron/asar extract "${asarPath}" "${tempDir}"`, { stdio: "inherit" });

console.log("[Deploy] Step 3: Syncing dist into extracted asar...");
const targetDist = path.join(tempDir, "dist");
fs.rmSync(targetDist, { recursive: true, force: true });
fs.cpSync(path.join(baseDir, "dist"), targetDist, { recursive: true });

console.log("[Deploy] Step 4: Creating backup of app.asar...");
fs.copyFileSync(asarPath, asarPath + ".bak_auto_" + Date.now());

console.log("[Deploy] Step 5: Repacking app.asar...");
execSync(`npx @electron/asar pack "${tempDir}" "${asarPath}"`, { stdio: "inherit" });
fs.copyFileSync(asarPath, path.join(baseDir, "app.asar"));

console.log("[Deploy] Step 6: Cleaning up temp directory...");
fs.rmSync(tempDir, { recursive: true, force: true });

console.log("[Deploy] SUCCESS: app.asar updated and deployed successfully!");
