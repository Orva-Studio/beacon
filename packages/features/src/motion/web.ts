import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { jobSignal } from "@beacon/media";

const api = () => process.env.BEACON_FIRECRAWL_URL ?? "https://api.firecrawl.dev";
/** Bigger isn't inlined into the page: it would bloat the project, which keeps each take's page. */
const MAX_IMAGE = 1_500_000;
/** An SVG this small is shown to the author too, so it can restyle or animate its paths. */
const SHOWN_SVG = 20_000;
const ROUNDS = 8;
const REDIRECTS = 5;

/** IPv4 and IPv6 ranges that aren't the public internet: this Mac, the local network, link-local, multicast. */
function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/** The stand-ins tests run in place of the services, on this Mac: theirs are the only local addresses fetched. */
const standIns = () =>
  new Set(
    [process.env.BEACON_FIRECRAWL_URL, process.env.BEACON_OPENAI_URL, process.env.BEACON_ANTHROPIC_URL].flatMap((u) => {
      try {
        return u ? [new URL(u).host] : [];
      } catch {
        return [];
      }
    }),
  );

/** Refused unless it's http(s) on the public internet: a model asked by a web page could name this Mac or the local network. */
async function publicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`not a web address: ${url.href}`);
  if (standIns().has(url.host)) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error(`${url.hostname} isn't on the public internet`);
}

/** At most `max` bytes of a response, stopping the download as soon as it's over. */
async function capped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error(`the image is too big (over ${Math.round(max / 1000)} KB)`);
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error(`the image is too big (over ${Math.round(max / 1000)} KB)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A tool the author may call while it writes, described as both OpenAI and Claude take it. */
export interface Tool {
  name: string;
  description: string;
  parameters: { type: "object"; additionalProperties: false; required: string[]; properties: Record<string, object> };
}

export const TOOLS: Tool[] = [
  {
    name: "web_search",
    description: "Search the web. Returns pages (title, url, an excerpt with any image links on them) and, when `images` is true, images (title, imageUrl). Use it to find a logo, an icon or a picture the brief asks for, or a fact it needs.",
    parameters: { type: "object", additionalProperties: false, required: ["query", "images"], properties: { query: { type: "string" }, images: { type: "boolean" } } },
  },
  {
    name: "brand",
    description: "A website's brand: its name, logo (downloaded, as an asset), colours and fonts, read from its home page. Use it when the brief names a real company, product or site, to get its real logo and colours rather than drawing a lookalike.",
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", description: "The site, e.g. https://firecrawl.dev" } } },
  },
  {
    name: "image",
    description: "Download an image (SVG, PNG, JPEG, WebP or GIF, up to 1.5 MB) from a URL, as an asset for the page. Prefer SVG for logos and icons.",
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" } } },
  },
];

export const WEB_GUIDE = [
  "You have the web through tools: web_search, brand (a site's real logo, colours and fonts) and image (download a picture). Use them when the brief names a real brand, product, logo, icon or a place to get one from; don't when it needs nothing from the web.",
  'The page itself is offline: never point at a URL. A downloaded image is an asset: use it as src="asset:ID" on an <img>, href="asset:ID" on an SVG <image>, or url(asset:ID) in CSS, with the ID the tool gave. An SVG asset shown to you can also be pasted into the page as inline SVG, to colour or animate its parts.',
].join("\n\n");

/** The web for one composition: Firecrawl (keyless, or with the user's key) and the images downloaded for the page. */
export class Web {
  readonly assets = new Map<string, string>();
  /** Calls made, for the progress line. */
  calls = 0;
  constructor(
    private key: string | undefined,
    private progress?: (stage: string) => void,
  ) {}

  async #firecrawl(path: string, body: object): Promise<Record<string, unknown>> {
    const res = await fetch(`${api()}/v2/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(jobSignal() ? [jobSignal()!] : [])]),
    });
    if (res.status === 401) throw new Error("Firecrawl refused the API key: check it in Settings › AI, or remove it to search keyless");
    if (res.status === 402 || res.status === 429) throw new Error(`Firecrawl's ${this.key ? "credits or rate limit" : "keyless allowance"} ran out (${res.status})${this.key ? "" : ": add a free Firecrawl key in Settings › AI for more"}`);
    if (!res.ok) throw new Error(`Firecrawl couldn't answer (${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)})`);
    return ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
  }

  /** Downloads an image as an asset: its ID and, for a small SVG, its markup. */
  async #image(url: string, name: string): Promise<{ asset: string; type: string; svg?: string }> {
    let mime: string;
    let bytes: Buffer;
    const inline = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (inline) {
      mime = inline[1]!;
      bytes = inline[2] ? Buffer.from(inline[3]!, "base64") : Buffer.from(decodeURIComponent(inline[3]!));
    } else {
      const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(jobSignal() ? [jobSignal()!] : [])]);
      // Each redirect is checked as the first address is.
      let at: URL;
      try {
        at = new URL(url);
      } catch {
        throw new Error(`not a web address: ${url}`);
      }
      let res: Response;
      for (let hops = 0; ; hops++) {
        await publicUrl(at);
        res = await fetch(at, { signal, redirect: "manual" });
        const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!next) break;
        if (hops >= REDIRECTS) throw new Error("the image redirected too many times");
        await res.body?.cancel();
        at = new URL(next, at);
      }
      if (!res.ok) throw new Error(`the image didn't download (${res.status})`);
      bytes = await capped(res, MAX_IMAGE);
      mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
      // Served as something else, it's an SVG only if it reads as one: never text relabelled by its name.
      if (!mime.startsWith("image/") && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 4096).toString())) mime = "image/svg+xml";
    }
    if (!/^image\/(svg\+xml|png|jpeg|webp|gif)$/.test(mime)) throw new Error(`not an image Beacon can use (${mime || "unknown type"})`);
    if (bytes.length > MAX_IMAGE) throw new Error(`the image is too big (${Math.round(bytes.length / 1000)} KB, up to 1500 KB)`);
    const asset = `${name}-${this.assets.size + 1}`;
    this.assets.set(asset, `data:${mime};base64,${bytes.toString("base64")}`);
    const svg = mime === "image/svg+xml" && bytes.length <= SHOWN_SVG ? bytes.toString("utf8") : undefined;
    return { asset, type: mime, ...(svg ? { svg } : {}) };
  }

  /** Runs one tool call; what it answers is the author's to read (an error too, so it can try something else). */
  async run(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls++;
    try {
      switch (name) {
        case "web_search": {
          this.progress?.(`Searching the web: ${String(args.query).slice(0, 60)}`);
          const data = await this.#firecrawl("search", { query: String(args.query), limit: 5, sources: args.images ? ["web", "images"] : ["web"] });
          const web = ((data.web as Record<string, unknown>[] | undefined) ?? []).map((r) => ({ title: r.title, url: r.url, excerpt: String(r.description ?? "").slice(0, 1200) }));
          const images = ((data.images as Record<string, unknown>[] | undefined) ?? []).slice(0, 8).map((r) => ({ title: r.title, imageUrl: r.imageUrl, page: r.url }));
          return JSON.stringify({ web, ...(images.length ? { images } : {}) });
        }
        case "brand": {
          this.progress?.(`Looking up ${String(args.url).replace(/^https?:\/\//, "").slice(0, 60)}'s brand`);
          const data = await this.#firecrawl("scrape", { url: String(args.url), formats: ["branding"] });
          const b = (data.branding ?? {}) as Record<string, unknown>;
          const images = (b.images ?? {}) as Record<string, string | undefined>;
          const logoUrl = (typeof b.logo === "string" ? b.logo : undefined) ?? images.logo;
          let logo: object | string = "none found";
          if (logoUrl) logo = await this.#image(logoUrl, "logo").catch((e: unknown) => `found but not downloaded: ${e instanceof Error ? e.message : e}`);
          const typography = b.typography as { fontFamilies?: object } | undefined;
          return JSON.stringify({ brandName: b.brandName, colorScheme: b.colorScheme, colors: b.colors, fonts: b.fonts, fontFamilies: typography?.fontFamilies, logo, ...(images.favicon ? { favicon: images.favicon } : {}) });
        }
        case "image":
          this.progress?.("Downloading an image");
          return JSON.stringify(await this.#image(String(args.url), "image"));
        default:
          return `no tool "${name}"`;
      }
    } catch (e) {
      jobSignal()?.throwIfAborted();
      // Firecrawl's own refusals stop the make: the author can't do anything about them.
      if (e instanceof Error && /^Firecrawl (refused|'s)/.test(e.message)) throw e;
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Whether another round of tools is allowed; past it the author must answer. */
  more(round: number): boolean {
    return round < ROUNDS;
  }

  /** The page with each image it holds (a long data: URL) swapped for an asset id, to send it to the author without them. */
  keep(html: string): string {
    return html.replace(/data:[a-z]+\/[a-z0-9.+-]+(;[a-z0-9=.+-]+)*,[^"'()<>\s]{200,}/gi, (data) => {
      const asset = `kept-${this.assets.size + 1}`;
      this.assets.set(asset, data);
      return `asset:${asset}`;
    });
  }

  /** The page with each asset it uses put in as its data. */
  resolve(html: string): string {
    return html.replace(/asset:([A-Za-z]+-\d+)/g, (whole, id: string) => this.assets.get(id) ?? whole);
  }
}
