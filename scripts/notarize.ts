#!/usr/bin/env bun
/**
 * Signs a release DMG with the Developer ID, has Apple notarize it and staples the ticket, so macOS opens it without
 * a warning (the release workflow, once the Developer ID secrets are set: docs/security.md, "Developer ID").
 * Needs BEACON_SIGN_IDENTITY and an App Store Connect API key: APPLE_API_KEY (the .p8's text), APPLE_API_KEY_ID,
 * APPLE_API_ISSUER.
 *
 *   bun scripts/notarize.ts dist/beacon-macos-arm64.dmg
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { IDENTITY, signDmg } from "../packages/desktop/sign";

const dmg = process.argv[2];
const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
if (!dmg) throw new Error("usage: bun scripts/notarize.ts <dmg>");
if (IDENTITY === "-") throw new Error("BEACON_SIGN_IDENTITY isn't set: notarizing needs the Developer ID");
if (!key || !keyId || !issuer) throw new Error("notarizing needs APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER");

const dir = mkdtempSync(join(tmpdir(), "beacon-notarize-"));
try {
  await signDmg(dmg);
  const p8 = join(dir, `AuthKey_${keyId}.p8`);
  writeFileSync(p8, key.includes("BEGIN PRIVATE KEY") ? key : Buffer.from(key, "base64").toString("utf8"), { mode: 0o600 });
  console.log(`submitting ${dmg} (this waits for Apple, usually a few minutes)`);
  const out = await $`xcrun notarytool submit ${dmg} --key ${p8} --key-id ${keyId} --issuer ${issuer} --wait --output-format json`.nothrow().quiet();
  const result = JSON.parse(out.stdout.toString() || "{}") as { id?: string; status?: string; message?: string };
  if (result.status !== "Accepted") {
    // Apple's log says which file and why (unsigned code, no hardened runtime, no timestamp…).
    if (result.id) console.error((await $`xcrun notarytool log ${result.id} --key ${p8} --key-id ${keyId} --issuer ${issuer}`.nothrow().quiet()).stdout.toString());
    throw new Error(`notarization ${result.status ?? "failed"}: ${result.message ?? out.stderr.toString()}`);
  }
  await $`xcrun stapler staple ${dmg}`.quiet();
  await $`xcrun stapler validate ${dmg}`.quiet();
  await $`spctl --assess --type open --context context:primary-signature ${dmg}`.quiet();
  console.log(`✓ notarized (${result.id}), stapled and accepted by Gatekeeper`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
