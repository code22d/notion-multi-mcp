// -----------------------------------------------------------------------------
// Unit tests for NotionClient's retry policy (Retry-After handling).
//
// The client takes `fetchImpl` / `sleepImpl` / `nowImpl` seams so these tests
// can assert the OBSERVED sleep sequence without ever waiting in real time —
// `sleepImpl` records the requested duration and resolves immediately.
//
// Covers:
//   - Retry-After (integer seconds) overrides the exponential curve
//   - Retry-After (HTTP-date) resolved against the injected clock
//   - absent / malformed header falls back to 100/400/900ms
//   - 429 gets more attempts than 5xx
//   - HTTP 529 service_overload routes through the >= 500 arm (no extra branch)
//   - single-sleep ceiling and total-sleep budget both surface clear errors
//   - non-retriable statuses still throw immediately
// -----------------------------------------------------------------------------

import { NOTION_VERSION, NotionClient, parseRetryAfterMs } from "../src/notion/client.ts";
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

function contains(haystack: string, needle: string, msg: string): void {
  assert(haystack.includes(needle), `${msg} (expected to contain "${needle}", got ${JSON.stringify(haystack)})`);
}

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const ACCOUNT: NotionAccount = {
  id: "acct-1",
  name: "Test",
  accessToken: "secret-token-value",
  botId: "bot-1",
  workspaceId: "ws-1",
  workspaceName: "Test WS",
  createdAt: 0,
};

interface StubResponse {
  status: number;
  /** JSON body for a 200; error body otherwise. */
  body?: unknown;
  headers?: Record<string, string>;
}

interface Harness {
  client: NotionClient;
  /** Durations passed to sleepImpl, in call order. */
  sleeps: number[];
  /** Number of fetch calls made. */
  calls: () => number;
  /** Request init recorded per call. */
  inits: Array<{ method?: string; headers?: Record<string, string> }>;
}

/**
 * Build a client whose fetch returns `queue` in order. If the queue runs dry
 * the last entry repeats, so a test can say "always 429" with one entry.
 */
function harness(queue: StubResponse[], nowMs = 1_000_000): Harness {
  const sleeps: number[] = [];
  const inits: Array<{ method?: string; headers?: Record<string, string> }> = [];
  let i = 0;

  const fetchImpl = (async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    inits.push(init ?? {});
    const spec = queue[Math.min(i, queue.length - 1)]!;
    i++;
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      headers: spec.headers ?? {},
      json: async () => spec.body ?? {},
      text: async () => (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {})),
    };
  }) as unknown as typeof fetch;

  const client = new NotionClient(ACCOUNT, {
    fetchImpl,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
    nowImpl: () => nowMs,
  });

  return { client, sleeps, calls: () => i, inits };
}

function errBody(message: string): unknown {
  return { object: "error", code: "rate_limited", message };
}

// -----------------------------------------------------------------------------
// parseRetryAfterMs — pure unit
// -----------------------------------------------------------------------------

console.log("\n[parseRetryAfterMs] integer-seconds form");
{
  const NOW = 1_000_000;
  eq(parseRetryAfterMs("1", NOW), 1000, "'1' ⇒ 1000ms");
  eq(parseRetryAfterMs("30", NOW), 30_000, "'30' ⇒ 30000ms");
  eq(parseRetryAfterMs("0", NOW), 0, "'0' ⇒ 0ms");
  eq(parseRetryAfterMs("  7  ", NOW), 7000, "surrounding whitespace tolerated");
}

console.log("\n[parseRetryAfterMs] HTTP-date form");
{
  // Pin an absolute instant so the test is clock-independent.
  const NOW = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  eq(
    parseRetryAfterMs("Wed, 21 Oct 2026 07:28:05 GMT", NOW),
    5000,
    "date 5s in the future ⇒ 5000ms"
  );
  eq(
    parseRetryAfterMs("Wed, 21 Oct 2026 07:27:00 GMT", NOW),
    0,
    "date in the past clamps to 0 (never a negative sleep)"
  );
}

console.log("\n[parseRetryAfterMs] absent / malformed ⇒ null (fall back to backoff)");
{
  const NOW = 1_000_000;
  eq(parseRetryAfterMs(null, NOW), null, "null ⇒ null");
  eq(parseRetryAfterMs(undefined, NOW), null, "undefined ⇒ null");
  eq(parseRetryAfterMs("", NOW), null, "empty string ⇒ null");
  eq(parseRetryAfterMs("   ", NOW), null, "whitespace-only ⇒ null");
  eq(parseRetryAfterMs("soon", NOW), null, "garbage ⇒ null");
  eq(parseRetryAfterMs("-5", NOW), null, "negative delta-seconds rejected");
  eq(parseRetryAfterMs("1.5", NOW), null, "fractional delta-seconds rejected");
}

// -----------------------------------------------------------------------------
// Retry-After honoured on 429
// -----------------------------------------------------------------------------

console.log("\n[429] Retry-After overrides the exponential curve");
{
  const h = harness([
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "3" } },
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "7" } },
    { status: 200, body: { object: "page", id: "p1" } },
  ]);
  const out = await h.client.request<{ id: string }>("/pages/p1");
  eq(out.id, "p1", "eventually succeeds");
  eq(h.calls(), 3, "made 3 fetch calls");
  eq(h.sleeps, [3000, 7000], "slept exactly the advertised delays, not 100/400");
}

console.log("\n[429] header is matched case-insensitively");
{
  const h = harness([
    { status: 429, body: errBody("rate limited"), headers: { "retry-after": "2" } },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.sleeps, [2000], "lowercase header name read");
}

console.log("\n[429] a real Headers object works too");
{
  const h = harness([
    { status: 429, body: errBody("rate limited") },
    { status: 200, body: { ok: true } },
  ]);
  // Re-wrap with a Headers-like duck type exposing .get()
  const sleeps: number[] = [];
  let i = 0;
  const responses = [
    { status: 429, headers: new Map([["retry-after", "4"]]) },
    { status: 200, headers: new Map<string, string>() },
  ];
  const client = new NotionClient(ACCOUNT, {
    fetchImpl: (async () => {
      const spec = responses[i]!;
      i++;
      return {
        ok: spec.status === 200,
        status: spec.status,
        headers: { get: (n: string) => spec.headers.get(n.toLowerCase()) ?? null },
        json: async () => ({ ok: true }),
        text: async () => "{}",
      };
    }) as unknown as typeof fetch,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  await client.request("/pages/x");
  eq(sleeps, [4000], "headers.get() path reads Retry-After");
  void h;
}

// -----------------------------------------------------------------------------
// Fallback to exponential backoff
// -----------------------------------------------------------------------------

// NOTE: this case previously fed three 429s and asserted sleeps [100, 400, 900],
// which only passes if an unheadered 429 is allowed 4+ attempts. That budget was
// the bug the audit caught — blind retries against a workspace-level limit spend
// requests we're already over on. The fallback CURVE is unchanged (100, 400, …);
// only the number of attempts it gets to walk shrank back to 3.
console.log("\n[429] no Retry-After ⇒ original backoff curve, within the default budget");
{
  const h = harness([
    { status: 429, body: errBody("rate limited") },
    { status: 429, body: errBody("rate limited") },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.sleeps, [100, 400], "fell back to the pre-existing backoff curve");
  eq(h.calls(), 3, "succeeded on the third and final permitted attempt");
}

// The attempt budget turns on the presence of Retry-After, not the status class.
// Retrying blind against a workspace-level rate limit spends requests we're
// already over budget on, so an unheadered 429 must NOT get the larger budget.
console.log("\n[429] attempt budget depends on Retry-After, not on the status");
{
  // No header anywhere: exhausts the DEFAULT budget (3 attempts ⇒ 2 sleeps).
  const h = harness([
    { status: 429, body: errBody("rate limited") },
    { status: 429, body: errBody("rate limited") },
    { status: 429, body: errBody("rate limited") },
    { status: 429, body: errBody("rate limited") },
    { status: 429, body: errBody("rate limited") },
    { status: 200, body: { ok: true } },
  ]);
  let threw = false;
  try {
    await h.client.request("/pages/x");
  } catch {
    threw = true;
  }
  assert(threw, "unheadered 429 gave up rather than retrying indefinitely");
  eq(h.calls(), 3, "unheadered 429 sent 3 requests, not 5 (blind retries stay cheap)");
  eq(h.sleeps, [100, 400], "…with the original two backoff sleeps");
}
{
  // Same failure count, but Notion named the window: earns the larger budget.
  const h = harness([
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "1" } },
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "1" } },
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "1" } },
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "1" } },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.calls(), 5, "headered 429 used the full 5-attempt budget and succeeded");
  eq(h.sleeps, [1000, 1000, 1000, 1000], "…sleeping exactly the advertised delay each time");
}
{
  // A 5xx never earns the larger budget, even carrying Retry-After.
  const h = harness([
    { status: 503, body: errBody("unavailable"), headers: { "Retry-After": "1" } },
    { status: 503, body: errBody("unavailable"), headers: { "Retry-After": "1" } },
    { status: 503, body: errBody("unavailable"), headers: { "Retry-After": "1" } },
    { status: 200, body: { ok: true } },
  ]);
  let threw = false;
  try {
    await h.client.request("/pages/x");
  } catch {
    threw = true;
  }
  assert(threw, "5xx exhausted its budget");
  eq(h.calls(), 3, "5xx kept the 3-attempt budget even with Retry-After present");
}

console.log("\n[429] malformed Retry-After ⇒ backoff, not a hard failure");
{
  const h = harness([
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "whenever" } },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.sleeps, [100], "unparseable header fell soft to backoff");
}

// -----------------------------------------------------------------------------
// Attempt counts
// -----------------------------------------------------------------------------

console.log("\n[429] gets 5 attempts before giving up");
{
  const h = harness([{ status: 429, body: errBody("rate limited"), headers: { "Retry-After": "1" } }]);
  let threw = "";
  try {
    await h.client.request("/pages/x");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(h.calls(), 5, "5 fetch attempts for a persistent 429");
  eq(h.sleeps, [1000, 1000, 1000, 1000], "4 sleeps between 5 attempts");
  contains(threw, "429", "final error names the status");
}

console.log("\n[500] gets 3 attempts (unchanged from the original policy)");
{
  const h = harness([{ status: 500, body: { message: "boom" } }]);
  let threw = "";
  try {
    await h.client.request("/pages/x");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(h.calls(), 3, "3 fetch attempts for a persistent 500");
  eq(h.sleeps, [100, 400], "2 sleeps between 3 attempts");
  contains(threw, "500", "final error names the status");
}

console.log("\n[529] service_overload routes through the >= 500 arm, no extra branch");
{
  const h = harness([
    { status: 529, body: { code: "service_overload", message: "overloaded" } },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.calls(), 2, "529 was retried");
  eq(h.sleeps, [100], "and used the same policy as any other 5xx");
}

console.log("\n[529] Retry-After is honoured there too");
{
  const h = harness([
    { status: 529, body: { code: "service_overload", message: "overloaded" }, headers: { "Retry-After": "6" } },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.sleeps, [6000], "529 + Retry-After sleeps the advertised delay");
}

// -----------------------------------------------------------------------------
// Ceilings
// -----------------------------------------------------------------------------

console.log("\n[ceiling] a single Retry-After above 60s errors instead of hanging the Worker");
{
  const h = harness([{ status: 429, body: errBody("rate limited"), headers: { "Retry-After": "3600" } }]);
  let threw = "";
  try {
    await h.client.request("/pages/x");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(h.sleeps, [], "never slept");
  eq(h.calls(), 1, "gave up after the first response");
  contains(threw, "3600s", "error states the advertised delay");
  contains(threw, "60s single-wait ceiling", "error names the ceiling");
}

console.log("\n[ceiling] exactly 60s is allowed (boundary)");
{
  const h = harness([
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "60" } },
    { status: 200, body: { ok: true } },
  ]);
  await h.client.request("/pages/x");
  eq(h.sleeps, [60_000], "60s sleep permitted");
}

console.log("\n[ceiling] cumulative sleep is budgeted across attempts");
{
  // 40s then another 40s would total 80s > the 60s budget.
  const h = harness([
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "40" } },
    { status: 429, body: errBody("rate limited"), headers: { "Retry-After": "40" } },
    { status: 200, body: { ok: true } },
  ]);
  let threw = "";
  try {
    await h.client.request("/pages/x");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(h.sleeps, [40_000], "slept once, refused the second");
  contains(threw, "total-wait budget", "error names the total budget");
}

// -----------------------------------------------------------------------------
// Non-retriable statuses are untouched
// -----------------------------------------------------------------------------

console.log("\n[non-retriable] 4xx other than 429 throws immediately");
{
  for (const status of [400, 401, 403, 404]) {
    const h = harness([{ status, body: { message: "nope" } }]);
    let threw = "";
    try {
      await h.client.request("/pages/x");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    eq(h.calls(), 1, `${status} made exactly one call`);
    eq(h.sleeps, [], `${status} never slept`);
    contains(threw, `Notion API ${status}`, `${status} error message shape unchanged`);
  }
}

console.log("\n[non-retriable] a Retry-After on a 404 is ignored");
{
  const h = harness([{ status: 404, body: { message: "nope" }, headers: { "Retry-After": "5" } }]);
  try {
    await h.client.request("/pages/x");
  } catch {
    /* expected */
  }
  eq(h.sleeps, [], "no sleep on a non-retriable status");
}

// -----------------------------------------------------------------------------
// Regression: the happy path is untouched
// -----------------------------------------------------------------------------

console.log("\n[happy path] a 200 on the first try makes one call and no sleeps");
{
  const h = harness([{ status: 200, body: { object: "page", id: "p9" } }]);
  const out = await h.client.request<{ id: string }>("/pages/p9");
  eq(out.id, "p9", "returns the parsed body");
  eq(h.calls(), 1, "one fetch");
  eq(h.sleeps, [], "no sleeps");
  // Pinned deliberately, and asserted from the constant rather than a literal
  // so a bump is a one-line change here instead of a mystery failure. The
  // literal is here too, because "we send whatever the constant says" would
  // pass even if the constant were empty.
  eq(h.inits[0]?.headers?.["notion-version"], NOTION_VERSION, "the pinned API version is what goes on the wire");
  eq(NOTION_VERSION, "2026-03-11", "…and it is 2026-03-11");
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
