import test from "node:test";
import assert from "node:assert/strict";
import { FRESHNESS_MS, handleRequest, isFresh, validatePayload } from "../src/index.js";

const SECRET = "a".repeat(64);

function payload(overrides = {}) {
  return {
    status: "ok",
    timestamp: "2000-01-01T00:00:00Z",
    msg: "heartbeat",
    systems: { total: 1, up: 1, down: 0, paused: 0, pending: 0 },
    beszel_version: "0.20.0",
    ...overrides,
  };
}

function request(path, { method = "GET", body, contentType = "application/json" } = {}) {
  return new Request(`https://heartbeat.example${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: contentType === null ? undefined : { "content-type": contentType },
  });
}

function db(row = null, { writeError = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              if (writeError) throw new Error("write failed");
              assert.match(sql, /INSERT INTO heartbeats/);
              assert.equal(values[0], "beszel-main");
              return { success: true };
            },
            async first() {
              assert.match(sql, /SELECT id, last_seen/);
              return row;
            },
          };
        },
      };
    },
  };
}

function env(row = null, options) {
  return { PUSH_SECRET: SECRET, DB: db(row, options) };
}

function stored(overrides = {}) {
  return {
    id: "beszel-main",
    last_seen: Date.now(),
    status: "ok",
    total: 1,
    up: 1,
    down: 0,
    paused: 0,
    pending: 0,
    ...overrides,
  };
}

test("rejects bad or weak tokens before parsing body", async () => {
  const response = await handleRequest(
    request(`/push/${SECRET}-wrong`, { method: "POST", body: payload() }),
    env(),
  );
  assert.equal(response.status, 404);
  assert.equal(
    (await handleRequest(request("/push/", { method: "POST", body: payload() }), { PUSH_SECRET: "", DB: db() })).status,
    404,
  );
  assert.equal(
    (await handleRequest(request("/push/short", { method: "POST", body: payload() }), { PUSH_SECRET: "short", DB: db() })).status,
    404,
  );
});

test("rejects malformed body and inconsistent counters", async () => {
  const response = await handleRequest(
    request(`/push/${SECRET}`, { method: "POST", body: { ...payload(), systems: { total: 1, up: 1, down: 1, paused: 0, pending: 0 } } }),
    env(),
  );
  assert.equal(response.status, 400);
  assert.equal(validatePayload({ ...payload(), systems: { total: -1, up: 1, down: 0, paused: 0, pending: 0 } }), false);
  assert.equal(validatePayload({ ...payload(), future_field: true }), true);
});

test("rejects oversized body", async () => {
  const response = await handleRequest(
    request(`/push/${SECRET}`, {
      method: "POST",
      body: { ...payload(), msg: "x".repeat(16 * 1024) },
    }),
    env(),
  );
  assert.equal(response.status, 413);
});

test("returns 204 only after a successful D1 write", async () => {
  const response = await handleRequest(
    request(`/push/${SECRET}`, { method: "POST", body: payload() }),
    env(),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const failed = await handleRequest(
    request(`/push/${SECRET}`, { method: "POST", body: payload() }),
    env(null, { writeError: true }),
  );
  assert.equal(failed.status, 500);
});

test("freshness is inclusive at 150 seconds", () => {
  const now = 1_000_000;
  assert.equal(isFresh(now - FRESHNESS_MS, now), true);
  assert.equal(isFresh(now - FRESHNESS_MS - 1, now), false);
});

test("live ignores warn status, systems enforces one healthy system", async () => {
  const row = stored({ status: "warn" });
  const live = await handleRequest(request("/status/beszel-main/live"), env(row));
  assert.equal(live.status, 200);
  assert.equal(await live.text(), "healthy");

  const systems = await handleRequest(request("/status/beszel-main/systems"), env(row));
  assert.equal(systems.status, 200);

  const paused = await handleRequest(
    request("/status/beszel-main/systems"),
    env(stored({ status: "warn", paused: 1, up: 0 })),
  );
  assert.equal(paused.status, 503);
});

test("missing, stale, invalid policy, and DB errors fail closed", async () => {
  assert.equal((await handleRequest(request("/status/beszel-main/live"), env())).status, 503);
  assert.equal(
    (await handleRequest(request("/status/beszel-main/live"), env(stored({ last_seen: Date.now() - FRESHNESS_MS - 1 })))).status,
    503,
  );
  assert.equal(
    (await handleRequest(request("/status/beszel-main/live"), env(stored({ status: "bogus" })))).status,
    503,
  );
  const failingDb = {
    prepare() {
      throw new Error("read failed");
    },
  };
  assert.equal(
    (await handleRequest(request("/status/beszel-main/live"), { DB: failingDb })).status,
    503,
  );
});
