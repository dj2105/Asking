// /src/lib/codexBridge.js
// Minimal bridge to invoke Codex CLI tasks from the browser when available.
// The bridge tries three strategies:
//   1. window.codex.runTask(task, payload)
//   2. window.codex.run(task, payload)
//   3. POST /__codex__/tasks/<task>
// If none succeed we throw a descriptive error so the caller can present a
// helpful message to the host.

export async function runCodexTask(task, payload = {}) {
  if (!task || typeof task !== "string") {
    throw new Error("Codex task name required.");
  }

  if (window.codex && typeof window.codex.runTask === "function") {
    return window.codex.runTask(task, payload);
  }

  if (window.codex && typeof window.codex.run === "function") {
    return window.codex.run(task, payload);
  }

  try {
    const response = await fetch(`/__codex__/tasks/${encodeURIComponent(task)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch (err) {
      return text;
    }
  } catch (err) {
    throw new Error(`Codex task runner unavailable. Run “codex run ${task}” manually.`);
  }
}
