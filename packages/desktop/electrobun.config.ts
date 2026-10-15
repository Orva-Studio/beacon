import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectrobunConfig } from "electrobun";

// Read, not imported: Electrobun's config runtime gives a JSON import's `version` as undefined, and the app then
// silently becomes its default 0.1.0.
const { version } = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };

// The engine and Beacon's own ffmpeg, ffprobe and whisper-cli, staged by scripts/bundle-tools.ts (run by `dev` and `build`).
const STAGE = "../engine/target/bundle";
const staged = existsSync(join(import.meta.dir, STAGE)) ? readdirSync(join(import.meta.dir, STAGE)) : [];

export default {
  app: { name: "Beacon", identifier: "dev.beacon.editor", version },
  scripts: { postBuild: "build-hook.ts", postWrap: "build-hook.ts", postPackage: "package-hook.ts" },
  // Check for Updates reads <baseUrl>/stable-macos-arm64-update.json, which each GitHub release carries (the latest
  // release's files are always at this URL). No delta patches: they would be made by downloading the previous release.
  release: { baseUrl: "https://github.com/Orva-Studio/beacon/releases/latest/download", generatePatch: false },
  build: {
    // Bun, not Cottontail: the engine loads through bun:ffi and the packages are Bun TypeScript.
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts", external: ["bun:ffi"] },
    views: { mainview: { entrypoint: "../ui/src/main.tsx" }, recordpanel: { entrypoint: "../ui/src/record-panel-main.tsx" } },
    copy: {
      "../ui/src/index.html": "views/mainview/index.html",
      "../ui/dist/styles.css": "views/mainview/styles.css",
      "../ui/src/record-panel.html": "views/recordpanel/index.html",
      "../../THIRD_PARTY_NOTICES": "THIRD_PARTY_NOTICES",
      ...Object.fromEntries(staged.map((f) => [`${STAGE}/${f}`, `engine/${f}`])),
    },
    watch: ["../ui/src", "../core/src", "../model/src", "../render/src", "../media/src", "../features/src"],
    mac: { bundleCEF: false, codesign: false, notarize: false },
  },
} satisfies ElectrobunConfig;
