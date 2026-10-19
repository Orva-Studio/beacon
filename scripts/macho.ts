// What a Mach-O binary loads (otool -L), for the build, bundle and release checks.
import { $ } from "bun";

/** The libraries `file` loads, by the paths it names them. */
export async function linked(file: string): Promise<string[]> {
  const lines = (await $`otool -L ${file}`.quiet().text()).split("\n").slice(1);
  return lines.map((l) => l.trim().split(" ")[0]!).filter(Boolean);
}

/** What `file` loads from outside macOS and what `ours` allows: a Mac without them couldn't run it. */
export async function foreignLinks(file: string, ours: (lib: string) => boolean): Promise<string[]> {
  return (await linked(file)).filter((l) => !l.startsWith("/System/") && !l.startsWith("/usr/lib/") && !ours(l));
}
