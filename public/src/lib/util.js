// /src/lib/util.js
// Shared utilities for Jemima's Asking sealed-pack flow.

const CODE_REGEX = /[^A-Z0-9]/g;
const ROLE_STORAGE_PREFIX = "jemimaRole:";
const LAST_SESSION_KEY = "jemimaLastSession";

export function clampCode(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(CODE_REGEX, "")
    .slice(0, 5);
}

export function getHashParams() {
  const raw = window.location.hash || "";
  return new URLSearchParams(raw.split("?")[1] || "");
}

export function timeUntil(msEpoch) {
  const target = Number(msEpoch) || 0;
  if (!Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, target - Date.now());
}

export async function copyToClipboard(text) {
  const value = String(text ?? "");
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {
    console.warn("[util] navigator.clipboard failed, falling back", err);
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.warn("[util] execCommand copy failed", err);
    return false;
  }
}

export function canonicalJSONStringify(obj) {
  return JSON.stringify(obj);
}

export async function sha256Hex(data) {
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new TextEncoder().encode(String(data ?? ""));
  }

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  return Array.from(view).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function downloadBlob(filename, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  } catch (err) {
    console.warn("[util] downloadBlob failed", err);
  }
}

export function setStoredRole(code, role) {
  try { localStorage.setItem(`${ROLE_STORAGE_PREFIX}${clampCode(code)}`, role); } catch {}
}

export function getStoredRole(code) {
  try { return localStorage.getItem(`${ROLE_STORAGE_PREFIX}${clampCode(code)}`) || ""; } catch (err) {
    return "";
  }
}

export function getLastSession() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.code) parsed.code = clampCode(parsed.code);
    return parsed;
  } catch (err) {
    return null;
  }
}

export function setLastSession(update = {}) {
  if (!update || typeof update !== "object") return;
  try {
    const prev = getLastSession() || {};
    const next = { ...prev };

    if (update.code) {
      const code = clampCode(update.code);
      if (code) next.code = code;
    }

    if (typeof update.state === "string" && update.state.trim()) {
      next.state = update.state.trim().toLowerCase();
    }

    if (Number.isFinite(update.round) && update.round > 0) {
      next.round = Math.floor(update.round);
    }

    if (update.role === "host" || update.role === "guest") {
      next.role = update.role;
    }

    next.updatedAt = Date.now();

    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[util] setLastSession failed", err);
  }
}

export default {
  clampCode,
  getHashParams,
  timeUntil,
  copyToClipboard,
  canonicalJSONStringify,
  sha256Hex,
  downloadBlob,
  setStoredRole,
  getStoredRole,
  getLastSession,
  setLastSession,
};
