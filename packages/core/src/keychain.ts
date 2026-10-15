/**
 * Secrets (API keys) in the login Keychain, through macOS's `security` tool: never in a file Beacon writes.
 * Values go to `security` on stdin, so they never appear in a process list.
 */
const SERVICE = "Beacon";

export interface Secrets {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string | null): Promise<void>;
}

async function security(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["/usr/bin/security", ...args], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** `security -i` reads one command per line, with double-quoted arguments. */
const quote = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;

export const keychain: Secrets = {
  async get(id) {
    const r = await security(["find-generic-password", "-s", SERVICE, "-a", id, "-w"]);
    // 44: no such item.
    if (r.code === 44) return undefined;
    if (r.code !== 0) throw new Error(`couldn't read the ${id} from the Keychain: ${r.err.trim()}`);
    return r.out.replace(/\n$/, "") || undefined;
  },
  async set(id, value) {
    if (value === null) {
      const r = await security(["delete-generic-password", "-s", SERVICE, "-a", id]);
      if (r.code !== 0 && r.code !== 44) throw new Error(`couldn't remove the ${id} from the Keychain: ${r.err.trim()}`);
      return;
    }
    if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("a key is printable ASCII on one line");
    const r = await security(["-i"], `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(id)} -l ${quote(`${SERVICE}: ${id}`)} -w ${quote(value)}\n`);
    if (r.code !== 0 || /error/i.test(r.err)) throw new Error(`couldn't save the ${id} in the Keychain: ${r.err.trim()}`);
  },
};
