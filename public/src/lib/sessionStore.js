// /src/lib/sessionStore.js
// Local session tracking helpers for rejoin flows.
// Stores the most recent room/role/stage in localStorage so either player
// can hop back in without re-entering everything.

import { clampCode } from "./util.js";

const STORAGE_KEY = "jemimaSession:v1";
const ROLE_HOST = "host";
const ROLE_GUEST = "guest";

function normalizeRole(role) {
  const r = String(role || "").toLowerCase();
  if (r === ROLE_HOST) return ROLE_HOST;
  if (r === ROLE_GUEST) return ROLE_GUEST;
  return "";
}

function safeRound(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return null;
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (err) {
    console.warn("[sessionStore] read failed", err);
  }
  return {};
}

function writeStore(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data || {}));
  } catch (err) {
    console.warn("[sessionStore] write failed", err);
  }
}

function touchEntry(base, entry) {
  const next = { ...(base || {}) };
  const now = Date.now();
  next.code = clampCode(entry.code || next.code || "");
  next.role = normalizeRole(entry.role || next.role || "");
  next.state = entry.state || next.state || "";
  const r = safeRound(entry.round);
  next.round = r !== null ? r : next.round || null;
  next.updatedAt = now;
  return next;
}

export function recordSession(entry = {}) {
  const code = clampCode(entry.code || "");
  if (!code) return;
  const role = normalizeRole(entry.role);
  const state = entry.state || "";
  const round = safeRound(entry.round);
  const data = readStore();

  const payload = {
    code,
    role,
    state,
    round,
    updatedAt: Date.now(),
  };

  data.latest = touchEntry(data.latest, payload);
  if (role) {
    data[role] = touchEntry(data[role], payload);
  }
  if (role) {
    data.preferredRole = role;
  }
  writeStore(data);
}

export function getLastSession(role) {
  const data = readStore();
  const want = normalizeRole(role);
  if (want) {
    const entry = data[want];
    if (entry && entry.code) return entry;
  }
  const buckets = [data.latest, data.host, data.guest];
  let best = null;
  for (const candidate of buckets) {
    if (!candidate || !candidate.code) continue;
    if (!best || (candidate.updatedAt || 0) > (best.updatedAt || 0)) {
      best = candidate;
    }
  }
  return best || null;
}

export function getPreferredRole() {
  const data = readStore();
  const pref = normalizeRole(data.preferredRole);
  return pref || "";
}

export function setPreferredRole(role) {
  const data = readStore();
  data.preferredRole = normalizeRole(role) || "";
  writeStore(data);
}

export function getLastCode() {
  const latest = getLastSession();
  return latest?.code || "";
}
