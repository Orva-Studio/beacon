// How Beacon's apps are signed (build-hook.ts): ad hoc, or with the Developer ID in BEACON_SIGN_IDENTITY ("Developer
// ID Application: Name (TEAMID)", from the keychain CI imports it into), with the hardened runtime notarization needs.
// BEACON_HARDENED=1 turns the hardened runtime on for an ad hoc build, to try the app under it before there is an ID.
import { openSync, readSync, closeSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { $ } from "bun";

export const IDENTITY = process.env.BEACON_SIGN_IDENTITY || "-";
export const HARDENED = IDENTITY !== "-" || process.env.BEACON_HARDENED === "1";

/** Bun's JavaScriptCore compiles as it runs: the main process and the compiled beacon-mcp. */
const JIT = ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"];
/** The hardened runtime blocks the camera and microphone unless entitled; whoever records or asks for them is. */
const DEVICES = ["com.apple.security.device.camera", "com.apple.security.device.audio-input"];

/** Each executable's entitlements by its file name; anything else gets none. */
export function entitlementsOf(file: string): string[] {
  const name = basename(file);
  // Entitlements are the process's: a library's would be ignored.
  if (/\.(dylib|so)$/.test(name)) return [];
  // An ad hoc signature has no Team ID, so library validation would refuse the app's own ad hoc libraries.
  const adhoc = IDENTITY === "-" ? ["com.apple.security.cs.disable-library-validation"] : [];
  if (name === "bun") return [...JIT, ...DEVICES, ...adhoc];
  if (name === "beacon-mcp") return [...JIT, ...adhoc];
  if (name === "launcher" || name === "beacon-recorder") return [...DEVICES, ...adhoc];
  return adhoc;
}

function plist(keys: string[]): string {
  const body = keys.map((k) => `\t<key>${k}</key>\n\t<true/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

const MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(4);
    return readSync(fd, b, 0, 4, 0) === 4 && MAGIC.has(b.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

/** Every Mach-O file inside `dir`, deepest first, nested bundles' own contents before the bundles. */
export function machOs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...machOs(p));
    else if (e.isFile() && statSync(p).size > 4 && isMachO(p)) out.push(p);
  }
  return out;
}

async function signOne(path: string, keys: string[], work: string) {
  const runtime = HARDENED ? ["--options", "runtime"] : [];
  const timestamp = IDENTITY === "-" ? ["--timestamp=none"] : ["--timestamp"];
  let ents: string[] = [];
  if (HARDENED && keys.length) {
    const file = join(work, `${basename(path)}.entitlements`);
    writeFileSync(file, plist(keys));
    ents = ["--entitlements", file];
  }
  await $`codesign --force ${runtime} ${timestamp} ${ents} --sign ${IDENTITY} ${path}`.quiet();
}

/**
 * Signs an app inside out, as notarization wants (no `--deep`): its libraries, then its helpers, then the bundle
 * with its main executable's entitlements.
 */
export async function signApp(app: string) {
  const work = mkdtempSync(join(tmpdir(), "beacon-entitlements-"));
  try {
    const main = join(app, "Contents/MacOS", (await $`plutil -extract CFBundleExecutable raw ${join(app, "Contents/Info.plist")}`.quiet().text()).trim());
    const inner = machOs(app).filter((f) => f !== main);
    const libs = inner.filter((f) => f.endsWith(".dylib") || f.endsWith(".so"));
    for (const f of [...libs, ...inner.filter((f) => !libs.includes(f))]) await signOne(f, entitlementsOf(f), work);
    await signOne(app, entitlementsOf(main), work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A disk image is signed as a whole, without the runtime (it runs nothing). */
export async function signDmg(dmg: string) {
  await $`codesign --force ${IDENTITY === "-" ? ["--timestamp=none"] : ["--timestamp"]} --sign ${IDENTITY} ${dmg}`.quiet();
}
