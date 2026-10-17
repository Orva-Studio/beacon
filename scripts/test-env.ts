import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never the user's preferences, settings or keys (~/Library/Application Support/Beacon): a test that reads them
// would depend on this Mac, and one that snapshots would write into the user's chosen folder.
process.env.BEACON_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "beacon-test-config-"));
