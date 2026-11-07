import { resolve } from "node:path";
import { build } from "esbuild";

const entry = process.argv[2];
const outfile = process.argv[3];
if (!entry || !outfile) {
  console.error("usage: node scripts/build-node.mjs <entry.ts> <outfile.cjs>");
  process.exit(2);
}
try {
  await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: resolve(outfile),
    logLevel: "warning",
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
