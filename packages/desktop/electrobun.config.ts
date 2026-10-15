import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ElectrobunConfig } from "electrobun";
import { version } from "../../package.json";

// The engine and Beacon's own ffmpeg, ffprobe and whisper-cli, staged by scripts/bundle-tools.ts (run by `dev` and `build`).
const STAGE = "../engine/target/bundle";
const staged = existsSync(join(import.meta.dir, STAGE)) ? readdirSync(join(import.meta.dir, STAGE)) : [];

export default {
  app: { name: "Beacon", identifier: "dev.beacon.editor", version },
  scripts: { postBuild: "build-hook.ts", postWrap: "build-hook.ts" },
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
