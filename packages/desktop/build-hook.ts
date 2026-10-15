// Electrobun's postBuild and postWrap hooks (electrobun.config.ts). postBuild gets the app before Electrobun packs it
// into its self-extracting wrapper, so its Info.plist entries are written there. Signing waits for postWrap: Electrobun
// writes the build's hash into the app's version.json after postBuild, which would break the seal, so the packed app
// is unpacked, signed and packed again, then the wrapper the DMG holds is signed. Ad hoc until there is a Developer
// ID: hardened runtime and notarization come with one.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { patchInfoPlist } from "./src/bun/info-plist";

const sign = (app: string) => $`codesign --force --deep --sign - ${app}`.quiet();

const wrapper = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
const dir = process.env.ELECTROBUN_BUILD_DIR;
if (!dir) throw new Error("build-hook.ts runs from electrobun build");

if (!wrapper) {
  for (const app of readdirSync(dir).filter((f) => f.endsWith(".app"))) patchInfoPlist(join(dir, app, "Contents/Info.plist"));
} else {
  const resources = join(wrapper, "Contents/Resources");
  const packed = readdirSync(resources).find((f) => f.endsWith(".tar.zst"));
  if (!packed) throw new Error(`no packed app in ${resources}`);
  const work = mkdtempSync(join(tmpdir(), "beacon-sign-"));
  try {
    writeFileSync(join(work, "app.tar"), Bun.zstdDecompressSync(readFileSync(join(resources, packed))));
    await $`tar -xf app.tar && rm app.tar`.cwd(work).quiet();
    const [app] = readdirSync(work).filter((f) => f.endsWith(".app"));
    if (!app) throw new Error(`no app in ${packed}`);
    await sign(join(work, app));
    // No AppleDouble files or extended attributes in the archive: the extractor would write them into the app.
    await $`tar --no-xattrs --no-mac-metadata -cf app.tar ${app}`.cwd(work).env({ ...process.env, COPYFILE_DISABLE: "1" }).quiet();
    writeFileSync(join(resources, packed), Bun.zstdCompressSync(readFileSync(join(work, "app.tar")), { level: 19 }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  await sign(wrapper);
}
