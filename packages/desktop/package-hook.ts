// Electrobun's postPackage hook (electrobun.config.ts): the update archive in the artifacts is the app as Electrobun
// packed it, unsigned; build-hook.ts left the signed one in the build folder, which replaces it here.
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.ELECTROBUN_BUILD_DIR;
const artifacts = process.env.ELECTROBUN_ARTIFACT_DIR;
if (!dir || !artifacts) throw new Error("package-hook.ts runs from electrobun build");
const signed = join(dir, "signed-update.tar.zst");
const update = existsSync(artifacts) ? readdirSync(artifacts).find((f) => f.endsWith(".app.tar.zst")) : undefined;
if (existsSync(signed) && update) {
  copyFileSync(signed, join(artifacts, update));
  rmSync(signed);
}
