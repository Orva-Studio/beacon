import type { ElectrobunConfig } from "electrobun";
import { version } from "../../package.json";

export default {
  app: { name: "Beacon", identifier: "dev.beacon.editor", version },
  build: {
    // Bun, not Cottontail: the engine loads through bun:ffi and the packages are Bun TypeScript.
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts", external: ["bun:ffi"] },
    views: { mainview: { entrypoint: "../ui/src/main.tsx" }, recordpanel: { entrypoint: "../ui/src/record-panel-main.tsx" } },
    copy: {
      "../ui/src/index.html": "views/mainview/index.html",
      "../ui/dist/styles.css": "views/mainview/styles.css",
      "../ui/src/record-panel.html": "views/recordpanel/index.html",
      "../engine/target/release/libbeacon_ffi.dylib": "engine/libbeacon_ffi.dylib",
      "../engine/target/release/beacon-worker": "engine/beacon-worker",
      "../engine/target/release/beacon-recorder": "engine/beacon-recorder",
    },
    watch: ["../ui/src", "../core/src", "../model/src", "../render/src", "../media/src", "../features/src"],
    mac: { bundleCEF: false, codesign: false, notarize: false },
  },
} satisfies ElectrobunConfig;
