#!/usr/bin/env bash
# Fix-up after the Phase 4 commit: strip response-only null fields (icon:null,
# color:null) from block request bodies in notion_duplicate_page, which Notion
# rejects with "body failed validation". Re-deploys the Worker.
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
duplicate_page: strip response-only null fields (icon, color) from block request bodies

Notion's 2025-09-03 block response includes `icon: null` / `color: null` on
most block bodies; the corresponding request schema rejects null for those
fields with "body failed validation: …should be an object or `undefined`".
The walker now deletes top-level nulls from the type body before submitting.
`synced_from: null` is preserved (meaningful signal for synced_block
originals).

Caught live while running notion_duplicate_page against a page containing
paragraphs created via notion_create_pages.

Test: test/duplicate-page.ts gains two cases — one asserting icon/color null
is stripped, one asserting synced_from: null survives.
MSG
fi

echo "==> Pushing to origin/main"
git push origin main

echo "==> Deploying Worker"
npm run deploy

echo "==> Done."
