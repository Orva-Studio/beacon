// Electrobun's DMG is a bare window; this rebuilds it with the background, layout and volume icon made by layout.ts.
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const here = import.meta.dir;

async function attach(image: string, ...flags: string[]) {
  const out = await $`hdiutil attach -nobrowse -noverify -noautoopen ${flags} ${image}`.text();
  const mount = out.match(/\t(\/Volumes\/.*)$/m)?.[1];
  if (!mount) throw new Error(`${image} didn't mount`);
  return mount;
}

export async function styleDmg(dmg: string) {
  const work = mkdtempSync(join(tmpdir(), "beacon-dmg-"));
  try {
    const stage = join(work, "Beacon");
    const original = await attach(dmg, "-readonly");
    try {
      await $`ditto ${original} ${stage}`;
    } finally {
      await $`hdiutil detach -quiet ${original}`;
    }
    mkdirSync(join(stage, ".background"));
    copyFileSync(join(here, "background.tiff"), join(stage, ".background/background.tiff"));
    copyFileSync(join(here, "DS_Store"), join(stage, ".DS_Store"));
    await $`iconutil -c icns -o ${join(stage, ".VolumeIcon.icns")} ${join(here, "../icon.iconset")}`;

    // The volume name must be the one layout.ts arranged: Finder finds the background through it.
    const rw = join(work, "rw.dmg");
    await $`hdiutil create -quiet -volname Beacon -srcfolder ${stage} -fs HFS+ -format UDRW ${rw}`;
    const mount = await attach(rw, "-readwrite");
    try {
      // The custom-icon flag (kHasCustomIcon) on the volume, so Finder shows .VolumeIcon.icns.
      await $`xattr -wx com.apple.FinderInfo ${"0000000000000000040000000000000000000000000000000000000000000000"} ${mount}`;
    } finally {
      await $`hdiutil detach -quiet ${mount}`;
    }
    const out = join(work, "out.dmg");
    await $`hdiutil convert -quiet ${rw} -format ULFO -o ${out}`;
    renameSync(out, dmg);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
