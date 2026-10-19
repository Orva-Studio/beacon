import { existsSync } from "node:fs";

/**
 * Info.plist entries Electrobun's config can't set: the camera and microphone prompts need their usage strings
 * (the recorder sidecar asks as the app), and a take (`.brec` folder) is a package, so Finder and Open panels
 * treat it as one file.
 */
const ENTRIES: Record<string, string> = {
  NSCameraUsageDescription: JSON.stringify("Beacon records your camera when you choose it as a source."),
  NSMicrophoneUsageDescription: JSON.stringify("Beacon records your microphone when you choose it as a source."),
  UTExportedTypeDeclarations: JSON.stringify([
    {
      UTTypeIdentifier: "dev.beacon.recording",
      UTTypeDescription: "Beacon Recording",
      UTTypeConformsTo: ["com.apple.package", "public.composite-content"],
      UTTypeTagSpecification: { "public.filename-extension": ["brec"] },
    },
  ]),
  CFBundleDocumentTypes: JSON.stringify([{ CFBundleTypeName: "Beacon Recording", CFBundleTypeRole: "Viewer", LSItemContentTypes: ["dev.beacon.recording"], LSTypeIsPackage: true }]),
};

/** Writes the entries into an app bundle's Info.plist; true when it changed. */
export function patchInfoPlist(plist: string): boolean {
  if (!existsSync(plist)) return false;
  const current = Bun.spawnSync(["/usr/bin/plutil", "-extract", "NSCameraUsageDescription", "raw", plist]);
  if (current.exitCode === 0) return false;
  for (const [key, json] of Object.entries(ENTRIES)) {
    const r = Bun.spawnSync(["/usr/bin/plutil", "-replace", key, "-json", json, plist]);
    if (r.exitCode !== 0) throw new Error(`plutil ${key}: ${r.stderr.toString()}`);
  }
  return true;
}

if (import.meta.main) {
  const plist = process.argv[2];
  if (!plist) throw new Error("usage: bun src/bun/info-plist.ts <App.app/Contents/Info.plist>");
  console.log(patchInfoPlist(plist) ? `info-plist: patched ${plist}` : `info-plist: ${plist} already has its entries`);
}
