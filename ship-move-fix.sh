#!/usr/bin/env bash
# Real-fix for notion_move_pages: use Notion's dedicated POST /pages/{id}/move
# endpoint and post-verify the returned parent actually matches what we asked
# for. The previous implementation called PATCH /pages with `parent`, which
# Notion silently ignores (parent isn't in PATCH's body whitelist) — the
# handler was then reporting "success" on a no-op. Uncovered during Phase 1
# smoke testing this session.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Clearing any stale index.lock"
rm -f .git/index.lock

echo "==> Staging fix files"
git add -A

if git diff --cached --quiet; then
  echo "==> Nothing staged — skipping commit"
else
  echo "==> Committing"
  git commit -F - <<'MSG'
notion_move_pages: use dedicated POST /pages/{id}/move endpoint, post-verify parent, reject workspace parents

Root cause (Phase 1 bug, silently present since Phase 1 shipped):

- Old impl called PATCH /v1/pages/{id} with `{ parent: ... }` in the body.
  Notion's PATCH /pages body whitelist is: archived, properties, icon, cover,
  is_locked, template, erase_content, in_trash, is_archived. `parent` is NOT
  on that list — Notion silently ignores it and returns the page with its
  ORIGINAL parent. Our handler then reported "✅ Moved ... (now at <url>)"
  based on the 200 response, masking the silent no-op.

- The real move endpoint is POST /v1/pages/{id}/move, and it accepts only
  `{ parent: { page_id } }` or `{ parent: { data_source_id } }` in the body
  (database_id and workspace are not supported).

Fix:

- NotionClient gains `movePage(id, body)` → POST /v1/pages/{id}/move. Docstring
  warns future-us NOT to fall back to PATCH for moves.

- moveHandler now:
  * Translates `{type: "database_id"}` to the database's first data_source_id
    (fetches the DB to discover it).
  * Rejects `{type: "workspace"}` with a clear "public API limitation" error
    instead of silently failing.
  * Calls POST /pages/{id}/move and then post-verifies that the returned
    page's parent actually matches what we asked for. If Notion returns 200
    with the original parent (happens when the move is unsupported for the
    page type or the integration lacks workspace perms), the result is
    reported as ⚠, not ✅.

- Tool description updated to reflect the parent-type restriction.

Caught when the Phase 1 smoke test moved a page, got "✅ Moved", then the
follow-up fetch showed the parent was unchanged.

npx tsc --noEmit: clean.
npm test: 167/167 passing (no new tests — the bug only surfaces on a live
network call; would need a Notion mock to unit-cover, which is out of scope
for this session).
MSG
fi

echo "==> Pushing to origin/main"
git push origin main

echo "==> Deploying Worker"
npm run deploy

echo "==> Done."
