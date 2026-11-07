const fs = require("fs");
const path = require("path");
const logFile = process.env.BRIDGE_LOG || path.join(__dirname, "boot.log");
const log = (message) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
};
log(`bootstrap start cwd=${process.cwd()} argv=${process.argv.join(" ")}`);
process.on("uncaughtException", (error) => log(`uncaught ${error && error.stack ? error.stack : error}`));
process.on("unhandledRejection", (error) => log(`rejection ${error && error.stack ? error.stack : error}`));
try {
  require("./dist/main.cjs");
  log("main loaded");
} catch (error) {
  log(`main load failed: ${error && error.stack ? error.stack : error}`);
}
