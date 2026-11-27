// Electrobun's postPackage hook (electrobun.config.ts): the update archive in the artifacts is the app as Electrobun
// packed it, unsigned; build-hook.ts left the signed one in the build folder, which replaces it here. The DMG gets its
// window (dmg/style.ts) before the release signs and notarizes it.
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { styleDmg } from "./dmg/style";

const dir = process.env.ELECTROBUN_BUILD_DIR;
const artifacts = process.env.ELECTROBUN_ARTIFACT_DIR;
if (!dir || !artifacts) throw new Error("package-hook.ts runs from electrobun build");
const files = existsSync(artifacts) ? readdirSync(artifacts) : [];
const signed = join(dir, "signed-update.tar.zst");
const update = files.find((f) => f.endsWith(".app.tar.zst"));
if (existsSync(signed) && update) {
  copyFileSync(signed, join(artifacts, update));
  rmSync(signed);
}
const dmg = files.find((f) => f.endsWith(".dmg"));
if (dmg) await styleDmg(join(artifacts, dmg));
