#!/usr/bin/env bash
# One-shot: clear any stale sandbox-created lock, commit the staged Phase 4
# files, push to origin, and deploy the Worker. Safe to re-run — if there's
# nothing to commit, it skips commit and goes to push/deploy.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Clearing any stale index.lock"
rm -f .git/index.lock

echo "==> Staging any not-yet-staged Phase 4 files"
git add -A

if git diff --cached --quiet; then
  echo "==> Nothing staged — skipping commit"
else
  echo "==> Committing"
  git commit -F - <<'MSG'
Phase 4: View DSL parser + real notion_create_view / notion_update_view / notion_duplicate_page

- src/notion/view-dsl/: hand-rolled lexer + recursive-descent parser + emitter.
  Grammar: FILTER (property filters with type inference or explicit override;
  compound AND/OR up to 2 levels; TIMESTAMP filters), SORT BY (multi-term,
  property or timestamp), GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART,
  FORM, SHOW, COVER.
- Emitter validates view-type/directive compatibility and surfaces a clean
  error for dashboard views (public REST API doesn't expose their config).
- notion_create_view / notion_update_view swap in real handlers in place;
  tool names and schemas unchanged for parity. Update handler fetches the
  view first when a config-touching directive is present so it can pick the
  right ViewConfigRequest variant.
- notion_duplicate_page: recursive block walker. Fetches the source tree with
  pagination, strips server-only fields, flips notion-hosted file URLs to
  external, inlines children for types that accept them, creates the page in
  chunks of 100, hydrates nested children by pairing source and response
  trees. Emits paragraph placeholders for child_database / child_page /
  unsupported / synced-reference blocks that can't be duplicated via the
  public API.
- NotionClient: createView, getView, updateView, plus NotionViewObject type.
- Tests: test/view-fixtures.ts + test/view-roundtrip.ts (22 positive + 10
  negative fixtures), test/duplicate-page.ts (9 block-conversion scenarios).
  Wired into npm test.

npx tsc --noEmit: clean.
npm test: 149/149 passing (36 + 40 + 43 + 30).
wrangler deploy --dry-run: 58.89 KiB gzipped (+12 KiB vs Phase 3, well under
the 1 MiB cap).
MSG
fi

echo "==> Pushing to origin/main"
git push origin main

echo "==> Deploying Worker"
npm run deploy

echo "==> Done."
