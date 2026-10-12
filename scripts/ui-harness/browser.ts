import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Playwright's headless Chromium shell: renders without a window. */
function headlessShell(): string {
  const root = join(homedir(), "Library/Caches/ms-playwright");
  const dir = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().at(-1);
  if (!dir) throw new Error(`no chromium_headless_shell in ${root}; run \`bunx playwright install chromium-headless-shell\``);
  const sub = readdirSync(join(root, dir)).find((d) => d.startsWith("chrome-headless-shell"))!;
  return join(root, dir, sub, "chrome-headless-shell");
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
type Mods = (keyof typeof MOD)[];
const bits = (mods: Mods = []) => mods.reduce((n, m) => n | MOD[m], 0);

/** A headless page driven over the DevTools protocol: mouse, keys, screenshots, script. */
export async function openPage(url: string, size = { width: 1600, height: 1000 }) {
  const proc = Bun.spawn([headlessShell(), "--remote-debugging-port=0", `--window-size=${size.width},${size.height}`, "--hide-scrollbars", "about:blank"], { stderr: "pipe", stdout: "ignore" });
  const reader = proc.stderr.getReader();
  let log = "";
  let browserWs = "";
  while (!browserWs) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`chromium exited:\n${log}`);
    log += new TextDecoder().decode(value);
    browserWs = log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? "";
  }
  const port = new URL(browserWs).port;
  const page = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page")!;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    const w = msg.id && waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message));
    else w.resolve(msg.result);
  };
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url });

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  };
  const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number, mods?: Mods, button: "left" | "right" = "left") =>
    send("Input.dispatchMouseEvent", { type, x, y, button, buttons: type === "mouseReleased" ? 0 : button === "left" ? 1 : 2, clickCount: 1, modifiers: bits(mods) });

  return {
    evaluate,
    /** Waits until `expression` is truthy. */
    async until(expression: string, timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expression).catch(() => false)) return;
        await Bun.sleep(30);
      }
      throw new Error(`timed out waiting for ${expression}`);
    },
    down: (x: number, y: number, mods?: Mods) => mouse("mousePressed", x, y, mods),
    move: (x: number, y: number, mods?: Mods) => mouse("mouseMoved", x, y, mods),
    up: (x: number, y: number, mods?: Mods) => mouse("mouseReleased", x, y, mods),
    async click(x: number, y: number, mods?: Mods) {
      await mouse("mouseMoved", x, y, mods);
      await mouse("mousePressed", x, y, mods);
      await mouse("mouseReleased", x, y, mods);
    },
    /** Files dragged in from outside the page (Finder) and dropped at a point. */
    async dropFiles(x: number, y: number, files: string[]) {
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"] as const) await send("Input.dispatchDragEvent", { type, x, y, data });
    },
    /** A right-click (the page's contextmenu event). */
    async rightClick(x: number, y: number) {
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, undefined, "right");
      await mouse("mouseReleased", x, y, undefined, "right");
    },
    async drag(from: [number, number], to: [number, number], mods?: Mods, steps = 12) {
      await mouse("mouseMoved", from[0], from[1], mods);
      await mouse("mousePressed", from[0], from[1], mods);
      for (let i = 1; i <= steps; i++) {
        await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, mods);
        await Bun.sleep(16);
      }
      await mouse("mouseReleased", to[0], to[1], mods);
    },
    /** `key` as KeyboardEvent.key, `code` as KeyboardEvent.code; `commands` are editing commands the key runs ("copy", "paste"), as the OS menu would. */
    async key(key: string, code: string, mods?: Mods, commands?: string[]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers: bits(mods), ...(commands ? { commands } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: bits(mods) });
    },
    /** Chromium's performance counters (ScriptDuration, TaskDuration, LayoutDuration… in seconds), for comparing the cost of a run. */
    async metrics(): Promise<Record<string, number>> {
      await send("Performance.enable");
      const r = await send("Performance.getMetrics");
      return Object.fromEntries((r.metrics as { name: string; value: number }[]).map((m) => [m.name, m.value]));
    },
    async screenshot(path: string, clip?: { x: number; y: number; width: number; height: number }) {
      const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      await Bun.write(path, Buffer.from(r.data, "base64"));
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
}
