// -----------------------------------------------------------------------------
// KV-backed account store.
//
// KV layout:
//   account:{id}            → NotionAccount JSON
//   name_index:{lc_name}    → id (lowercased-name uniqueness index for fast lookup)
//   accounts                → array of AccountSummary (cached list; rebuilt on every mutation)
//
// Keeping a pre-built `accounts` list means `notion_account_list` is O(1) and
// doesn't need a KV prefix scan. We pay the cost on writes instead, which are rare.
// -----------------------------------------------------------------------------

import type { AccountSummary, NotionAccount } from "../mcp/types";

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

  async list(): Promise<AccountSummary[]> {
    const raw = await this.kv.get("accounts");
    if (!raw) return [];
    try {
      return JSON.parse(raw) as AccountSummary[];
    } catch {
      return [];
    }
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
    await this.rebuildList();
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
    await this.rebuildList();
    return updated;
  }

  async remove(id: string): Promise<NotionAccount | null> {
    const account = await this.getById(id);
    if (!account) return null;
    await this.kv.delete(`account:${id}`);
    await this.kv.delete(`name_index:${normalizeName(account.name)}`);
    await this.rebuildList();
    return account;
  }

  // -------------------------------------------------------------------
  // Internal — rebuild cached summary list from the id index.
  // -------------------------------------------------------------------

  private async rebuildList(): Promise<void> {
    // Walk all name_index keys to gather the authoritative set of accounts.
    // Small scale (expected <50 accounts) so a simple scan is fine.
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.kv.list({ prefix: "name_index:", cursor });
      for (const k of res.keys) {
        const id = await this.kv.get(k.name);
        if (id) ids.push(id);
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);

    const summaries: AccountSummary[] = [];
    for (const id of ids) {
      const acct = await this.getById(id);
      if (acct) {
        summaries.push({
          id: acct.id,
          name: acct.name,
          workspaceName: acct.workspaceName,
          createdAt: acct.createdAt,
        });
      }
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    await this.kv.put("accounts", JSON.stringify(summaries));
  }
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
