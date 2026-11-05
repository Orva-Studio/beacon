import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Of, SIGNATURE_FILE, signedStatement } from "../src/bun/update-signature";

test("a release signed in CI is the app's to install, its tar checked; a changed statement or another key is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beacon-sign-"));
  const tar = new TextEncoder().encode("the app's tar ".repeat(1000));
  writeFileSync(join(dir, "stable-macos-arm64-Beacon.app.tar.zst"), Bun.zstdCompressSync(tar));
  writeFileSync(join(dir, "stable-macos-arm64-update.json"), JSON.stringify({ version: "9.9.9", hash: "abc123", artifact: { file: "stable-macos-arm64-Beacon.app.tar.zst" } }));
  const key = () => generateKeyPairSync("ed25519");
  const { publicKey, privateKey } = key();
  const pem = (k: typeof publicKey) => k.export({ type: k.type === "public" ? "spki" : "pkcs8", format: "pem" }) as string;
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "../../../scripts/sign-update.ts"), dir], { env: { ...process.env, BEACON_UPDATE_KEY: pem(privateKey) }, stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);

  const file = JSON.parse(readFileSync(join(dir, SIGNATURE_FILE), "utf8"));
  const s = signedStatement(file, pem(publicKey));
  expect(s).toMatchObject({ version: "9.9.9", hash: "abc123" });
  writeFileSync(join(dir, "app.tar"), tar);
  expect(await sha256Of(join(dir, "app.tar"))).toBe(s.tarSha256);

  expect(() => signedStatement({ ...file, statement: file.statement.replace("9.9.9", "9.9.8") }, pem(publicKey))).toThrow("isn't signed by Beacon");
  expect(() => signedStatement(file, pem(key().publicKey))).toThrow("isn't signed by Beacon");
  expect(() => signedStatement({}, pem(publicKey))).toThrow("signature is missing");
});
