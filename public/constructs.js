const cfg = window.__CONSTRUCTS_CFG || {};
const apiBase = String(cfg.apiBase || "/api/constructs").replace(/\/+$/, "");

const toPositiveIntOrNull = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const defaultSessionId = toPositiveIntOrNull(cfg.sessionId);

const POLARITY_CLASS_NAMES = [
  "polarity-unknown",
  "polarity-positive",
  "polarity-negative",
  "polarity-neutral",
  "polarity-positive-absence-presence",
  "polarity-negative-absence-presence",
];

const ALLOWED_POLARITIES = new Set([
  "unknown",
  "positive",
  "negative",
  "neutral",
  "positive-absence-presence",
  "negative-absence-presence",
]);

const normalisePolarity = (value) => {
  const text = String(value ?? "unknown")
    .trim()
    .toLowerCase();
  return ALLOWED_POLARITIES.has(text) ? text : "unknown";
};

const polarityToButtonValue = (polarity) => {
  if (polarity === "positive" || polarity === "positive-absence-presence") {
    return "positive";
  }
  if (polarity === "negative" || polarity === "negative-absence-presence") {
    return "negative";
  }
  if (polarity === "neutral") return "neutral";
  return null;
};

const polarityToSymbol = (polarity) => {
  if (polarity === "positive" || polarity === "positive-absence-presence") {
    return "positive";
  }
  if (polarity === "negative" || polarity === "negative-absence-presence") {
    return "negative";
  }
  if (polarity === "neutral") return "neutral";
  return null;
};

const symbolSvgByType = {
  positive:
    '<svg class="construct-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="4" y1="12" x2="20" y2="12"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>',
  negative:
    '<svg class="construct-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="4" y1="12" x2="20" y2="12"></line></svg>',
  neutral:
    '<svg class="construct-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7"></circle></svg>',
};

const relationshipSvgByType = {
  both: '<svg class="construct-relationship-symbol" viewBox="0 0 120 24" aria-hidden="true" focusable="false"><line x1="14" y1="12" x2="106" y2="12"></line><path d="M22 6 L14 12 L22 18"></path><path d="M98 6 L106 12 L98 18"></path></svg>',
  left: '<svg class="construct-relationship-symbol" viewBox="0 0 120 24" aria-hidden="true" focusable="false"><line x1="14" y1="12" x2="106" y2="12"></line><path d="M22 6 L14 12 L22 18"></path></svg>',
  right:
    '<svg class="construct-relationship-symbol" viewBox="0 0 120 24" aria-hidden="true" focusable="false"><line x1="14" y1="12" x2="106" y2="12"></line><path d="M98 6 L106 12 L98 18"></path></svg>',
  line: '<svg class="construct-relationship-symbol" viewBox="0 0 120 24" aria-hidden="true" focusable="false"><line x1="18" y1="12" x2="102" y2="12"></line></svg>',
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const getConstructId = (card) =>
  toPositiveIntOrNull(card?.dataset?.constructId);

const getParentConstructId = (card) =>
  toPositiveIntOrNull(card?.dataset?.derivedFromConstructId);

const getVoteScore = (card) => {
  const parsed = Number.parseInt(String(card?.dataset?.voteScore ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const setVoteScore = (card, nextScore) => {
  const score = Number.isFinite(Number(nextScore))
    ? Math.trunc(Number(nextScore))
    : 0;
  card.dataset.voteScore = String(score);
  const scoreLabel = card.querySelector("[data-vote-score]");
  if (scoreLabel) scoreLabel.textContent = String(score);
};

const updateConstructSummaryCount = () => {
  const countNode = document.querySelector("[data-construct-count]");
  if (!countNode) return;

  const count = document.querySelectorAll(
    ".construct-card[data-construct-id]:not(.is-draft)",
  ).length;
  countNode.textContent = String(count);

  const suffixNode = document.querySelector("[data-construct-count-suffix]");
  if (suffixNode) suffixNode.textContent = count === 1 ? "" : "s";

  const summary = document.querySelector("[data-constructs-summary]");
  const summaryTextNode = document.querySelector("[data-session-summary-text]");
  if (summary && summaryTextNode) {
    summaryTextNode.textContent = String(summary.dataset.sessionSummary ?? "");
  }
};

const applyOriginGrouping = () => {
  const list = document.querySelector(".constructs-list");
  if (!list) return;

  const draftsByParent = new Map();
  const orphanDrafts = [];
  const existingDrafts = Array.from(
    list.querySelectorAll(".construct-card.is-draft"),
  );
  existingDrafts.forEach((draft) => {
    const parentId = toPositiveIntOrNull(draft.dataset.parentConstructId);
    if (parentId === null) {
      orphanDrafts.push(draft);
      return;
    }
    if (!draftsByParent.has(parentId)) draftsByParent.set(parentId, []);
    draftsByParent.get(parentId).push(draft);
  });

  const cards = Array.from(
    list.querySelectorAll(".construct-card[data-construct-id]:not(.is-draft)"),
  );
  if (!cards.length) {
    const fragment = document.createDocumentFragment();
    for (const drafts of draftsByParent.values()) {
      drafts.forEach((draft) => fragment.append(draft));
    }
    orphanDrafts.forEach((draft) => fragment.append(draft));
    list.innerHTML = "";
    list.append(fragment);
    updateConstructSummaryCount();
    return;
  }

  const idToCard = new Map();
  cards.forEach((card) => {
    const id = getConstructId(card);
    if (id === null) return;
    idToCard.set(id, card);
  });

  const rootCache = new Map();
  const depthCache = new Map();
  const resolveRootAndDepth = (cardId, seen = new Set()) => {
    if (rootCache.has(cardId) && depthCache.has(cardId)) {
      return {
        rootId: rootCache.get(cardId),
        depth: depthCache.get(cardId),
      };
    }
    const card = idToCard.get(cardId);
    if (!card) {
      rootCache.set(cardId, cardId);
      depthCache.set(cardId, 0);
      return { rootId: cardId, depth: 0 };
    }

    const parentId = getParentConstructId(card);
    if (
      parentId === null ||
      !idToCard.has(parentId) ||
      parentId === cardId ||
      seen.has(cardId)
    ) {
      rootCache.set(cardId, cardId);
      depthCache.set(cardId, 0);
      return { rootId: cardId, depth: 0 };
    }

    seen.add(cardId);
    const parent = resolveRootAndDepth(parentId, seen);
    const depth = parent.depth + 1;
    rootCache.set(cardId, parent.rootId);
    depthCache.set(cardId, depth);
    return { rootId: parent.rootId, depth };
  };

  const entries = [];
  for (const card of cards) {
    const id = getConstructId(card);
    if (id === null) continue;
    const { rootId, depth } = resolveRootAndDepth(id);
    entries.push({ card, id, rootId, depth, score: getVoteScore(card) });
  }

  entries.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return right.id - left.id;
  });

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const { card, depth, id, rootId } = entry;
    card.dataset.originRoot = String(rootId);
    card.dataset.originDepth = String(depth);
    card.style.setProperty("--construct-origin-depth", String(depth));
    card.classList.toggle("is-origin-root", depth === 0);
    card.classList.toggle("is-derived", depth > 0);
    fragment.append(card);

    const drafts = draftsByParent.get(id) ?? [];
    drafts.forEach((draft) => fragment.append(draft));
    draftsByParent.delete(id);
  }

  for (const drafts of draftsByParent.values()) {
    drafts.forEach((draft) => fragment.append(draft));
  }
  if (orphanDrafts.length) {
    orphanDrafts.forEach((draft) => fragment.append(draft));
  }

  list.innerHTML = "";
  list.append(fragment);
  updateConstructSummaryCount();
};

const setInlineMessage = (card, message, tone = "info") => {
  const slot = card.querySelector("[data-inline-editor]");
  if (!slot) return;
  slot.textContent = message || "";
  slot.classList.remove("is-error", "is-success");
  if (tone === "error") slot.classList.add("is-error");
  if (tone === "success") slot.classList.add("is-success");
};

const setCardBusy = (card, busy) => {
  card.classList.toggle("is-saving", Boolean(busy));
  const controls = card.querySelectorAll(
    "[data-polarity-button], [data-polarity-reset], [data-save-draft], [data-duplicate-construct], [data-vote-construct], [data-hide-construct], [data-label-input]",
  );
  controls.forEach((control) => {
    control.disabled = Boolean(busy);
  });
};

const getPolePolarityFromCard = (card, pole) => {
  if (pole === "label1") return normalisePolarity(card.dataset.label1Polarity);
  return normalisePolarity(card.dataset.label2Polarity);
};

const syncPoleMode = (card, pole, polarity) => {
  const controls = card.querySelector(
    `[data-polarity-controls][data-pole="${pole}"]`,
  );
  const reset = card.querySelector(
    `[data-polarity-reset][data-pole="${pole}"]`,
  );
  const showReset = normalisePolarity(polarity) !== "unknown";
  if (controls) controls.classList.toggle("is-hidden", showReset);
  if (reset) reset.classList.toggle("is-hidden", !showReset);
};

const isSignedSymbol = (symbol) =>
  symbol === "positive" || symbol === "negative";

const resolveRelationshipType = (leftPolarity, rightPolarity) => {
  const leftSymbol = polarityToSymbol(leftPolarity);
  const rightSymbol = polarityToSymbol(rightPolarity);

  if (leftSymbol === "neutral" && isSignedSymbol(rightSymbol)) return "right";
  if (rightSymbol === "neutral" && isSignedSymbol(leftSymbol)) return "left";
  if (isSignedSymbol(leftSymbol) && isSignedSymbol(rightSymbol)) return "both";
  if (leftSymbol === "neutral" && rightSymbol === "neutral") return "line";
  return "line";
};

const syncRelationshipSymbol = (card) => {
  const slot = card.querySelector("[data-relationship-symbol]");
  if (!slot) return;
  const left = getPolePolarityFromCard(card, "label1");
  const right = getPolePolarityFromCard(card, "label2");
  const relationshipType = resolveRelationshipType(left, right);
  slot.innerHTML = relationshipSvgByType[relationshipType] ?? "";
};

const applyPolarityToPole = (card, pole, nextPolarity) => {
  const polarity = normalisePolarity(nextPolarity);
  if (pole === "label1") {
    card.dataset.label1Polarity = polarity;
  } else {
    card.dataset.label2Polarity = polarity;
  }

  const label = card.querySelector(`.construct-label[data-pole="${pole}"]`);
  if (label) {
    label.dataset.polarity = polarity;
    label.classList.remove(...POLARITY_CLASS_NAMES);
    label.classList.add(`polarity-${polarity}`);
  }

  const icon = card.querySelector(`[data-polarity-icon][data-pole="${pole}"]`);
  if (icon) {
    icon.dataset.polarity = polarity;
    icon.classList.remove(...POLARITY_CLASS_NAMES);
    icon.classList.add(`polarity-${polarity}`);
    const symbolSlot = icon.querySelector("[data-polarity-symbol]");
    if (symbolSlot) {
      const symbolType = polarityToSymbol(polarity);
      symbolSlot.innerHTML = symbolType ? symbolSvgByType[symbolType] : "";
    }
  }

  const activeButtonValue = polarityToButtonValue(polarity);
  const buttons = card.querySelectorAll(
    `[data-polarity-button][data-pole="${pole}"]`,
  );
  buttons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      Boolean(
        activeButtonValue && button.dataset.polarity === activeButtonValue,
      ),
    );
  });

  syncPoleMode(card, pole, polarity);
  syncRelationshipSymbol(card);
};

const syncCardUiFromData = (card) => {
  applyPolarityToPole(card, "label1", getPolePolarityFromCard(card, "label1"));
  applyPolarityToPole(card, "label2", getPolePolarityFromCard(card, "label2"));
};

const appendPolarityEvent = async (card, pole, requestedPolarity) => {
  const constructId = Number.parseInt(
    String(card.dataset.constructId ?? ""),
    10,
  );
  if (!Number.isFinite(constructId) || constructId <= 0) return null;

  const nextLabel1 =
    pole === "label1"
      ? normalisePolarity(requestedPolarity)
      : getPolePolarityFromCard(card, "label1");
  const nextLabel2 =
    pole === "label2"
      ? normalisePolarity(requestedPolarity)
      : getPolePolarityFromCard(card, "label2");

  const response = await fetch(`${apiBase}/${constructId}/polarity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label1_polarity: nextLabel1,
      label2_polarity: nextLabel2,
      source: "manual",
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.ok) return null;
  return data;
};

const appendHideEvent = async (card) => {
  const constructId = Number.parseInt(
    String(card.dataset.constructId ?? ""),
    10,
  );
  if (!Number.isFinite(constructId) || constructId <= 0) return null;

  const response = await fetch(`${apiBase}/${constructId}/hide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "manual",
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.ok) return null;
  return data;
};

const appendVoteEvent = async (card, voteDelta) => {
  const constructId = Number.parseInt(
    String(card.dataset.constructId ?? ""),
    10,
  );
  if (!Number.isFinite(constructId) || constructId <= 0) return null;
  const normalizedDelta = Number(voteDelta) < 0 ? -1 : 1;

  const response = await fetch(`${apiBase}/${constructId}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vote_delta: normalizedDelta,
      source: "manual",
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.ok) return null;
  return data;
};

const createConstructEvent = async ({
  label1,
  label2,
  createdFromConstructId,
  originSessionId,
}) => {
  const response = await fetch(apiBase, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label1,
      label2,
      created_from_construct_id: createdFromConstructId,
      origin_session_id: originSessionId,
      origin_type: createdFromConstructId ? "derived" : "manual",
    }),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || !data?.ok || !data?.construct) {
    return {
      ok: false,
      error: data?.error || "create-failed",
    };
  }

  return {
    ok: true,
    construct: data.construct,
  };
};

const buildDraftCard = (sourceCard) => {
  const sourceConstructId = toPositiveIntOrNull(sourceCard.dataset.constructId);
  const sourceSessionId =
    toPositiveIntOrNull(sourceCard.dataset.sourceSessionId) || defaultSessionId;
  const sourceDepth = toPositiveIntOrNull(sourceCard.dataset.originDepth) ?? 0;
  const label1 = String(sourceCard.dataset.label1 ?? "").trim();
  const label2 = String(sourceCard.dataset.label2 ?? "").trim();

  const draft = document.createElement("article");
  draft.className = "construct-card is-draft is-derived";
  draft.dataset.parentConstructId =
    sourceConstructId !== null ? String(sourceConstructId) : "";
  draft.dataset.sourceSessionId =
    sourceSessionId !== null ? String(sourceSessionId) : "";
  draft.dataset.originDepth = String(sourceDepth + 1);
  draft.style.setProperty("--construct-origin-depth", String(sourceDepth + 1));
  draft.dataset.label1Polarity = "unknown";
  draft.dataset.label2Polarity = "unknown";

  draft.innerHTML = `
    <div class="construct-row">
      <div class="construct-side construct-side-left is-draft-side" data-pole="label1">
        <label class="construct-label polarity-unknown is-editable" data-pole="label1" data-polarity="unknown">
          <input
            type="text"
            class="construct-label-input"
            data-label-input
            data-pole="label1"
            value="${escapeHtml(label1)}"
            placeholder="Left label"
            aria-label="New left label"
          />
        </label>
      </div>
      <div class="construct-relationship" data-relationship>
        <span class="construct-relationship-symbol-slot" data-relationship-symbol></span>
      </div>
      <div class="construct-side construct-side-right is-draft-side" data-pole="label2">
        <label class="construct-label polarity-unknown is-editable" data-pole="label2" data-polarity="unknown">
          <input
            type="text"
            class="construct-label-input"
            data-label-input
            data-pole="label2"
            value="${escapeHtml(label2)}"
            placeholder="Right label"
            aria-label="New right label"
          />
        </label>
      </div>
    </div>
    <div class="construct-inline-slot" data-inline-editor></div>
    <div class="construct-card-footer">
      <div class="construct-card-controls is-draft-controls" role="group" aria-label="Draft controls">
        <button type="button" class="construct-control-button is-save" data-save-draft>Save</button>
      </div>
    </div>
  `;

  return draft;
};

const hydrateSavedCardFromTemplate = (templateCard, construct) => {
  const nextCard = templateCard.cloneNode(true);
  nextCard.classList.remove("is-draft", "is-saving");
  nextCard.removeAttribute("data-parent-construct-id");

  nextCard.dataset.constructId = String(construct.id);
  nextCard.dataset.label1 = construct.label1;
  nextCard.dataset.label2 = construct.label2;
  nextCard.dataset.label1Polarity = normalisePolarity(
    construct.label1_polarity,
  );
  nextCard.dataset.label2Polarity = normalisePolarity(
    construct.label2_polarity,
  );
  nextCard.dataset.sourceSessionId =
    construct.source_session_id === null ||
    construct.source_session_id === undefined
      ? ""
      : String(construct.source_session_id);
  setVoteScore(nextCard, Number(construct.vote_score ?? 0));
  nextCard.dataset.derivedFromConstructId =
    construct.derived_from_construct_id === null ||
    construct.derived_from_construct_id === undefined
      ? ""
      : String(construct.derived_from_construct_id);

  const label1Text = nextCard.querySelector(
    '.construct-label[data-pole="label1"] .construct-label-text',
  );
  if (label1Text) label1Text.textContent = construct.label1;

  const label2Text = nextCard.querySelector(
    '.construct-label[data-pole="label2"] .construct-label-text',
  );
  if (label2Text) label2Text.textContent = construct.label2;

  setInlineMessage(nextCard, "");
  return nextCard;
};

const removeCardAndAttachedDrafts = (card) => {
  const constructId = String(card.dataset.constructId ?? "");
  const list = document.querySelector(".constructs-list");
  if (list && constructId) {
    const attachedDrafts = list.querySelectorAll(
      `.construct-card.is-draft[data-parent-construct-id="${constructId}"]`,
    );
    attachedDrafts.forEach((draft) => draft.remove());
  }
  card.remove();
};

const handlePolarityButtonClick = async (button) => {
  const card = button.closest(".construct-card[data-construct-id]");
  if (!card || card.classList.contains("is-draft")) return;

  const pole = button.dataset.pole === "label2" ? "label2" : "label1";
  const requestedPolarity = normalisePolarity(button.dataset.polarity);

  setInlineMessage(card, "");
  setCardBusy(card, true);
  try {
    const result = await appendPolarityEvent(card, pole, requestedPolarity);
    if (!result) {
      setInlineMessage(card, "Save failed. Retry.", "error");
      return;
    }

    applyPolarityToPole(card, "label1", result.label1_polarity);
    applyPolarityToPole(card, "label2", result.label2_polarity);
    setInlineMessage(card, "Saved", "success");
  } catch {
    setInlineMessage(card, "Save failed. Retry.", "error");
  } finally {
    setCardBusy(card, false);
  }
};

const handlePolarityResetClick = async (button) => {
  const card = button.closest(".construct-card[data-construct-id]");
  if (!card || card.classList.contains("is-draft")) return;

  const pole = button.dataset.pole === "label2" ? "label2" : "label1";
  const currentPolarity = getPolePolarityFromCard(card, pole);
  if (currentPolarity === "unknown") return;

  setInlineMessage(card, "");
  setCardBusy(card, true);
  try {
    const result = await appendPolarityEvent(card, pole, "unknown");
    if (!result) {
      setInlineMessage(card, "Reset failed. Retry.", "error");
      return;
    }

    applyPolarityToPole(card, "label1", result.label1_polarity);
    applyPolarityToPole(card, "label2", result.label2_polarity);
    setInlineMessage(card, "Reset", "success");
  } catch {
    setInlineMessage(card, "Reset failed. Retry.", "error");
  } finally {
    setCardBusy(card, false);
  }
};

const handleHideConstructClick = async (button) => {
  const card = button.closest(".construct-card[data-construct-id]");
  if (!card || card.classList.contains("is-draft")) return;

  setInlineMessage(card, "");
  setCardBusy(card, true);
  try {
    const result = await appendHideEvent(card);
    if (!result) {
      setInlineMessage(card, "Hide failed. Retry.", "error");
      return;
    }

    removeCardAndAttachedDrafts(card);
    applyOriginGrouping();
  } catch {
    setInlineMessage(card, "Hide failed. Retry.", "error");
  } finally {
    if (card.isConnected) setCardBusy(card, false);
  }
};

const handleVoteConstructClick = async (button) => {
  const card = button.closest(".construct-card[data-construct-id]");
  if (!card || card.classList.contains("is-draft")) return;

  const voteDelta = Number(button.dataset.voteDelta ?? "0") < 0 ? -1 : 1;
  setInlineMessage(card, "");
  setCardBusy(card, true);
  try {
    const result = await appendVoteEvent(card, voteDelta);
    if (!result) {
      setInlineMessage(card, "Vote failed. Retry.", "error");
      return;
    }

    setVoteScore(
      card,
      Number(result.vote_score ?? getVoteScore(card) + voteDelta),
    );
    applyOriginGrouping();
  } catch {
    setInlineMessage(card, "Vote failed. Retry.", "error");
  } finally {
    if (card.isConnected) setCardBusy(card, false);
  }
};

const handleDuplicateConstructClick = (button) => {
  const sourceCard = button.closest(".construct-card[data-construct-id]");
  if (!sourceCard || sourceCard.classList.contains("is-draft")) return;

  const sourceId = String(sourceCard.dataset.constructId ?? "");
  const nextCard = sourceCard.nextElementSibling;
  if (
    nextCard?.matches(".construct-card.is-draft") &&
    String(nextCard.dataset.parentConstructId ?? "") === sourceId
  ) {
    const input = nextCard.querySelector(
      '[data-label-input][data-pole="label1"]',
    );
    if (input) input.focus();
    return;
  }

  const draftCard = buildDraftCard(sourceCard);
  sourceCard.insertAdjacentElement("afterend", draftCard);
  syncCardUiFromData(draftCard);

  const input = draftCard.querySelector(
    '[data-label-input][data-pole="label1"]',
  );
  if (input) input.focus();
};

const findTemplateCardForDraft = (draftCard) => {
  const parentId = String(draftCard.dataset.parentConstructId ?? "");
  if (!parentId) {
    return document.querySelector(
      ".construct-card[data-construct-id]:not(.is-draft)",
    );
  }
  return (
    document.querySelector(
      `.construct-card[data-construct-id="${parentId}"]:not(.is-draft)`,
    ) ||
    document.querySelector(".construct-card[data-construct-id]:not(.is-draft)")
  );
};

const handleSaveDraftClick = async (button) => {
  const draftCard = button.closest(".construct-card.is-draft");
  if (!draftCard) return;

  const label1Input = draftCard.querySelector(
    '[data-label-input][data-pole="label1"]',
  );
  const label2Input = draftCard.querySelector(
    '[data-label-input][data-pole="label2"]',
  );
  const label1 = String(label1Input?.value ?? "").trim();
  const label2 = String(label2Input?.value ?? "").trim();

  if (!label1 || !label2) {
    setInlineMessage(draftCard, "Both labels are required.", "error");
    if (!label1 && label1Input) label1Input.focus();
    if (label1 && !label2 && label2Input) label2Input.focus();
    return;
  }

  const parentConstructId = toPositiveIntOrNull(
    draftCard.dataset.parentConstructId,
  );
  const sourceSessionId = toPositiveIntOrNull(
    draftCard.dataset.sourceSessionId,
  );
  const originSessionId = sourceSessionId || defaultSessionId;

  setInlineMessage(draftCard, "");
  setCardBusy(draftCard, true);
  try {
    const created = await createConstructEvent({
      label1,
      label2,
      createdFromConstructId: parentConstructId,
      originSessionId,
    });

    if (!created.ok || !created.construct) {
      setInlineMessage(draftCard, "Save failed. Retry.", "error");
      return;
    }

    const templateCard = findTemplateCardForDraft(draftCard);
    if (!templateCard) {
      setInlineMessage(draftCard, "Saved. Refresh to view.", "success");
      return;
    }

    const savedCard = hydrateSavedCardFromTemplate(
      templateCard,
      created.construct,
    );
    draftCard.replaceWith(savedCard);
    applyOriginGrouping();
    syncCardUiFromData(savedCard);
    setInlineMessage(savedCard, "Saved", "success");
  } catch {
    setInlineMessage(draftCard, "Save failed. Retry.", "error");
  } finally {
    if (draftCard.isConnected) setCardBusy(draftCard, false);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  applyOriginGrouping();

  const cards = Array.from(
    document.querySelectorAll(".construct-card[data-construct-id]"),
  );
  cards.forEach(syncCardUiFromData);

  document.addEventListener("click", (event) => {
    const hide = event.target.closest("[data-hide-construct]");
    if (hide) {
      handleHideConstructClick(hide);
      return;
    }

    const vote = event.target.closest("[data-vote-construct]");
    if (vote) {
      handleVoteConstructClick(vote);
      return;
    }

    const duplicate = event.target.closest("[data-duplicate-construct]");
    if (duplicate) {
      handleDuplicateConstructClick(duplicate);
      return;
    }

    const saveDraft = event.target.closest("[data-save-draft]");
    if (saveDraft) {
      handleSaveDraftClick(saveDraft);
      return;
    }

    const reset = event.target.closest("[data-polarity-reset]");
    if (reset) {
      handlePolarityResetClick(reset);
      return;
    }

    const button = event.target.closest("[data-polarity-button]");
    if (!button) return;
    handlePolarityButtonClick(button);
  });
});
