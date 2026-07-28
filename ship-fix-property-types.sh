#!/usr/bin/env bash
# Fix the type-blind property serializer: resolve each column's real type from
# the data source schema before writing, instead of guessing rich_text for every
# string. Re-deploys the Worker.
#
# NOTE: this commit also sweeps in the previously-uncommitted Run 5 → Run 6
# fixes (view-dsl select filters, null-icon stripping, verification precheck,
# comments capability hint). Those are already live on the Worker; this
# reconciles the repo with what's deployed.
#
# Usage:
#   ./ship-fix-property-types.sh              commit + push + deploy
#   ./ship-fix-property-types.sh --no-deploy  commit + push only
set -euo pipefail

DEPLOY=1
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

# --- Account preflight -------------------------------------------------------
# wrangler.toml pins no account_id, and this worker exists in more than one
# Cloudflare account. Deploying to the wrong one would create a second worker
# on a different workers.dev subdomain, with a KV binding pointing at a
# namespace id that only exists in the other account — i.e. every stored OAuth
# token would silently be missing. So: never guess. Fail closed.
if [ "$DEPLOY" -eq 1 ]; then
  echo "==> Checking Cloudflare account"
  if ! grep -qE '^[[:space:]]*account_id' wrangler.toml && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo ""
    echo "  Refusing to deploy: no account pinned."
    echo ""
    echo "  wrangler.toml has no account_id and CLOUDFLARE_ACCOUNT_ID is unset,"
    echo "  so wrangler would pick an account for you. You have more than one."
    echo ""
    echo "  Accounts on this login:"
    npx wrangler whoami 2>/dev/null | sed 's/^/    /' || echo "    (wrangler whoami failed — are you logged in?)"
    echo ""
    echo "  The live worker is notion-multi-mcp.gentle-meadow-5448.workers.dev,"
    echo "  and its KV namespace is 8101642dc8ff4d33aa209b4e3f662143 — pick the"
    echo "  account that owns those."
    echo ""
    echo "  Then re-run either as:"
    echo "    CLOUDFLARE_ACCOUNT_ID=<id> ./ship-fix-property-types.sh"
    echo "  or add  account_id = \"<id>\"  to wrangler.toml (preferred — permanent)."
    echo ""
    echo "  To push to GitHub without deploying:"
    echo "    ./ship-fix-property-types.sh --no-deploy"
    exit 1
  fi
fi

echo "==> Clearing any stale index.lock"
rm -f .git/index.lock

echo "==> Running typecheck"
npm run typecheck

echo "==> Running test suite"
npm test

echo "==> Staging"
git add -A

if git diff --cached --quiet; then
  echo "==> Nothing staged — skipping commit"
else
  echo "==> Committing"
  git commit -F - <<'MSG'
Resolve property types from the data source schema before serializing writes

notion_update_page (update_properties) and notion_create_pages both coerced
scalar shorthand values by guessing from the value's JS type and the key's
name: a string became `rich_text` unless the key was "title"/"Name". That
guess is correct only when the column really is rich_text, so every write of a
bare string into any other string-shaped column was rejected by Notion:

    "Status is expected to be status"

It looked status-specific in the field, but it was not. The types that worked
worked because they took different code paths — dates via the `date:` composite
keys, numbers via typeof, checkboxes via the __YES__/__NO__ sentinels,
multi-select via the array shorthand. Everything else passed as a plain string
was broken: status, select, url, email, phone_number, people, relation.
rich_text columns worked by accident.

Same root cause as the View DSL filter bug fixed earlier (emitting a text
filter for a select column). Same cure, and now the same shape: fetch the data
source and resolve the column's declared type before emitting.

New module src/notion/property-values.ts:
  - makePropertyTypeResolver()   name → Notion type, from a data source schema
  - resolveTypesForPage()        update path: page → parent → data source
  - resolveTypesForParent()      create path: parent is already known, no page
                                 fetch needed
  - coerceScalarToPropertyValue() type-aware serialization
  - needsTypeResolution()        skip the round trip when it can't change the
                                 answer

Behaviour notes:
  - Fails soft. Unknown column, page/workspace parent, or a failed schema
    fetch all fall back to the historical heuristic, so writes that used to
    succeed keep succeeding.
  - Native property-value objects still pass through untouched (escape hatch).
  - Empty string clears select/status/url/email/phone/date; clears people and
    relation to [].
  - multi_select from a bare string yields one option and does NOT split on
    commas — Notion allows commas inside option names.
  - Read-only columns (formula, rollup, created_time, …) pass through as
    rich_text so Notion returns its own clear error rather than us inventing a
    shape it never accepts.
  - The schema fetch is skipped entirely unless at least one value is an
    ambiguous bare string, so numeric/boolean/array/object-only writes cost no
    extra API calls.

Test: test/property-values.ts — 53 cases covering each column type, the
clearing semantics, the legacy fallbacks, the fetch-avoidance predicate, and
the page → parent → data source walk including the legacy database_id parent
and fail-soft paths. Full suite: 460 passing.

Also sweeps in the previously-uncommitted Run 5 → Run 6 fixes, which were
already deployed but never committed.
MSG
fi

echo "==> Pushing to origin/main"
git push origin main

if [ "$DEPLOY" -eq 1 ]; then
  echo "==> Deploying Worker"
  npm run deploy
  echo "==> Deployed. Reconnect/refresh the Notion connector if tools were cached."
else
  echo "==> Skipping deploy (--no-deploy). GitHub is up to date."
  echo "    To deploy later:  ./ship-fix-property-types.sh"
fi

echo "==> Done."
