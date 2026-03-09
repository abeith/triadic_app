const cfg = window.__ANNOTATE_CFG || {};
const pollUrl = cfg.pollUrl || "/display/now";
const historyUrl = cfg.historyUrl || "/display/history";
const logUrl = cfg.logUrl || "/annotate/log";
const sessionId = Number.isFinite(Number(cfg.sessionId))
  ? Number(cfg.sessionId)
  : null;

const ALLOWED_PAIRS = new Set(["ab", "ac", "bc"]);
const SEQUENCE_STEPS = [null, "ab", "ac", "bc"];

const state = {
  live: null,
  active: null,
  pollHealthy: false,
  locked: false,
  lockReason: null,
  history: [],
  sequenceStates: [],
  historyIndex: null,
  sessionId,
};

let inputStartedAt = null;

const failedQueue = [];
let failedQueueId = 1;
let processingFailedQueue = false;

const forms = Array.from(document.querySelectorAll("[data-annotate-form]"));
const primaryForm = document.querySelector(
  '[data-annotate-form="streamlined"]',
);
const fieldControls = {
  label1: Array.from(document.querySelectorAll('[data-mirror-field="label1"]')),
  label2: Array.from(document.querySelectorAll('[data-mirror-field="label2"]')),
  notes: Array.from(document.querySelectorAll('[data-mirror-field="notes"]')),
};

const elements = {
  form: primaryForm,
  pairSwitches: Array.from(
    document.querySelectorAll('input[data-pair-switch][name="pair"]'),
  ),
  retryButton: primaryForm?.querySelector("[data-retry-button]"),
  retryCount: primaryForm?.querySelector("[data-retry-count]"),
  saveMessage: primaryForm?.querySelector("[data-save-message]"),
  indicators: Array.from(document.querySelectorAll(".annotate-indicator")),
  triadA: document.querySelector("[data-current-triad-a]"),
  triadB: document.querySelector("[data-current-triad-b]"),
  triadC: document.querySelector("[data-current-triad-c]"),
  triadImageA: document.querySelector("[data-current-triad-image-a]"),
  triadImageB: document.querySelector("[data-current-triad-image-b]"),
  triadImageC: document.querySelector("[data-current-triad-image-c]"),
  cellA: document.querySelector(".annotate-triad-cell.cell-a"),
  cellB: document.querySelector(".annotate-triad-cell.cell-b"),
  cellC: document.querySelector(".annotate-triad-cell.cell-c"),
  syncButton: document.querySelector("[data-sync-button]"),
  syncStatus: document.querySelector("[data-sync-status]"),
  lockStatus: document.querySelector("[data-lock-status]"),
  lastSaved: document.querySelector("[data-last-saved]"),
  liveGroupingDiagram: document.querySelector("[data-live-grouping-diagram]"),
  navBack: document.querySelector("[data-nav-back]"),
  navForward: document.querySelector("[data-nav-forward]"),
  navStepButtons: Array.from(document.querySelectorAll("[data-nav-step]")),
  label1Caption: document.querySelector("[data-label1-caption]"),
  label2Caption: document.querySelector("[data-label2-caption]"),
};

const getFieldValue = (key) => (fieldControls[key]?.[0]?.value || "").trim();

const setMirroredFieldValue = (key, value, source = null) => {
  const controls = fieldControls[key] || [];
  controls.forEach((control) => {
    if (control === source) return;
    if (control.value !== value) control.value = value;
  });
};

const selectionToOddForAnnotate = (selection) => {
  if (selection === "ab") return "c";
  if (selection === "ac") return "b";
  if (selection === "bc") return "a";
  return null;
};

const triadKey = (triad) => {
  if (!triad) return "";
  return `${triad.a || ""}|${triad.b || ""}|${triad.c || ""}`;
};

const cloneViewState = (viewState) => {
  if (!viewState) return null;
  const triad = viewState.triad
    ? {
        a: viewState.triad.a || "",
        b: viewState.triad.b || "",
        c: viewState.triad.c || "",
      }
    : null;
  const triadImages = viewState.triadImages
    ? {
        a: viewState.triadImages.a || null,
        b: viewState.triadImages.b || null,
        c: viewState.triadImages.c || null,
      }
    : null;
  return {
    triad,
    triadId: viewState.triadId ?? null,
    triadImages,
    selection: viewState.selection ?? null,
    displayEventId: viewState.displayEventId ?? null,
    sessionId:
      typeof viewState.sessionId === "number" ? viewState.sessionId : null,
  };
};

const getActiveView = () => state.active ?? state.live;

const normalisePair = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return ALLOWED_PAIRS.has(text) ? text : null;
};

const getSelectedPair = () => {
  const checked = elements.pairSwitches.find((input) => input.checked);
  return normalisePair(checked?.value ?? null);
};

const setSelectedPair = (pair) => {
  const value = pair ?? "";
  elements.pairSwitches.forEach((input) => {
    input.checked = input.value === value;
  });
};

const isFormDirty = () =>
  Boolean(
    getFieldValue("label1") ||
    getFieldValue("label2") ||
    getFieldValue("notes"),
  );

const clearForm = () => {
  setMirroredFieldValue("label1", "");
  setMirroredFieldValue("label2", "");
  setMirroredFieldValue("notes", "");
  inputStartedAt = null;
};

const setSaveMessage = (message, tone = "info") => {
  if (!elements.saveMessage) return;
  elements.saveMessage.textContent = message;
  elements.saveMessage.classList.remove(
    "is-visible",
    "is-warning",
    "is-success",
  );
  if (tone === "warning") elements.saveMessage.classList.add("is-warning");
  if (tone === "success") elements.saveMessage.classList.add("is-success");
  window.requestAnimationFrame(() => {
    elements.saveMessage.classList.add("is-visible");
  });
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

const updateRetryUi = () => {
  const count = failedQueue.length;
  if (elements.retryButton) elements.retryButton.hidden = count === 0;
  if (elements.retryCount) {
    elements.retryCount.textContent = count > 0 ? `${count} queued` : "";
  }
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

const removeQueuedByFingerprint = (fingerprint) => {
  if (!fingerprint) return;
  for (let i = failedQueue.length - 1; i >= 0; i -= 1) {
    if (failedQueue[i].fingerprint === fingerprint) failedQueue.splice(i, 1);
  }
};

const enqueueFailedSubmission = (payload) => {
  const fingerprint = payloadFingerprint(payload);
  if (!fingerprint) return;
  const duplicate = failedQueue.some(
    (item) => item.fingerprint === fingerprint,
  );
  if (duplicate) return;
  failedQueue.push({
    id: failedQueueId,
    payload,
    fingerprint,
    attempts: 0,
    nextAttemptAt: Date.now() + delayForRetryAttempt(0),
  });
  failedQueueId += 1;
  updateRetryUi();
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

const processFailedQueue = async () => {
  if (processingFailedQueue) return;
  if (!failedQueue.length) return;
  processingFailedQueue = true;
  try {
    let recovered = 0;
    for (const item of [...failedQueue]) {
      if (item.nextAttemptAt > Date.now()) continue;
      const ok = await sendAnnotationPayload(item.payload);
      if (ok) {
        const idx = failedQueue.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) failedQueue.splice(idx, 1);
        recovered += 1;
      } else {
        const idx = failedQueue.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) {
          failedQueue[idx].attempts += 1;
          failedQueue[idx].nextAttemptAt =
            Date.now() + delayForRetryAttempt(failedQueue[idx].attempts);
        }
      }
    }
    if (recovered > 0) {
      setSaveMessage(`Recovered ${recovered} unsaved`, "success");
      setLastSaved();
    }
    updateRetryUi();
  } finally {
    processingFailedQueue = false;
  }
};

const retryQueued = async () => {
  for (const item of failedQueue) item.nextAttemptAt = 0;
  await processFailedQueue();
};

const lockView = (reason) => {
  if (!state.locked) {
    state.locked = true;
    state.lockReason = reason;
  } else if (reason) {
    state.lockReason = reason;
  }
  if (!state.active) state.active = cloneViewState(state.live);
};

const unlockView = () => {
  state.locked = false;
  state.lockReason = null;
  state.historyIndex = null;
  state.active = cloneViewState(state.live);
};

const updateNavButtons = () => {
  const total = state.sequenceStates.length;
  const hasHistory = total > 0;
  const currentIndex =
    state.locked && state.lockReason === "navigation"
      ? Number(state.historyIndex)
      : findSequenceIndex(getActiveView(), state.sequenceStates);
  const resolvedIndex =
    Number.isFinite(currentIndex) && currentIndex >= 0 ? currentIndex : 0;
  if (elements.navBack) {
    elements.navBack.disabled = !hasHistory || resolvedIndex <= 0;
  }
  if (elements.navForward) {
    elements.navForward.disabled = !hasHistory || resolvedIndex >= total - 1;
  }
};

const updateStepButtons = (activeView) => {
  if (!elements.navStepButtons.length) return;
  const hasTriad = Boolean(activeView?.triad);
  const activeSelection = normalisePair(activeView?.selection);
  elements.navStepButtons.forEach((button) => {
    const stepRaw = button.dataset.navStep || "none";
    const stepSelection = stepRaw === "none" ? null : normalisePair(stepRaw);
    button.disabled = !hasTriad;
    button.classList.toggle("is-active", stepSelection === activeSelection);
  });
};

const setMiniDiagramState = (element, selection) => {
  if (!element) return;
  element.classList.remove("state-none", "state-ab", "state-ac", "state-bc");
  const pair = normalisePair(selection);
  const stateClass = pair ? `state-${pair}` : "state-none";
  element.classList.add(stateClass);
};

const updateLabelSemantics = (selection) => {
  const pair = normalisePair(selection);
  const odd = selectionToOddForAnnotate(pair);
  const label1Text = pair ? pair.toUpperCase() : "Label 1";
  const label2Text = odd ? odd.toUpperCase() : "Label 2";

  if (elements.label1Caption) {
    elements.label1Caption.textContent = label1Text;
    elements.label1Caption.classList.toggle("is-pair-caption", Boolean(pair));
  }
  if (elements.label2Caption) {
    elements.label2Caption.textContent = label2Text;
    elements.label2Caption.classList.toggle("is-odd-caption", Boolean(odd));
  }

  fieldControls.label1.forEach((control) => {
    control.classList.toggle("is-pair-field", Boolean(pair));
  });
  fieldControls.label2.forEach((control) => {
    control.classList.toggle("is-odd-field", Boolean(odd));
  });
};

const lockIconSvg = (locked) =>
  locked
    ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 10V8a5 5 0 0 1 10 0v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="5" y="10" width="14" height="11" rx="2" fill="currentColor" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="15.5" r="1.25" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 10V8a5 5 0 0 1 8.6-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16.5 5.5l1.8-1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="5" y="10" width="14" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="15.5" r="1.25" fill="currentColor"/></svg>';

const normaliseIndicatorLayout = () => {
  if (!elements.indicators.length) return;
  const indicatorContents = elements.indicators
    .map((indicator) => indicator.lastElementChild)
    .filter(Boolean);

  elements.indicators.forEach((indicator) => {
    indicator.style.width = "auto";
  });
  indicatorContents.forEach((content) => {
    content.style.minHeight = "";
  });

  const maxWidth = Math.ceil(
    Math.max(...elements.indicators.map((indicator) => indicator.offsetWidth)),
  );
  if (Number.isFinite(maxWidth) && maxWidth > 0) {
    elements.indicators.forEach((indicator) => {
      indicator.style.width = `${maxWidth}px`;
    });
  }

  if (!indicatorContents.length) return;
  const maxContentHeight = Math.ceil(
    Math.max(...indicatorContents.map((content) => content.offsetHeight)),
  );
  if (!Number.isFinite(maxContentHeight) || maxContentHeight <= 0) return;
  indicatorContents.forEach((content) => {
    content.style.minHeight = `${maxContentHeight}px`;
  });
};

const updateStatus = () => {
  const active = getActiveView();
  const triad = active?.triad ?? {};
  const triadImages = active?.triadImages ?? {};

  if (elements.triadA) elements.triadA.textContent = triad.a || "-";
  if (elements.triadB) elements.triadB.textContent = triad.b || "-";
  if (elements.triadC) elements.triadC.textContent = triad.c || "-";

  const imageMap = {
    a: elements.triadImageA,
    b: elements.triadImageB,
    c: elements.triadImageC,
  };
  const valueMap = {
    a: elements.triadA,
    b: elements.triadB,
    c: elements.triadC,
  };
  ["a", "b", "c"].forEach((key) => {
    const image = imageMap[key];
    const value = valueMap[key];
    const src = triadImages[key] || "";
    if (image) {
      if (src) {
        image.src = src;
        image.hidden = false;
      } else {
        image.removeAttribute("src");
        image.hidden = true;
      }
    }
    if (value) value.hidden = Boolean(src);
  });

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

  const selectedPair = normalisePair(active?.selection);
  updateLabelSemantics(selectedPair);
  if (selectedPair) {
    selectedPair.split("").forEach((key) => {
      if (cells[key]) cells[key].classList.add("is-pair");
    });
    const odd = selectionToOddForAnnotate(selectedPair);
    if (odd && cells[odd]) cells[odd].classList.add("is-odd");
  }

  if (elements.syncStatus) {
    if (state.locked) {
      elements.syncStatus.textContent = "◌";
      elements.syncStatus.title = "Polling paused";
      if (elements.syncButton) elements.syncButton.title = "Resume sync";
      elements.syncStatus.classList.add("is-warning");
      elements.syncStatus.classList.remove("is-success");
    } else if (state.pollHealthy) {
      elements.syncStatus.textContent = "◎";
      elements.syncStatus.title = "Connected";
      if (elements.syncButton) elements.syncButton.title = "Sync now";
      elements.syncStatus.classList.remove("is-warning");
      elements.syncStatus.classList.add("is-success");
    } else {
      elements.syncStatus.textContent = "⚠";
      elements.syncStatus.title = "Polling lost";
      if (elements.syncButton) elements.syncButton.title = "Retry sync";
      elements.syncStatus.classList.add("is-warning");
      elements.syncStatus.classList.remove("is-success");
    }
  }

  setMiniDiagramState(elements.liveGroupingDiagram, state.live?.selection);

  if (elements.lockStatus) {
    if (!state.locked) {
      elements.lockStatus.innerHTML = lockIconSvg(false);
      elements.lockStatus.title = "Live view";
      elements.lockStatus.classList.remove("is-warning");
      elements.lockStatus.classList.add("is-success");
    } else if (state.lockReason === "navigation") {
      elements.lockStatus.innerHTML = lockIconSvg(true);
      elements.lockStatus.title = "Locked on history";
      elements.lockStatus.classList.add("is-warning");
      elements.lockStatus.classList.remove("is-success");
    } else {
      elements.lockStatus.innerHTML = lockIconSvg(true);
      elements.lockStatus.title = "Locked while editing";
      elements.lockStatus.classList.add("is-warning");
      elements.lockStatus.classList.remove("is-success");
    }
  }

  if (!state.locked && !isFormDirty()) {
    setSelectedPair(selectedPair);
  }

  normaliseIndicatorLayout();
  updateNavButtons();
  updateStepButtons(active);
};

const toViewStateFromNowPayload = (payload) => ({
  triad: payload?.triad ?? null,
  triadId:
    typeof payload?.triad_id === "number"
      ? payload.triad_id
      : (payload?.triad_id ?? null),
  triadImages: payload?.triad_images ?? null,
  selection: normalisePair(payload?.selection),
  displayEventId:
    typeof payload?.display_event_id === "number"
      ? payload.display_event_id
      : (payload?.display_event_id ?? null),
  sessionId:
    typeof payload?.session_id === "number" ? payload.session_id : null,
});

const toViewStateFromHistoryEvent = (event, fallbackSessionId) => ({
  triad: event?.triad ?? null,
  triadId:
    typeof event?.triad_id === "number"
      ? event.triad_id
      : (event?.triad_id ?? null),
  triadImages: event?.triad_images ?? null,
  selection: normalisePair(event?.selection),
  displayEventId: typeof event?.id === "number" ? event.id : null,
  sessionId: fallbackSessionId ?? null,
});

const findSequenceIndex = (viewState, sequenceStates) => {
  if (
    !viewState?.triad ||
    !Array.isArray(sequenceStates) ||
    !sequenceStates.length
  ) {
    return -1;
  }
  const key = triadKey(viewState.triad);
  const selection = normalisePair(viewState.selection);
  const exact = sequenceStates.findIndex(
    (item) => triadKey(item.triad) === key && item.selection === selection,
  );
  if (exact >= 0) return exact;
  return sequenceStates.findIndex(
    (item) => triadKey(item.triad) === key && item.selection === null,
  );
};

const buildSequenceStates = (events, liveView, fallbackSessionId) => {
  const triadOrder = [];
  const triadMap = new Map();

  const upsertTriad = (viewState) => {
    if (!viewState?.triad) return;
    const key = triadKey(viewState.triad);
    if (!key) return;
    if (!triadMap.has(key)) {
      triadMap.set(key, {
        triad: {
          a: viewState.triad.a || "",
          b: viewState.triad.b || "",
          c: viewState.triad.c || "",
        },
        triadId:
          typeof viewState.triadId === "number"
            ? viewState.triadId
            : (viewState.triadId ?? null),
        triadImages: viewState.triadImages || null,
        displayBySelection: {
          none: null,
          ab: null,
          ac: null,
          bc: null,
        },
      });
      triadOrder.push(key);
    }
    const entry = triadMap.get(key);
    if (entry && !entry.triadImages && viewState.triadImages) {
      entry.triadImages = viewState.triadImages;
    }
    if (
      entry &&
      (entry.triadId === null || entry.triadId === undefined) &&
      (typeof viewState.triadId === "number" || viewState.triadId)
    ) {
      entry.triadId = viewState.triadId;
    }
    return entry;
  };

  for (const event of events) {
    const viewState = toViewStateFromHistoryEvent(event, fallbackSessionId);
    const entry = upsertTriad(viewState);
    if (!entry) continue;
    const selection = normalisePair(viewState.selection);
    const selectionKey = selection ?? "none";
    if (viewState.displayEventId) {
      entry.displayBySelection[selectionKey] = viewState.displayEventId;
    }
  }

  upsertTriad(liveView);

  const sequenceStates = [];
  for (const key of triadOrder) {
    const entry = triadMap.get(key);
    if (!entry) continue;
    for (const selection of SEQUENCE_STEPS) {
      const selectionKey = selection ?? "none";
      sequenceStates.push({
        triad: entry.triad,
        triadId: entry.triadId,
        triadImages: entry.triadImages,
        selection,
        displayEventId: entry.displayBySelection[selectionKey] ?? null,
        sessionId: fallbackSessionId ?? null,
      });
    }
  }
  return sequenceStates;
};

const pollNow = async () => {
  try {
    const res = await fetch(pollUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("poll-failed");
    const data = await res.json();
    state.live = toViewStateFromNowPayload(data);
    if (!state.locked) {
      state.active = cloneViewState(state.live);
    }
    state.pollHealthy = true;
    if (typeof data?.session_id === "number") state.sessionId = data.session_id;
    updateStatus();
  } catch {
    state.pollHealthy = false;
    updateStatus();
  }
};

const loadHistoryNow = async () => {
  if (state.locked && state.lockReason === "input") return;
  try {
    const res = await fetch(`${historyUrl}?limit=500`, { cache: "no-store" });
    if (!res.ok) throw new Error("history-failed");
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];
    state.history = events;
    if (typeof data?.session_id === "number") state.sessionId = data.session_id;
    const previousLockedState =
      state.locked && state.lockReason === "navigation" ? state.active : null;
    const previousIndex =
      Number.isFinite(Number(state.historyIndex)) &&
      Number(state.historyIndex) >= 0
        ? Number(state.historyIndex)
        : null;
    state.sequenceStates = buildSequenceStates(
      events,
      state.live,
      state.sessionId,
    );

    if (state.locked && state.lockReason === "navigation") {
      if (!state.sequenceStates.length) {
        state.historyIndex = null;
        state.active = cloneViewState(state.live);
      } else {
        const lockedIndex = findSequenceIndex(
          previousLockedState,
          state.sequenceStates,
        );
        const fallbackIndex =
          previousIndex !== null
            ? Math.min(previousIndex, state.sequenceStates.length - 1)
            : state.sequenceStates.length - 1;
        state.historyIndex = lockedIndex >= 0 ? lockedIndex : fallbackIndex;
        state.active = cloneViewState(state.sequenceStates[state.historyIndex]);
      }
    }
    updateStatus();
  } catch {
    updateStatus();
  }
};

const unlockAndSync = async () => {
  unlockView();
  await pollNow();
  await loadHistoryNow();
  updateStatus();
};

const goHistory = async (direction) => {
  if (!state.sequenceStates.length) {
    await loadHistoryNow();
  }
  if (!state.sequenceStates.length) return;

  let baseIndex = 0;
  if (!state.locked || state.lockReason !== "navigation") {
    const fromLiveIndex = findSequenceIndex(
      getActiveView(),
      state.sequenceStates,
    );
    baseIndex = fromLiveIndex >= 0 ? fromLiveIndex : 0;
    lockView("navigation");
  } else {
    baseIndex = Number(state.historyIndex);
    if (!Number.isFinite(baseIndex) || baseIndex < 0) baseIndex = 0;
  }

  const step = direction < 0 ? -1 : 1;
  state.historyIndex = Math.max(
    0,
    Math.min(state.sequenceStates.length - 1, baseIndex + step),
  );
  state.active = cloneViewState(state.sequenceStates[state.historyIndex]);
  updateStatus();
};

const goToStepSelection = async (selection) => {
  const targetSelection = normalisePair(selection);
  const activeView = getActiveView();
  if (!activeView?.triad) return;

  if (!state.sequenceStates.length) {
    await loadHistoryNow();
  }
  if (!state.sequenceStates.length) return;

  const activeKey = triadKey(activeView.triad);
  const targetIndex = state.sequenceStates.findIndex(
    (item) =>
      triadKey(item.triad) === activeKey &&
      normalisePair(item.selection) === targetSelection,
  );
  if (targetIndex < 0) return;

  if (!state.locked || state.lockReason !== "navigation") {
    lockView("navigation");
  }
  state.historyIndex = targetIndex;
  state.active = cloneViewState(state.sequenceStates[targetIndex]);
  updateStatus();
};

const markInputStarted = () => {
  if (!inputStartedAt) inputStartedAt = new Date().toISOString();
  if (!state.locked) {
    lockView("input");
    state.active = cloneViewState(state.live);
    updateStatus();
  }
};

const buildSubmissionPayload = () => {
  const active = getActiveView();
  const label1 = getFieldValue("label1");
  const label2 = getFieldValue("label2");
  const notes = getFieldValue("notes");
  const pair = getSelectedPair();

  return {
    label1,
    label2,
    notes,
    pair,
    triad: active?.triad ?? null,
    triad_id: active?.triadId ?? null,
    selection: active?.selection ?? null,
    display_event_id: active?.displayEventId ?? null,
    input_started_at: inputStartedAt,
    sessionId,
    source: "assistant-ui",
  };
};

const handleSubmit = async () => {
  const payload = buildSubmissionPayload();

  if (!payload.label1 || !payload.label2) {
    setSaveMessage("Label 1 and Label 2 are required", "warning");
    return;
  }

  const ok = await sendAnnotationPayload(payload);
  if (!ok) {
    enqueueFailedSubmission(payload);
    setSaveMessage("Not saved. Retrying in background.", "warning");
    return;
  }

  removeQueuedByFingerprint(payloadFingerprint(payload));
  clearForm();
  setSaveMessage("Saved", "success");
  setLastSaved();
  updateRetryUi();
  await unlockAndSync();
};

const attachHandlers = () => {
  if (!forms.length) return;

  Object.entries(fieldControls).forEach(([key, controls]) => {
    controls.forEach((control) => {
      control.addEventListener("input", () => {
        setMirroredFieldValue(key, control.value, control);
        if (!control.value.trim()) return;
        markInputStarted();
      });
    });
  });

  elements.pairSwitches.forEach((input) => {
    input.addEventListener("change", () => {
      if (!state.locked) {
        lockView("input");
        state.active = cloneViewState(state.live);
      }
      if (!state.active) state.active = cloneViewState(state.live);
      if (state.active) state.active.selection = getSelectedPair();
      updateStatus();
    });
  });

  forms.forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      handleSubmit();
    });
  });

  if (elements.retryButton) {
    elements.retryButton.addEventListener("click", retryQueued);
  }
  if (elements.navBack) {
    elements.navBack.addEventListener("click", () => goHistory(-1));
  }
  if (elements.navForward) {
    elements.navForward.addEventListener("click", () => goHistory(1));
  }
  elements.navStepButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const stepRaw = button.dataset.navStep || "none";
      const stepSelection = stepRaw === "none" ? null : stepRaw;
      goToStepSelection(stepSelection);
    });
  });
  if (elements.syncButton) {
    elements.syncButton.addEventListener("click", unlockAndSync);
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  attachHandlers();
  setSelectedPair(null);
  updateRetryUi();
  await pollNow();
  await loadHistoryNow();
  normaliseIndicatorLayout();
  window.addEventListener("resize", normaliseIndicatorLayout);
  window.setInterval(pollNow, 1000);
  window.setInterval(loadHistoryNow, 3000);
  window.setInterval(processFailedQueue, 1500);
});
