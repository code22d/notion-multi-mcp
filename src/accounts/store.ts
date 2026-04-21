// -----------------------------------------------------------------------------
// KV-backed account store.
//
// KV layout:
//   account:{id}            → NotionAccount JSON (source of truth for account data)
//   name_index:{lc_name}    → id (lowercased-name uniqueness index + name lookup)
//   accounts_dir            → JSON array of all account ids (strongly-consistent
//                              directory used by list(); self-heals from
//                              name_index: scan if missing/empty)
//
// History:
//   - V1 maintained an `accounts` key caching the full pre-built summary list.
//     That cache went stale across deploys and was a known source of under-reports.
//   - V2 removed the cache entirely; list() derived from a `name_index:` prefix
//     scan. Cleaner code but exposed a Cloudflare KV characteristic: list()
//     operations are eventually consistent across regions with a window up to
//     60 seconds. Cold reads shortly after an add/rename would under-report.
//   - V3 (this file) uses `accounts_dir` — a single strongly-consistent key
//     read via get() — as the directory. get() has a much smaller consistency
//     window (seconds) than list() (up to 60s), so cold reads converge fast.
//     When accounts_dir is missing (first deploy of this code, or legitimately
//     empty), list() self-heals by scanning name_index: and populating the
//     directory for future reads. Writes (put/remove) keep the directory in
//     sync; rename() doesn't need to touch it since the id is stable.
// -----------------------------------------------------------------------------

import type { AccountSummary, NotionAccount } from "../mcp/types";

// One-time best-effort cleanup of the legacy cache key. We attempt the delete
// on the first list() call per isolate — if the KV key never existed, the call
// is a no-op; if it did, we tidy up. Either way this is fire-and-forget and
// never blocks the main path.
let legacyCacheCleanupAttempted = false;

export class AccountStore {
  constructor(private kv: KVNamespace) {}

  // -------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------

  async getById(id: string): Promise<NotionAccount | null> {
    const raw = await this.kv.get(`account:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as NotionAccount;
  }

  async getByName(name: string): Promise<NotionAccount | null> {
    const lc = normalizeName(name);
    const id = await this.kv.get(`name_index:${lc}`);
    if (!id) return null;
    return this.getById(id);
  }

  /**
   * Resolve an account by either name or id. Tries id first, falls back to name.
   * Useful for the per-tool `account` parameter that accepts either.
   */
  async resolve(nameOrId: string): Promise<NotionAccount | null> {
    if (!nameOrId) return null;
    // A Notion/generated UUID won't collide with a name unless the user literally named
    // their account with a UUID. We check id first because that's the canonical form.
    const byId = await this.getById(nameOrId);
    if (byId) return byId;
    return this.getByName(nameOrId);
  }

  /**
   * Enumerate all accounts. Primary path reads the strongly-consistent
   * `accounts_dir` directory via get(). If that's missing or empty, falls back
   * to scanning name_index: (to self-heal during the first call after deploy
   * of this version, or to recover from an inconsistent state) and populates
   * accounts_dir for the next call.
   */
  async list(): Promise<AccountSummary[]> {
    // Fire-and-forget tidy-up of the legacy `accounts` cache key. Safe if absent.
    if (!legacyCacheCleanupAttempted) {
      legacyCacheCleanupAttempted = true;
      this.kv.delete("accounts").catch(() => {
        /* ignore — best-effort cleanup */
      });
    }

    let ids = await this.getDir();

    // Self-heal: directory missing or empty — scan name_index: and rebuild.
    // This runs once per deploy of this code (or after an unusual state),
    // then every subsequent call hits the fast directory path.
    if (ids.length === 0) {
      const scanned = new Set<string>();
      let cursor: string | undefined;
      do {
        const res = await this.kv.list({ prefix: "name_index:", cursor });
        for (const k of res.keys) {
          const id = await this.kv.get(k.name);
          if (id) scanned.add(id);
        }
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);

      if (scanned.size > 0) {
        ids = Array.from(scanned);
        // Best-effort populate the directory for next read. Don't block.
        this.putDir(ids).catch(() => {
          /* ignore — next list() will retry self-heal */
        });
      }
    }

    const summaries: AccountSummary[] = [];
    for (const id of ids) {
      const acct = await this.getById(id);
      if (acct) summaries.push(toSummary(acct));
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return summaries;
  }

  // -------------------------------------------------------------------
  // Directory helpers (accounts_dir key — strongly-consistent enumeration)
  // -------------------------------------------------------------------

  private async getDir(): Promise<string[]> {
    const raw = await this.kv.get("accounts_dir");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  private async putDir(ids: string[]): Promise<void> {
    // Dedupe while preserving insertion order.
    const unique = Array.from(new Set(ids));
    await this.kv.put("accounts_dir", JSON.stringify(unique));
  }

  // -------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------

  /** Adds or replaces an account. Enforces unique name. */
  async put(account: NotionAccount, options: { allowOverwriteName?: boolean } = {}): Promise<void> {
    const lc = normalizeName(account.name);

    // Check name collision
    const existingId = await this.kv.get(`name_index:${lc}`);
    if (existingId && existingId !== account.id && !options.allowOverwriteName) {
      throw new Error(
        `An account named "${account.name}" already exists (id ${existingId}). Use notion_account_rename or pick a different name.`
      );
    }

    await this.kv.put(`account:${account.id}`, JSON.stringify(account));
    await this.kv.put(`name_index:${lc}`, account.id);

    // Maintain the strongly-consistent directory so list() sees this account
    // on its next call without waiting on list() consistency convergence.
    const dir = await this.getDir();
    if (!dir.includes(account.id)) {
      dir.push(account.id);
      await this.putDir(dir);
    }
  }

  async rename(id: string, newName: string): Promise<NotionAccount> {
    const account = await this.getById(id);
    if (!account) throw new Error(`No account with id ${id}`);
    const oldLc = normalizeName(account.name);
    const newLc = normalizeName(newName);

    if (oldLc !== newLc) {
      const existingId = await this.kv.get(`name_index:${newLc}`);
      if (existingId && existingId !== id) {
        throw new Error(`The name "${newName}" is already used by account ${existingId}.`);
      }
      await this.kv.delete(`name_index:${oldLc}`);
      await this.kv.put(`name_index:${newLc}`, id);
    }
    const updated: NotionAccount = { ...account, name: newName };
    await this.kv.put(`account:${id}`, JSON.stringify(updated));
    return updated;
  }

  async remove(id: string): Promise<NotionAccount | null> {
    const account = await this.getById(id);
    if (!account) return null;
    await this.kv.delete(`account:${id}`);
    await this.kv.delete(`name_index:${normalizeName(account.name)}`);

    // Drop from directory so list() stops returning it immediately.
    const dir = await this.getDir();
    const filtered = dir.filter((dirId) => dirId !== id);
    if (filtered.length !== dir.length) {
      await this.putDir(filtered);
    }
    return account;
  }
}

function toSummary(account: NotionAccount): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    workspaceName: account.workspaceName,
    createdAt: account.createdAt,
  };
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Test hook: reset the one-time legacy-cache cleanup latch so unit tests can
 * observe the `kv.delete("accounts")` call consistently. Not part of the public
 * runtime contract — production code has no reason to reset.
 */
export function __resetLegacyCacheCleanupForTests(): void {
  legacyCacheCleanupAttempted = false;
}
