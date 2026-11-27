// Makes the DMG window's assets once, on a Mac with Chrome: bun packages/desktop/dmg/layout.ts
// background.tiff is background.html at 1x and 2x. DS_Store is the window Finder saves after AppleScript arranges a
// scratch volume named Beacon; package-hook.ts copies both into every DMG, so a release needs no Finder. Finder finds the
// background by its path on the volume, so the volume name, the item names and .background/background.tiff must match.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const WINDOW = { width: 640, height: 400 };
// The picture's size (background.html's body): dark past the window's own 640x400, as Finder doesn't stretch it.
const PICTURE = { width: 2560, height: 1600 };
const ICONS = { app: { x: 160, y: 196 }, applications: { x: 480, y: 196 }, size: 128 };

// Finder saves the window's frame as it ended up, which a window manager may have resized. The frame is a string in a
// binary plist, so it is rewritten padded to the same length: nothing else in the file moves. 28 is the title bar.
function withBounds(store: Buffer) {
  const text = store.toString("latin1");
  const old = text.match(/\{\{-?\d+, -?\d+\}, \{\d+, \d+\}\}/)?.[0];
  if (!old) throw new Error("no WindowBounds in the .DS_Store");
  const head = "{{200, 300}, {";
  const tail = `${WINDOW.width}, ${WINDOW.height + 28}}}`;
  if (head.length + tail.length > old.length) throw new Error(`can't fit the bounds in place of ${old}`);
  const bounds = head + " ".repeat(old.length - head.length - tail.length) + tail;
  return Buffer.from(text.replace(old, bounds), "latin1");
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const here = import.meta.dir;
const work = mkdtempSync(join(tmpdir(), "beacon-dmg-layout-"));
const shot = async (scale: number, out: string) =>
  await $`${CHROME} --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=${scale} --virtual-time-budget=2000 --window-size=${PICTURE.width},${PICTURE.height} --screenshot=${out} file://${join(here, "background.html")}`.quiet();

try {
  await shot(1, join(work, "bg.png"));
  await shot(2, join(work, "bg@2x.png"));
  await $`tiffutil -cathidpicheck ${join(work, "bg.png")} ${join(work, "bg@2x.png")} -out ${join(work, "bg.tiff")}`.quiet();
  // Mostly flat colour: compressed, it stays small at this size.
  await $`tiffutil -lzw ${join(work, "bg.tiff")} -out ${join(here, "background.tiff")}`.quiet();

  const root = join(work, "root");
  mkdirSync(join(root, "Beacon.app"), { recursive: true });
  symlinkSync("/Applications", join(root, "Applications"));
  mkdirSync(join(root, ".background"));
  copyFileSync(join(here, "background.tiff"), join(root, ".background/background.tiff"));
  const image = join(work, "layout.dmg");
  await $`hdiutil create -quiet -volname Beacon -srcfolder ${root} -fs HFS+ -format UDRW -size 20m ${image}`;
  const mount = (await $`hdiutil attach -readwrite -noverify -noautoopen ${image}`.text()).match(/\/Volumes\/.*$/m)?.[0];
  if (!mount) throw new Error("the scratch volume didn't mount");
  try {
    if (mount !== "/Volumes/Beacon") throw new Error(`mounted at ${mount}: eject the other Beacon volume first`);
    const left = 200;
    const top = 120;
    await $`osascript -e ${`
      tell application "Finder"
        tell disk "Beacon"
          open
          set current view of container window to icon view
          set toolbar visible of container window to false
          set statusbar visible of container window to false
          set bounds of container window to {${left}, ${top}, ${left + WINDOW.width}, ${top + WINDOW.height}}
          set opts to the icon view options of container window
          set arrangement of opts to not arranged
          set icon size of opts to ${ICONS.size}
          set text size of opts to 13
          set background picture of opts to file ".background:background.tiff"
          set position of item "Beacon.app" of container window to {${ICONS.app.x}, ${ICONS.app.y}}
          set position of item "Applications" of container window to {${ICONS.applications.x}, ${ICONS.applications.y}}
          update without registering applications
          delay 2
          close
        end tell
      end tell`}`;
    await Bun.sleep(1000);
    writeFileSync(join(here, "DS_Store"), withBounds(readFileSync(join(mount, ".DS_Store"))));
  } finally {
    await $`hdiutil detach -quiet ${mount}`;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
