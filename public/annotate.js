const cfg = window.__ANNOTATE_CFG || {};
const pollUrl = cfg.pollUrl || "/display/now";
const logUrl = cfg.logUrl || "/annotate/log";
const sessionId = Number.isFinite(Number(cfg.sessionId))
  ? Number(cfg.sessionId)
  : null;

const state = {
  triad: null,
  selection: null,
  displayEventId: null,
  sessionId,
  pollHealthy: false,
};

const inputStartedAt = {
  withView: null,
  override: null,
};

const formRefs = {
  withView: null,
  override: null,
};

const failedQueue = [];
let failedQueueId = 1;
let processingFailedQueue = false;

const elements = {
  triadA: document.querySelector("[data-current-triad-a]"),
  triadB: document.querySelector("[data-current-triad-b]"),
  triadC: document.querySelector("[data-current-triad-c]"),
  cellA: document.querySelector(".annotate-triad-cell.cell-a"),
  cellB: document.querySelector(".annotate-triad-cell.cell-b"),
  cellC: document.querySelector(".annotate-triad-cell.cell-c"),
  selection: document.querySelector("[data-current-selection]"),
  odd: document.querySelector("[data-current-odd]"),
  session: document.querySelector("[data-current-session]"),
  syncStatus: document.querySelector("[data-sync-status]"),
  displayContext: document.querySelector("[data-display-context]"),
  lastSaved: document.querySelector("[data-last-saved]"),
};

const selectionToOdd = (selection) => {
  if (selection === "ab") return "c";
  if (selection === "ac") return "b";
  if (selection === "bc") return "a";
  return null;
};

const delayForRetryAttempt = (attempt) => {
  const delays = [1500, 3000, 5000, 8000, 12000];
  return delays[Math.min(attempt, delays.length - 1)];
};

const payloadFingerprint = (payload) => {
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
};

const updateStatus = () => {
  const triad = state.triad ?? {};
  if (elements.triadA) elements.triadA.textContent = triad.a || "-";
  if (elements.triadB) elements.triadB.textContent = triad.b || "-";
  if (elements.triadC) elements.triadC.textContent = triad.c || "-";
  const cells = {
    a: elements.cellA,
    b: elements.cellB,
    c: elements.cellC,
  };
  Object.values(cells).forEach((cell) => {
    if (!cell) return;
    cell.classList.remove("is-pair");
    cell.classList.remove("is-odd");
  });
  if (state.selection) {
    state.selection.split("").forEach((key) => {
      const cell = cells[key];
      if (cell) cell.classList.add("is-pair");
    });
    const odd = selectionToOdd(state.selection);
    if (odd && cells[odd]) cells[odd].classList.add("is-odd");
  }
  if (elements.selection) {
    elements.selection.textContent = state.selection
      ? state.selection.toUpperCase()
      : "-";
  }
  if (elements.odd) {
    const odd = selectionToOdd(state.selection);
    elements.odd.textContent = odd ? odd.toUpperCase() : "-";
  }
  if (elements.session) {
    elements.session.textContent =
      typeof state.sessionId === "number" ? String(state.sessionId) : "-";
  }
  if (elements.syncStatus) {
    elements.syncStatus.textContent = state.pollHealthy
      ? "Connected"
      : "Polling lost";
    elements.syncStatus.classList.toggle("is-warning", !state.pollHealthy);
    elements.syncStatus.classList.toggle("is-success", state.pollHealthy);
  }
  if (elements.displayContext) {
    const hasDisplay = Boolean(state.triad && state.displayEventId);
    elements.displayContext.textContent = hasDisplay
      ? `Linked (#${state.displayEventId})`
      : "No active display";
    elements.displayContext.classList.toggle("is-warning", !hasDisplay);
    elements.displayContext.classList.toggle("is-success", hasDisplay);
  }
};

const setLastSaved = () => {
  if (!elements.lastSaved) return;
  const now = new Date();
  elements.lastSaved.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const setSaveMessage = (form, message, tone = "info") => {
  const target = form.querySelector("[data-save-message]");
  if (!target) return;
  target.textContent = message;
  target.classList.remove("is-visible", "is-warning", "is-success");
  if (tone === "warning") target.classList.add("is-warning");
  if (tone === "success") target.classList.add("is-success");
  window.requestAnimationFrame(() => {
    target.classList.add("is-visible");
  });
};

const sendAnnotationPayload = async (payload) => {
  try {
    const res = await fetch(logUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
};

const markInputStarted = (key) => {
  if (!inputStartedAt[key]) {
    inputStartedAt[key] = new Date().toISOString();
  }
};

const getFailedCountForForm = (formKey) =>
  failedQueue.filter((item) => item.formKey === formKey).length;

const updateRetryUi = (formKey) => {
  const form = formRefs[formKey];
  if (!form) return;
  const retryButton = form.querySelector("[data-retry-button]");
  const retryCount = form.querySelector("[data-retry-count]");
  const count = getFailedCountForForm(formKey);
  if (retryButton) retryButton.hidden = count === 0;
  if (retryCount) retryCount.textContent = count > 0 ? `${count} queued` : "";
};

const updateRetryUiAll = () => {
  updateRetryUi("withView");
  updateRetryUi("override");
};

const removeQueuedByFingerprint = (formKey, fingerprint) => {
  if (!fingerprint) return;
  for (let i = failedQueue.length - 1; i >= 0; i -= 1) {
    const item = failedQueue[i];
    if (item.formKey === formKey && item.fingerprint === fingerprint) {
      failedQueue.splice(i, 1);
    }
  }
};

const enqueueFailedSubmission = (formKey, payload) => {
  const fingerprint = payloadFingerprint(payload);
  if (!fingerprint) return;
  const duplicate = failedQueue.some(
    (item) => item.formKey === formKey && item.fingerprint === fingerprint,
  );
  if (duplicate) return;
  failedQueue.push({
    id: failedQueueId,
    formKey,
    payload,
    fingerprint,
    attempts: 0,
    nextAttemptAt: Date.now() + delayForRetryAttempt(0),
  });
  failedQueueId += 1;
  updateRetryUi(formKey);
};

const processFailedQueue = async () => {
  if (processingFailedQueue) return;
  if (!failedQueue.length) return;
  processingFailedQueue = true;
  try {
    const now = Date.now();
    const recoveredByForm = {
      withView: 0,
      override: 0,
    };

    for (const item of [...failedQueue]) {
      if (item.nextAttemptAt > now) continue;
      const ok = await sendAnnotationPayload(item.payload);
      if (ok) {
        const idx = failedQueue.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) failedQueue.splice(idx, 1);
        if (Object.prototype.hasOwnProperty.call(recoveredByForm, item.formKey)) {
          recoveredByForm[item.formKey] += 1;
        }
      } else {
        const idx = failedQueue.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) {
          failedQueue[idx].attempts += 1;
          failedQueue[idx].nextAttemptAt =
            Date.now() + delayForRetryAttempt(failedQueue[idx].attempts);
        }
      }
    }

    if (recoveredByForm.withView > 0 && formRefs.withView) {
      setSaveMessage(
        formRefs.withView,
        `Recovered ${recoveredByForm.withView} unsaved`,
        "success",
      );
      setLastSaved();
    }
    if (recoveredByForm.override > 0 && formRefs.override) {
      setSaveMessage(
        formRefs.override,
        `Recovered ${recoveredByForm.override} unsaved`,
        "success",
      );
      setLastSaved();
    }
    updateRetryUiAll();
  } finally {
    processingFailedQueue = false;
  }
};

const retryQueuedForForm = async (formKey) => {
  for (const item of failedQueue) {
    if (item.formKey === formKey) item.nextAttemptAt = 0;
  }
  await processFailedQueue();
};

const handleWithViewSubmit = async (form) => {
  const pairField = form.querySelector('input[name="pair_label"]');
  const oddField = form.querySelector('input[name="odd_label"]');
  const pairLabel = pairField?.value?.trim() ?? "";
  const oddLabel = oddField?.value?.trim() ?? "";

  if (!pairLabel && !oddLabel) {
    setSaveMessage(form, "Nothing to save");
    return;
  }

  const payload = {
    pair_label: pairLabel,
    odd_label: oddLabel,
    triad: state.triad,
    selection: state.selection ?? null,
    display_event_id: state.displayEventId ?? null,
    input_started_at: inputStartedAt.withView,
    sessionId,
    source: "assistant-ui",
  };

  const ok = await sendAnnotationPayload(payload);
  if (!ok) {
    enqueueFailedSubmission("withView", payload);
    setSaveMessage(form, "Not saved. Retrying in background.", "warning");
    return;
  }

  removeQueuedByFingerprint("withView", payloadFingerprint(payload));
  if (pairField) pairField.value = "";
  if (oddField) oddField.value = "";
  inputStartedAt.withView = null;
  setSaveMessage(form, "Saved", "success");
  setLastSaved();
  updateRetryUi("withView");
};

const handleOverrideSubmit = async (form) => {
  const labels = {
    a: form.querySelector('input[name="a_label"]')?.value?.trim() ?? "",
    b: form.querySelector('input[name="b_label"]')?.value?.trim() ?? "",
    c: form.querySelector('input[name="c_label"]')?.value?.trim() ?? "",
    ab: form.querySelector('input[name="ab_label"]')?.value?.trim() ?? "",
    ac: form.querySelector('input[name="ac_label"]')?.value?.trim() ?? "",
    bc: form.querySelector('input[name="bc_label"]')?.value?.trim() ?? "",
  };

  const hasLabels = Object.values(labels).some((value) => value);
  if (!hasLabels) {
    setSaveMessage(form, "Nothing to save");
    return;
  }

  const payload = {
    labels_json: labels,
    selection: state.selection ? "override" : null,
    currentSelection: state.selection ?? null,
    display_event_id: state.displayEventId ?? null,
    input_started_at: inputStartedAt.override,
    triad: state.triad,
    sessionId,
    source: "assistant-ui",
  };

  const ok = await sendAnnotationPayload(payload);
  if (!ok) {
    enqueueFailedSubmission("override", payload);
    setSaveMessage(form, "Not saved. Retrying in background.", "warning");
    return;
  }

  removeQueuedByFingerprint("override", payloadFingerprint(payload));
  Object.keys(labels).forEach((key) => {
    const input = form.querySelector(`input[name="${key}_label"]`);
    if (input && input.value) input.value = "";
  });
  inputStartedAt.override = null;
  setSaveMessage(form, "Saved", "success");
  setLastSaved();
  updateRetryUi("override");
};

const attachHandlers = () => {
  const withViewForm = document.querySelector(
    '[data-annotate-form="with-view"]',
  );
  formRefs.withView = withViewForm;
  if (withViewForm) {
    const inputs = Array.from(withViewForm.querySelectorAll("input"));
    inputs.forEach((input) => {
      input.addEventListener("input", () => {
        if (!input.value.trim()) return;
        markInputStarted("withView");
      });
    });
    const retryButton = withViewForm.querySelector("[data-retry-button]");
    if (retryButton) {
      retryButton.addEventListener("click", () => retryQueuedForForm("withView"));
    }
    withViewForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleWithViewSubmit(withViewForm);
    });
  }

  const overrideForm = document.querySelector(
    '[data-annotate-form="override"]',
  );
  formRefs.override = overrideForm;
  if (overrideForm) {
    const inputs = Array.from(overrideForm.querySelectorAll("input"));
    inputs.forEach((input) => {
      input.addEventListener("input", () => {
        if (!input.value.trim()) return;
        markInputStarted("override");
      });
    });
    const retryButton = overrideForm.querySelector("[data-retry-button]");
    if (retryButton) {
      retryButton.addEventListener("click", () => retryQueuedForForm("override"));
    }
    overrideForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleOverrideSubmit(overrideForm);
    });
  }

  updateRetryUiAll();
};

const pollNow = async () => {
  try {
    const res = await fetch(pollUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("poll-failed");
    const data = await res.json();
    state.triad = data?.triad ?? null;
    state.selection = data?.selection ?? null;
    state.displayEventId = data?.display_event_id ?? null;
    state.sessionId =
      typeof data?.session_id === "number" ? data.session_id : null;
    state.pollHealthy = true;
    updateStatus();
  } catch {
    state.pollHealthy = false;
    updateStatus();
  }
};

document.addEventListener("DOMContentLoaded", () => {
  attachHandlers();
  pollNow();
  window.setInterval(pollNow, 1000);
  window.setInterval(processFailedQueue, 1500);
});
