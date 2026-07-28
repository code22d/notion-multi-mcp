// -----------------------------------------------------------------------------
// Round-trip test for the View DSL parser + emitter.
//
// Run with:
//   tsx test/view-roundtrip.ts
//
// For each VIEW_FIXTURE: dsl → parseViewDsl → emitViewBody, then assert the
// emitted body matches the fixture's expected subset.
// For each VIEW_ERROR_FIXTURE: assert the pipeline throws a matching message.
// -----------------------------------------------------------------------------

import { parseViewDsl } from "../src/notion/view-dsl/parser.ts";
import { emitViewBody } from "../src/notion/view-dsl/emit.ts";
import { VIEW_FIXTURES, VIEW_ERROR_FIXTURES } from "./view-fixtures.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function deepSubset(actual: unknown, expected: unknown, path: string): string[] {
  const errors: string[] = [];
  if (expected === null) {
    if (actual !== null) errors.push(`${path}: expected null, got ${JSON.stringify(actual)}`);
    return errors;
  }
  if (typeof expected !== "object") {
    if (actual !== expected) {
      errors.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return errors;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${path}: expected array, got ${JSON.stringify(actual)}`);
      return errors;
    }
    if (actual.length !== expected.length) {
      errors.push(`${path}: expected length ${expected.length}, got ${actual.length}`);
    }
    for (let i = 0; i < expected.length; i++) {
      errors.push(...deepSubset(actual[i], expected[i], `${path}[${i}]`));
    }
    return errors;
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    errors.push(`${path}: expected object, got ${JSON.stringify(actual)}`);
    return errors;
  }
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined) {
      if (k in (actual as Record<string, unknown>)) {
        errors.push(`${path}.${k}: expected absent, got ${JSON.stringify((actual as Record<string, unknown>)[k])}`);
      }
      continue;
    }
    errors.push(...deepSubset((actual as Record<string, unknown>)[k], v, `${path}.${k}`));
  }
  return errors;
}

// -----------------------------------------------------------------------------
// View fixtures
// -----------------------------------------------------------------------------

console.log("\n=== View DSL fixtures ===");
for (const fx of VIEW_FIXTURES) {
  console.log(`\n[view] ${fx.name}`);
  try {
    const directives = parseViewDsl(fx.dsl);
    const resolver = fx.propIds ? makeResolver(fx.propIds) : undefined;
    const typeResolver = fx.propTypes ? makeTypeResolver(fx.propTypes) : undefined;
    const body = emitViewBody(directives, {
      viewType: fx.viewType,
      ...(resolver ? { resolvePropertyId: resolver } : {}),
      ...(typeResolver ? { resolvePropertyType: typeResolver } : {}),
    });
    const errors = deepSubset(body, fx.expected, "body");
    if (errors.length === 0) {
      assert(true, "emitted body matches expected shape");
    } else {
      for (const err of errors) assert(false, err);
    }
  } catch (e) {
    assert(false, `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Build a resolver that mirrors the handler's behaviour: map hit → return
 *  id; value-is-already-an-id → pass through; otherwise throw with a list of
 *  known names. */
function makeResolver(map: Record<string, string>): (name: string) => string {
  const available = Object.keys(map);
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name]!;
    for (const id of Object.values(map)) {
      if (id === name) return name;
    }
    throw new Error(
      `property "${name}" not found on the view's data source. ` +
        `Available property names: ${available.map((n) => `"${n}"`).join(", ") || "(none)"}.`
    );
  };
}

/** Mirror of `makeTypeResolverFromProperties` in src/tools/views.ts — lookup
 *  by name, return the Notion column type, or undefined when the name isn't
 *  present. Undefined lets the emitter fall through to operator/value
 *  inference (backwards-compat). */
function makeTypeResolver(map: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    return undefined;
  };
}

// -----------------------------------------------------------------------------
// Error fixtures
// -----------------------------------------------------------------------------

console.log("\n=== View DSL error fixtures (expected failures) ===");
for (const fx of VIEW_ERROR_FIXTURES) {
  console.log(`\n[view-error] ${fx.name}`);
  let threw = false;
  let message = "";
  try {
    const directives = parseViewDsl(fx.dsl);
    const emitCtx: Parameters<typeof emitViewBody>[1] = {};
    if (fx.viewType) emitCtx.viewType = fx.viewType;
    if (fx.propIds) emitCtx.resolvePropertyId = makeResolver(fx.propIds);
    if (fx.propTypes) emitCtx.resolvePropertyType = makeTypeResolver(fx.propTypes);
    emitViewBody(directives, emitCtx);
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  assert(threw, "pipeline threw as expected");
  if (threw) {
    assert(
      fx.expectMessageMatches.test(message),
      `error message matched /${fx.expectMessageMatches.source}/ — got: ${message}`
    );
  }
}

console.log(`\n=== View DSL round-trip: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
