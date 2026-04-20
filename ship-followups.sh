#!/usr/bin/env bash
# Phase 4 follow-ups: property-name → property_id resolver + defensive JSON
# parsing for object-typed tool args.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Clearing any stale index.lock"
rm -f .git/index.lock

echo "==> Staging follow-up files"
git add -A

if git diff --cached --quiet; then
  echo "==> Nothing staged — skipping commit"
else
  echo "==> Committing"
  git commit -F - <<'MSG'
Phase 4 follow-ups: property-name → property_id resolver + JSON-string coercion for object args

(1) Resolver: property name → property_id

Notion's view-configuration API requires `property_id` (the property's UUID,
URL-encoded) on every config slot — group_by, calendar/timeline date, map_by,
chart x_axis / y_axis aggregator, SHOW properties[], COVER property. Filter
and sort take property *names*, but configuration takes *ids*. Caught live
when GROUP BY "Status" was rejected with "Group-by property 'Status' not
found".

- emit.ts: EmitContext gains an optional `resolvePropertyId(name) => id`
  callback. resolvePropId helper threads it through emitGroupBy, applyCover,
  applyPropertiesList, applyChart, and the calendar/timeline/map branches.
  When the callback is omitted (unit tests), names pass through unchanged.

- views.ts: createViewHandler fetches the data source up front when any
  config-touching directive is present, builds a name → id map from the
  data source's `properties`, and passes a resolver into emitViewBody. The
  resolver throws a helpful EmitError listing available names if a name
  doesn't resolve. Already-encoded ids in the DSL pass through (lets callers
  mix names and ids in one DSL without friction). updateViewHandler does
  the same but reads the data_source_id off the fetched view first.

- directivesNeedIdResolution(): only fetches the data source when the DSL
  actually references a property name in a config slot. FILTER/SORT-only
  DSLs skip the extra round-trip.

(2) Defensive JSON parsing for object-typed args

A `parent` arg passed to notion_duplicate_page got dropped on the wire and
my handler reported "Couldn't determine a destination parent" even though
the object was passed in. Cause: some MCP clients serialize OPTIONAL
object-typed args as JSON strings instead of pre-parsed objects (observed
through the Cowork transport on optional args; required args came through
as objects). normalizeParent now coerces both forms via a shared
coerceToObject helper. Same defensive handling applied to
notion_create_pages parent and notion_move_pages new_parent.

Tests:
- view-fixtures: 4 new resolver fixtures (GROUP BY, CALENDAR BY, CHART
  aggregator, id-passthrough) + 1 error fixture (unknown name with helpful
  list of available names).
- duplicate-page: 8 new coerceToObject cases (object pass-through, JSON
  string parse, whitespace tolerance, junk strings → null, JSON arrays →
  null, undefined/null/non-object → null).

npx tsc --noEmit: clean.
npm test: 167/167 passing (36 + 40 + 49 + 42).
MSG
fi

echo "==> Pushing to origin/main"
git push origin main

echo "==> Deploying Worker"
npm run deploy

echo "==> Done."
