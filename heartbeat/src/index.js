export const SYSTEM_ID = "beszel-main";
export const MAX_BODY_BYTES = 16 * 1024;
export const FRESHNESS_MS = 150 * 1000;
export const PUSH_PATH_PREFIX = "/push/";
export const LIVE_PATH = `/status/${SYSTEM_ID}/live`;
export const SYSTEMS_PATH = `/status/${SYSTEM_ID}/systems`;
export const STATUS_VALUES = new Set(["ok", "warn", "error"]);
export const SECRET_PATTERN = /^[a-f0-9]{64}$/;

const UPSERT_SQL = `
  INSERT INTO heartbeats
    (id, last_seen, status, total, up, down, paused, pending)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen,
    status = excluded.status,
    total = excluded.total,
    up = excluded.up,
    down = excluded.down,
    paused = excluded.paused,
    pending = excluded.pending
`;
const SELECT_SQL = `
  SELECT id, last_seen, status, total, up, down, paused, pending
  FROM heartbeats
  WHERE id = ?
`;
const NO_STORE = { "Cache-Control": "no-store" };
const REQUIRED_FIELDS = ["status", "timestamp", "msg", "systems", "beszel_version"];
const SYSTEM_FIELDS = new Set(["total", "up", "down", "paused", "pending"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidSystems(systems) {
  if (
    !isPlainObject(systems) ||
    ![...SYSTEM_FIELDS].every(
      (key) => Object.prototype.hasOwnProperty.call(systems, key) && isNonNegativeInteger(systems[key]),
    )
  ) {
    return false;
  }
  return systems.total >= systems.up + systems.down + systems.paused + systems.pending;
}

function isValidDownSystems(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (system) =>
        isPlainObject(system) &&
        typeof system.id === "string" &&
        typeof system.name === "string" &&
        typeof system.host === "string",
    )
  );
}

function isValidAlerts(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (alert) =>
        isPlainObject(alert) &&
        typeof alert.system_id === "string" &&
        typeof alert.system_name === "string" &&
        typeof alert.alert_name === "string" &&
        typeof alert.threshold === "number" &&
        Number.isFinite(alert.threshold),
    )
  );
}

export function validatePayload(payload) {
  if (!isPlainObject(payload)) return false;
  if (!REQUIRED_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(payload, key))) return false;
  if (typeof payload.status !== "string" || !STATUS_VALUES.has(payload.status)) return false;
  if (!isValidSystems(payload.systems)) return false;
  if (typeof payload.timestamp !== "string") return false;
  if (typeof payload.msg !== "string") return false;
  if (typeof payload.beszel_version !== "string") return false;
  if (payload.down_systems !== undefined && !isValidDownSystems(payload.down_systems)) return false;
  if (payload.triggered_alerts !== undefined && !isValidAlerts(payload.triggered_alerts)) return false;
  return true;
}

export function isFresh(lastSeen, now = Date.now()) {
  return Number.isSafeInteger(lastSeen) && lastSeen <= now && now - lastSeen <= FRESHNESS_MS;
}

function isValidStoredRow(row) {
  return (
    isPlainObject(row) &&
    row.id === SYSTEM_ID &&
    isFreshStoredTime(row.last_seen) &&
    typeof row.status === "string" &&
    STATUS_VALUES.has(row.status) &&
    [row.total, row.up, row.down, row.paused, row.pending].every(isNonNegativeInteger) &&
    row.total >= row.up + row.down + row.paused + row.pending
  );
}

function isFreshStoredTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function response(body, status, contentType = "text/plain; charset=utf-8") {
  const headers = new Headers(NO_STORE);
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(body, { status, headers });
}

async function readBody(request) {
  if (!request.body) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return bytes.byteLength <= MAX_BODY_BYTES ? bytes : null;
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isJsonContentType(request) {
  const contentType = request.headers.get("content-type");
  return contentType !== null && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function push(request, env) {
  if (request.method !== "POST") return response("not found", 404);

  let body;
  try {
    body = await readBody(request);
  } catch {
    return response("bad request", 400);
  }
  if (body === null) return response("payload too large", 413);
  if (!isJsonContentType(request)) return response("bad request", 400);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return response("bad request", 400);
  }
  if (!validatePayload(payload)) return response("bad request", 400);
  if (!env || !env.DB || typeof env.DB.prepare !== "function") return response("internal error", 500);

  const receivedAt = Date.now();
  const systems = payload.systems;
  try {
    const result = await env.DB
      .prepare(UPSERT_SQL)
      .bind(
        SYSTEM_ID,
        receivedAt,
        payload.status,
        systems.total,
        systems.up,
        systems.down,
        systems.paused,
        systems.pending,
      )
      .run();
    if (result && result.success === false) throw new Error("D1 write failed");
  } catch {
    return response("internal error", 500);
  }
  return response(null, 204, null);
}

async function readStoredRow(env) {
  if (!env || !env.DB || typeof env.DB.prepare !== "function") throw new Error("D1 unavailable");
  const row = await env.DB.prepare(SELECT_SQL).bind(SYSTEM_ID).first();
  return isValidStoredRow(row) ? row : null;
}

async function status(request, env, path) {
  if (request.method !== "GET") return response("not found", 404);
  let row;
  try {
    row = await readStoredRow(env);
  } catch {
    return response("down", 503);
  }
  if (!row || !isFresh(row.last_seen)) return response("down", 503);
  if (path === LIVE_PATH) return response("healthy", 200);
  if (
    row.total === 1 &&
    row.up === 1 &&
    row.down === 0 &&
    row.paused === 0 &&
    row.pending === 0
  ) {
    return response("healthy", 200);
  }
  return response("down", 503);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith(PUSH_PATH_PREFIX)) {
    const token = url.pathname.slice(PUSH_PATH_PREFIX.length);
    if (
      !env ||
      typeof env.PUSH_SECRET !== "string" ||
      !SECRET_PATTERN.test(env.PUSH_SECRET) ||
      token !== env.PUSH_SECRET
    ) {
      return response("not found", 404);
    }
    return push(request, env);
  }
  if (url.pathname === LIVE_PATH || url.pathname === SYSTEMS_PATH) {
    return status(request, env, url.pathname);
  }
  return response("not found", 404);
}

export default { fetch: handleRequest };
