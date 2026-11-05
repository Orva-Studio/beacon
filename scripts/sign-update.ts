#!/usr/bin/env bun
/**
 * Signs a release's update for the app's check (`packages/desktop/src/bun/update-signature.ts`): the version and
 * Electrobun's hash from the update manifest, and the SHA-256 of the app's tar (the .tar.zst decompressed, as the
 * updater keeps it), with the Ed25519 key in BEACON_UPDATE_KEY (PKCS#8 PEM). Writes the .sig.json beside them.
 *
 *   BEACON_UPDATE_KEY="$(cat key.pem)" bun scripts/sign-update.ts dist
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNATURE_FILE } from "../packages/desktop/src/bun/update-signature";

const dir = process.argv[2];
const key = process.env.BEACON_UPDATE_KEY;
if (!dir || !key) {
  console.error("usage: BEACON_UPDATE_KEY=<PKCS#8 PEM> bun scripts/sign-update.ts <dist>");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dir, "stable-macos-arm64-update.json"), "utf8")) as { version: string; hash: string; artifact: { file: string } };
const tar = Bun.zstdDecompressSync(readFileSync(join(dir, manifest.artifact.file)));
const statement = JSON.stringify({ version: manifest.version, hash: manifest.hash, tarSha256: createHash("sha256").update(tar).digest("hex") });
const signature = sign(null, Buffer.from(statement), createPrivateKey(key)).toString("base64");
writeFileSync(join(dir, SIGNATURE_FILE), JSON.stringify({ statement, signature }));
console.log(`signed ${manifest.version} (${manifest.hash})`);
