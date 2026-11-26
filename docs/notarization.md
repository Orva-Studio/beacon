# Signing and notarizing Beacon

Beacon is ad-hoc signed today, so macOS drops Screen Recording permission after every update and warns about an
unidentified developer. A Developer ID signature and Apple's notarization fix both. The release workflow already
does both (`.github/workflows/release.yml`, `scripts/notarize.ts`) with five secrets; without them it signs ad hoc
and skips notarizing. **Done: v0.22.1 (2026-11-26) is signed and notarized.**

## Where it stands (2026-11-17)

- [x] Apple Developer Program: Orva Studio Limited, Team ID `LLZT7475J6` (approved and paid 2026-11-12).
- [x] Certificate signing request made in Keychain Access: the "Orva Studio Limited" public and private key pair is
  in the login keychain. Two unnamed `<key>` pairs above it are likely from an earlier attempt; leave them until the
  certificate is installed and paired, then delete whichever is unused.
- [x] Developer ID Application certificate (valid to 2027-12-26; Apple's Developer ID G2 intermediate was missing
  from the login keychain, so the certificate showed as not valid until it was added from apple.com).
- [x] `.p12` export. Keychain Access writes RC2-encrypted `.p12`s, which OpenSSL 3 won't open without `-legacy`;
  the runner's `security import` reads them.
- [x] App Store Connect API key (Team key, Developer role, Key ID `GFVHGM2PYF`): the App Store Connect API needed
  **Request Access** once before Team Keys appeared.
- [x] The five GitHub secrets. Set the password by typing it at `gh secret set`'s prompt; piping `pbpaste` set
  whatever was on the clipboard (the first run failed on the password, the second on the Issuer ID).
- [x] A signed, notarized release: v0.22.1. Apple took about 35 minutes over the team's first submission. Checked:
  `spctl` says "Notarized Developer ID" for the DMG and Beacon.app, the ticket is stapled. Still to see: Screen
  Recording permission kept across the next update.

## Next steps

1. **Certificate.** developer.apple.com › Certificates, IDs & Profiles › Certificates › **+** › **Developer ID
   Application** (G2 Sub-CA). Upload the `.certSigningRequest` saved with the key pair above. Download the `.cer`.
   Only the Account Holder can make one.
2. **Install it.** Double-click the `.cer`. Keychain Access › My Certificates should show "Developer ID Application:
   Orva Studio Limited (LLZT7475J6)" with a ▸ that opens to its private key. No private key under it means the
   `.cer` came from a different request.
3. **Export a `.p12`.** Right-click the certificate › Export… › `.p12`, with a password (e.g.
   `~/Desktop/developer-id.p12`).
4. **API key.** appstoreconnect.apple.com › Users and Access › Integrations › **Team Keys** › **+**, role
   Developer. Download the `.p8` (once only); note its Key ID and the Issuer ID above the list.
5. **Secrets** (from the beacon folder; nothing is printed):
   ```
   base64 -i ~/Desktop/developer-id.p12 | gh secret set BEACON_DEVELOPER_ID_P12
   gh secret set BEACON_DEVELOPER_ID_PASSWORD          # prompts for the .p12's password
   gh secret set APPLE_API_KEY < ~/Downloads/AuthKey_XXXX.p8
   gh secret set APPLE_API_KEY_ID --body XXXX
   gh secret set APPLE_API_ISSUER --body <issuer-id>
   ```
   `gh secret list` should then show these five beside `BEACON_UPDATE_KEY`.
6. **Release.** `bun run release 0.21.1` from a clean main. The workflow imports the certificate into a keychain of
   its own, signs with it, notarizes the DMG and staples the ticket. Then check: the downloaded DMG opens without a
   warning (`spctl -a -vv -t install Beacon.app` says "Notarized Developer ID"), and Screen Recording permission
   survives the next update.
