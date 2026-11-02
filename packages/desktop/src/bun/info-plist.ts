import { existsSync } from "node:fs";

/**
 * Info.plist entries Electrobun's config can't set: the camera and microphone prompts need their usage strings
 * (the recorder sidecar asks as the app), and a take (`.brec` folder) and a project (`.beproj` folder) are packages,
 * so Finder and Open panels treat each as one file; a project shows Beacon's icon and opens in it on a double-click.
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
    {
      UTTypeIdentifier: "dev.beacon.project",
      UTTypeDescription: "Beacon Project",
      UTTypeConformsTo: ["com.apple.package", "public.composite-content"],
      UTTypeTagSpecification: { "public.filename-extension": ["beproj"] },
      UTTypeIconFile: "AppIcon",
    },
  ]),
  CFBundleDocumentTypes: JSON.stringify([
    { CFBundleTypeName: "Beacon Recording", CFBundleTypeRole: "Viewer", LSItemContentTypes: ["dev.beacon.recording"], LSTypeIsPackage: true },
    { CFBundleTypeName: "Beacon Project", CFBundleTypeRole: "Editor", LSHandlerRank: "Owner", LSItemContentTypes: ["dev.beacon.project"], LSTypeIsPackage: true, CFBundleTypeIconFile: "AppIcon" },
  ]),
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
