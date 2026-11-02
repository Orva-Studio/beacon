import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchInfoPlist } from "../src/bun/info-plist";

const BUILT = join(import.meta.dir, "../build/dev-macos-arm64/Beacon-dev.app/Contents/Info.plist");
const dir = mkdtempSync(join(tmpdir(), "beacon-plist-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (plist: string, key: string) => JSON.parse(Bun.spawnSync(["/usr/bin/plutil", "-extract", key, "json", "-o", "-", plist]).stdout.toString());

test.skipIf(!existsSync(BUILT))("the app's Info.plist declares a project (.beproj) a package Beacon owns, with Beacon's icon, beside a take (.brec)", () => {
  const plist = join(dir, "Info.plist");
  copyFileSync(BUILT, plist);
  // A built app has them already: patched from Electrobun's own, without them.
  Bun.spawnSync(["/usr/bin/plutil", "-remove", "NSCameraUsageDescription", plist]);
  expect(patchInfoPlist(plist)).toBe(true);
  expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", plist]).exitCode).toBe(0);
  const types = read(plist, "UTExportedTypeDeclarations") as { UTTypeIdentifier: string; UTTypeConformsTo: string[]; UTTypeTagSpecification: Record<string, string[]> }[];
  expect(types.map((t) => [t.UTTypeIdentifier, t.UTTypeTagSpecification["public.filename-extension"]])).toEqual([["dev.beacon.recording", ["brec"]], ["dev.beacon.project", ["beproj"]]]);
  expect(types.every((t) => t.UTTypeConformsTo.includes("com.apple.package"))).toBe(true);
  const docs = read(plist, "CFBundleDocumentTypes") as { LSItemContentTypes: string[]; CFBundleTypeRole: string; CFBundleTypeIconFile?: string }[];
  const project = docs.find((d) => d.LSItemContentTypes.includes("dev.beacon.project"))!;
  expect(project).toMatchObject({ CFBundleTypeRole: "Editor", CFBundleTypeIconFile: "AppIcon", LSTypeIsPackage: true });
  expect(Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleIconFile", "raw", "-o", "-", plist]).stdout.toString().trim()).toBe("AppIcon");
});
