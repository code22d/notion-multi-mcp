// -----------------------------------------------------------------------------
// Unit tests for AccountStore.
//
// Exercises the KV-backed store against an in-memory KV mock that honors the
// subset of the KVNamespace interface the store actually calls (get / put /
// delete / list).
//
// The store no longer maintains a cached `accounts` summary key — `list()` is
// always derived from a `name_index:` prefix scan. The regression test at the
// bottom of this file specifically guards against reintroducing a cache: it
// pre-writes a stale `accounts` key and asserts list() ignores it entirely.
// -----------------------------------------------------------------------------

import { AccountStore, __resetLegacyCacheCleanupForTests } from "../src/accounts/store.ts";
import type { NotionAccount } from "../src/mcp/types.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function eq<T>(got: T, want: T, msg: string): void {
  const sg = JSON.stringify(got);
  const sw = JSON.stringify(want);
  if (sg !== sw) {
    console.error(`  ✗ ${msg}\n    got:  ${sg}\n    want: ${sw}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

// -----------------------------------------------------------------------------
// KV mock — in-memory Map with the subset of KVNamespace we touch.
// -----------------------------------------------------------------------------

interface ListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

class MockKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: { prefix?: string; cursor?: string } = {}): Promise<ListResult> {
    const prefix = opts.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

function mkAccount(id: string, name: string): NotionAccount {
  return {
    id,
    name,
    accessToken: `tok-${id}`,
    botId: `bot-${id}`,
    workspaceId: `ws-${id}`,
    workspaceName: `Workspace ${name}`,
    createdAt: 1_700_000_000_000,
  };
}

// Each scenario resets the one-time cleanup latch so the best-effort
// "accounts" key delete is observable per-scenario.
function freshKv(): MockKV {
  __resetLegacyCacheCleanupForTests();
  return new MockKV();
}

// -----------------------------------------------------------------------------
// Scenario 1 — baseline: add two accounts, list returns both
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] baseline put + list");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  await store.put(mkAccount("id-a", "AccountA"));
  await store.put(mkAccount("id-b", "AccountB"));
  const list = await store.list();
  eq(list.length, 2, "list() returns both accounts after two puts");
  const names = list.map((a) => a.name).sort();
  eq(names, ["AccountA", "AccountB"], "list names match");
}

// -----------------------------------------------------------------------------
// Scenario 2 — rename round-trip keeps list intact
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] rename round-trip preserves list count");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  await store.put(mkAccount("id-1", "ReneCEO"));
  await store.put(mkAccount("id-2", "VirtualLatinos"));
  eq((await store.list()).length, 2, "2 accounts before rename");

  await store.rename("id-1", "ReneCEO-test");
  eq((await store.list()).length, 2, "2 accounts after first rename");

  await store.rename("id-1", "ReneCEO");
  const after = await store.list();
  eq(after.length, 2, "2 accounts after rename round-trip");
  const names = after.map((a) => a.name).sort();
  eq(names, ["ReneCEO", "VirtualLatinos"], "names are correct after round-trip");
}

// -----------------------------------------------------------------------------
// Scenario 3 — remove drops entry from list
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] remove");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  await store.put(mkAccount("id-1", "A"));
  await store.put(mkAccount("id-2", "B"));
  await store.remove("id-1");
  const after = await store.list();
  eq(after.length, 1, "1 account after remove");
  eq(after[0]!.id, "id-2", "remaining account is the correct one");
}

// -----------------------------------------------------------------------------
// Scenario 4 — getByName still works after rename
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] getByName after rename");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  await store.put(mkAccount("id-1", "Original"));
  await store.rename("id-1", "Renamed");
  const hit = await store.getByName("Renamed");
  assert(hit !== null, "getByName('Renamed') hits after rename");
  assert(hit?.id === "id-1", "resolves to same id");
  const miss = await store.getByName("Original");
  assert(miss === null, "old name no longer resolves");
}

// -----------------------------------------------------------------------------
// Scenario 5 — NEW Bug 1 regression: stale `accounts` cache key is ignored.
//
// Before the fix, list() returned whatever was in the cached `accounts` key
// and could go stale indefinitely on cold reads. We write an obviously-wrong
// cache ("only one account, and it's not in the index") and assert list()
// ignores it, returning the 2 accounts derived from name_index. We also
// assert the best-effort cleanup removed the stale cache key.
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] Bug 1 regression: stale `accounts` cache is ignored");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  await store.put(mkAccount("id-1", "ReneCEO"));
  await store.put(mkAccount("id-2", "VirtualLatinos"));

  // Simulate a stale cache left over from the old architecture.
  await kv.put(
    "accounts",
    JSON.stringify([
      {
        id: "ghost",
        name: "Ghost",
        workspaceName: "Ghost WS",
        createdAt: 1,
      },
    ])
  );
  assert(kv.has("accounts"), "precondition: stale `accounts` key is present");

  const list = await store.list();
  eq(list.length, 2, "list() returns 2 accounts, not 1 (ignores stale cache)");
  const names = list.map((a) => a.name).sort();
  eq(names, ["ReneCEO", "VirtualLatinos"], "derives names from name_index, not cache");

  // Best-effort cleanup should have fired during list() — give the
  // fire-and-forget delete a microtask turn to settle, then check.
  await Promise.resolve();
  await Promise.resolve();
  assert(!kv.has("accounts"), "best-effort cleanup removed the stale cache key");
}

// -----------------------------------------------------------------------------
// Scenario 6 — list() survives when `accounts` key never existed (fresh KV)
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] list() on a fresh KV (no stale cache)");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  assert(!kv.has("accounts"), "precondition: no cache key in fresh KV");
  eq((await store.list()).length, 0, "empty list on empty KV");
  await store.put(mkAccount("solo", "Solo"));
  eq((await store.list()).length, 1, "1 account after single put");
}

// -----------------------------------------------------------------------------
// Scenario 7 — NEW (V3 fix): put() populates the `accounts_dir` directory.
//
// This key is what list() reads via get() (strongly-consistent within seconds)
// instead of relying on kv.list({prefix: "name_index:"}) which is eventually
// consistent across regions with a window up to 60s. Guards against
// regression if future refactors forget to update the directory on writes.
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] V3: accounts_dir is maintained on writes");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);
  await store.put(mkAccount("id-a", "A"));
  await store.put(mkAccount("id-b", "B"));

  const dirRaw = await kv.get("accounts_dir");
  assert(dirRaw !== null, "accounts_dir key exists after puts");
  const dir = JSON.parse(dirRaw!) as string[];
  eq(dir.sort(), ["id-a", "id-b"], "accounts_dir contains both ids");

  await store.remove("id-a");
  const dirRaw2 = await kv.get("accounts_dir");
  const dir2 = JSON.parse(dirRaw2!) as string[];
  eq(dir2, ["id-b"], "remove() drops the id from accounts_dir");
}

// -----------------------------------------------------------------------------
// Scenario 8 — V3 self-heal: list() rebuilds accounts_dir when missing.
//
// Simulates migration from V2 (no accounts_dir) to V3 — workers previously
// deployed without accounts_dir should transparently self-heal on the first
// list() call, populating the directory for subsequent reads.
// -----------------------------------------------------------------------------

console.log("\n[AccountStore] V3 self-heal: list() populates accounts_dir when missing");
{
  const kv = freshKv();
  const store = new AccountStore(kv as unknown as KVNamespace);

  // Seed the KV as a V2-era store would: name_index and account keys present,
  // no accounts_dir.
  await kv.put("account:id-x", JSON.stringify(mkAccount("id-x", "X")));
  await kv.put("name_index:x", "id-x");
  await kv.put("account:id-y", JSON.stringify(mkAccount("id-y", "Y")));
  await kv.put("name_index:y", "id-y");
  assert(!kv.has("accounts_dir"), "precondition: accounts_dir missing (V2-era state)");

  const firstList = await store.list();
  eq(firstList.length, 2, "first list() call returns 2 via scan fallback");

  // Give the fire-and-forget putDir a microtask turn to complete.
  await Promise.resolve();
  await Promise.resolve();
  assert(kv.has("accounts_dir"), "accounts_dir was populated by self-heal");
  const dir = JSON.parse((await kv.get("accounts_dir"))!) as string[];
  eq(dir.sort(), ["id-x", "id-y"], "self-healed accounts_dir has both ids");

  // A subsequent list() should still work, now reading the directory path.
  const secondList = await store.list();
  eq(secondList.length, 2, "second list() still returns 2 (via directory)");
}

// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
