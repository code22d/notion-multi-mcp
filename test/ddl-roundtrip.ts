// -----------------------------------------------------------------------------
// Round-trip test for the DDL parser + emitter.
//
// Run with:
//   tsx test/ddl-roundtrip.ts
//
// For each CREATE fixture: schema → parseCreateTable → emitCreateProperties,
// then assert the emitted properties object matches the expected subset.
//
// For each ALTER fixture: same pipeline via parseAlterStatements + emitAlterPatch.
//
// For each ERROR fixture: assert the pipeline throws a matching message.
// -----------------------------------------------------------------------------

import { parseCreateTable, parseAlterStatements } from "../src/notion/ddl/parser.ts";
import { emitCreateProperties, emitAlterPatch } from "../src/notion/ddl/emit.ts";
import { CREATE_FIXTURES, ALTER_FIXTURES, ERROR_FIXTURES } from "./ddl-fixtures.ts";

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
      // Sentinel: expect this key to be ABSENT.
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
// CREATE fixtures
// -----------------------------------------------------------------------------

console.log("\n=== CREATE TABLE fixtures ===");
for (const fx of CREATE_FIXTURES) {
  console.log(`\n[create] ${fx.name}`);
  try {
    const ast = parseCreateTable(fx.schema);
    const props = emitCreateProperties(ast);
    const errors = deepSubset(props, fx.expected, "props");
    if (errors.length === 0) {
      assert(true, "emitted properties match expected shape");
    } else {
      for (const err of errors) assert(false, err);
    }
  } catch (e) {
    assert(false, `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// -----------------------------------------------------------------------------
// ALTER fixtures
// -----------------------------------------------------------------------------

console.log("\n=== ALTER fixtures ===");
for (const fx of ALTER_FIXTURES) {
  console.log(`\n[alter] ${fx.name}`);
  try {
    const ops = parseAlterStatements(fx.statements);
    const patch = emitAlterPatch(ops);
    const errors = deepSubset(patch, fx.expected, "patch");
    if (errors.length === 0) {
      assert(true, "emitted patch matches expected shape");
    } else {
      for (const err of errors) assert(false, err);
    }
  } catch (e) {
    assert(false, `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// -----------------------------------------------------------------------------
// ERROR fixtures
// -----------------------------------------------------------------------------

console.log("\n=== Error fixtures (expected failures) ===");
for (const fx of ERROR_FIXTURES) {
  console.log(`\n[error] ${fx.name}`);
  let threw = false;
  let message = "";
  try {
    if (fx.schema !== undefined) {
      const ast = parseCreateTable(fx.schema);
      emitCreateProperties(ast);
    } else if (fx.statements !== undefined) {
      const ops = parseAlterStatements(fx.statements);
      emitAlterPatch(ops);
    }
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  assert(threw, "pipeline threw as expected");
  if (threw) {
    assert(fx.expectMessageMatches.test(message), `error message matched /${fx.expectMessageMatches.source}/ — got: ${message}`);
  }
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log(`\n=== DDL round-trip: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
