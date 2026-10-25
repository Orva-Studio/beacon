import type { App } from "./app";

const THUMB_HEIGHT = 64;

/** What the window shows of the project's media besides the document: thumbnails, which files are missing, which have proxies. */
export function createWindowMedia(app: App) {
  const { core, message } = app;

  const thumbs = new Map<string, { shows: string; png: string }>();
  let thumbing = false;
  /** Asked for while a pass was running: its list may miss new clips. */
  let thumbAgain = false;

  /** First-frame thumbnails for clips that lack one, a few at a time, sent as they are made. */
  async function sendThumbs() {
    const current = app.current();
    if (!current) return;
    if (thumbing) return void (thumbAgain = true);
    thumbing = true;
    thumbAgain = false;
    try {
      const h = current.path;
      const doc = core.doc(h);
      // A clip keeps its id when what it shows changes (a B-roll placeholder given its footage, another take picked).
      const todo = [
        ...Object.keys(doc.assets).map((id) => ({ id: `asset:${id}`, shows: "" })),
        ...doc.tracks.flatMap((t) => t.clips.map((c) => ({ id: c.id, shows: `${c.assetId ?? ""}@${c.mediaStart ?? 0}` }))),
      ].filter(({ id, shows }) => thumbs.get(id)?.shows !== shows);
      // A few at a time: each is an ffmpeg decode, and a large project has hundreds.
      for (let i = 0; i < todo.length && app.current()?.path === h; i += 3) {
        const batch: Record<string, string> = {};
        await Promise.all(
          todo.slice(i, i + 3).map(async ({ id, shows }) => {
            const png = await (id.startsWith("asset:") ? core.assetThumbnail(h, id.slice(6), THUMB_HEIGHT * 2) : core.thumbnail(h, id, THUMB_HEIGHT)).catch(() => undefined);
            thumbs.set(id, { shows, png: png?.length ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : "" });
            if (png?.length) batch[id] = thumbs.get(id)!.png;
          }),
        );
        if (Object.keys(batch).length) message("media", { thumbs: batch });
      }
    } finally {
      thumbing = false;
    }
    if (thumbAgain) await sendThumbs();
  }

  /** The missing media last sent, so the check below only sends changes. */
  let lastMissing: string | undefined;
  let checkingMissing: Promise<void> | undefined;
  let recheckMissing = false;
  /**
   * Tells the window which media's files are gone (moved or deleted, even while the project is open). One check
   * at a time, and one more if asked meanwhile: overlapping checks could finish out of order and send a stale list.
   */
  function sendMissing(): Promise<void> {
    if (checkingMissing) {
      recheckMissing = true;
      return checkingMissing;
    }
    checkingMissing = (async () => {
      do {
        recheckMissing = false;
        const path = app.current()?.path;
        if (!path) return;
        const missing = await core.missing(path).catch(() => []);
        const key = missing.join(",");
        if (app.current()?.path !== path || key === lastMissing) continue;
        lastMissing = key;
        message("media", { missing });
      } while (recheckMissing);
    })().finally(() => (checkingMissing = undefined));
    return checkingMissing;
  }
  setInterval(() => void sendMissing(), 3000);

  function sendProxies() {
    const current = app.current();
    if (!current) return;
    const proxies: Record<string, boolean> = {};
    for (const id of Object.keys(core.doc(current.path).assets)) proxies[id] = core.derived(current.path, id, "proxy") !== undefined;
    message("media", { proxies });
  }

  /** Everything again, for a project just shown or a window that (re)loaded. */
  function resend() {
    thumbs.clear();
    lastMissing = undefined;
    sendProxies();
    void sendMissing();
    void sendThumbs();
  }

  /** Thumbnails again, for a window that (re)loaded. */
  function resendThumbs() {
    thumbs.clear();
    void sendThumbs();
  }

  return { sendThumbs, sendMissing, resend, resendThumbs };
}
