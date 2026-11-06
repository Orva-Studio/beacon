import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Beacon signs its own updates, as it isn't signed by Apple yet (the user, 2026-11-05): each release carries
 * `stable-macos-arm64-update.sig.json`, a statement of the version, Electrobun's build hash and the SHA-256 of the
 * app's tar, signed with Ed25519 in CI (`scripts/sign-update.ts`). The app checks it with the public key below before
 * an update runs, and checks the tar it downloaded against it, so only Beacon's own releases install.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3vtyFetoToEZz61p4WzDpUBKP0zAyiITRqVmWHhCxoQ=
-----END PUBLIC KEY-----`;

export const SIGNATURE_FILE = "stable-macos-arm64-update.sig.json";

export interface UpdateStatement {
  version: string;
  hash: string;
  tarSha256: string;
}

/** The statement, when its signature is the key's; otherwise throws, saying why. */
export function signedStatement(file: unknown, publicKey = UPDATE_PUBLIC_KEY): UpdateStatement {
  const f = file as { statement?: unknown; signature?: unknown };
  if (typeof f?.statement !== "string" || typeof f.signature !== "string") throw new Error("the update's signature is missing");
  if (!verify(null, Buffer.from(f.statement), createPublicKey(publicKey), Buffer.from(f.signature, "base64"))) throw new Error("the update isn't signed by Beacon");
  const s = JSON.parse(f.statement) as Partial<UpdateStatement>;
  if (typeof s.version !== "string" || typeof s.hash !== "string" || typeof s.tarSha256 !== "string") throw new Error("the update's signature says too little");
  return s as UpdateStatement;
}

export async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** The release's signed statement for this update, refused unless it is Beacon's and names this version. */
export async function signatureFor(baseUrl: string, version: string, hash: string): Promise<UpdateStatement> {
  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/${SIGNATURE_FILE}?${Date.now()}`);
  if (!res.ok) throw new Error(`the update's signature couldn't be read (${res.status})`);
  const s = signedStatement(await res.json());
  if (s.version !== version || s.hash !== hash) throw new Error("the update's signature is for another version");
  return s;
}

/**
 * The tar Electrobun downloaded and is about to swap in must be the signed one; otherwise it is deleted. Its
 * prepared-update record (in its channel's folder, by identifier then by name for older installs) says where it is.
 */
export async function checkDownload(signed: UpdateStatement) {
  const roots = ["dev.beacon.editor/stable", "dev.beacon.editor/Beacon"].map((r) => join(homedir(), "Library/Application Support", r, "self-extraction"));
  const record = roots.map((r) => join(r, ".electrobun-prepared-update.json")).find((f) => {
    try {
      return JSON.parse(readFileSync(f, "utf8")).hash === signed.hash;
    } catch {
      return false;
    }
  });
  if (!record) throw new Error("the downloaded update couldn't be found to check");
  const tar = (JSON.parse(readFileSync(record, "utf8")) as { retained_tar_path: string }).retained_tar_path;
  if ((await sha256Of(tar)) !== signed.tarSha256) {
    rmSync(record, { force: true });
    rmSync(tar, { force: true });
    throw new Error("the downloaded update isn't the one Beacon signed, so it was deleted");
  }
}
