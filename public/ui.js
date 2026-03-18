(() => {
  const SEQUENCE_STEPS = [null, "ab", "ac", "bc"];
  const ALLOWED_PAIRS = new Set(["ab", "ac", "bc"]);

  const cfg = window.__COMBO_LOG || {};
  const logUrl = cfg.url || "/display/log";
  const historyUrl = cfg.historyUrl || "/display/history";
  const nextTriadUrl = cfg.nextTriadUrl || "/display";

  const normalisePair = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().toLowerCase();
    return ALLOWED_PAIRS.has(text) ? text : null;
  };

  const selectionToOdd = (selection) => {
    if (selection === "ab") return "c";
    if (selection === "ac") return "b";
    if (selection === "bc") return "a";
    return null;
  };

  const triadKey = (triad) => {
    if (!triad) return "";
    const a = String(triad.a || "").trim();
    const b = String(triad.b || "").trim();
    const c = String(triad.c || "").trim();
    return `${a}|${b}|${c}`;
  };

  const sanitiseTriad = (triad) => {
    if (!triad || typeof triad !== "object") return null;
    const a = String(triad.a || "").trim();
    const b = String(triad.b || "").trim();
    const c = String(triad.c || "").trim();
    if (!a || !b || !c) return null;
    return { a, b, c };
  };

  const cloneTriad = (triad) => {
    const stored = sanitiseTriad(triad);
    if (!stored) return null;
    return { a: stored.a, b: stored.b, c: stored.c };
  };

  const cloneImageMap = (images) => {
    if (!images || typeof images !== "object") return null;
    const next = {
      a: images.a ? String(images.a) : null,
      b: images.b ? String(images.b) : null,
      c: images.c ? String(images.c) : null,
    };
    return next.a || next.b || next.c ? next : null;
  };

  const state = {
    sequenceStates: [],
    index: 0,
  };

  const elements = {
    stage: document.querySelector("[data-display-stage]"),
    backBtn: document.querySelector("[data-seq-back]"),
    forwardBtn: document.querySelector("[data-seq-forward]"),
    stepButtons: Array.from(document.querySelectorAll("[data-seq-step]")),
    cards: {
      a: document.querySelector('.triad-card[data-triad="a"]'),
      b: document.querySelector('.triad-card[data-triad="b"]'),
      c: document.querySelector('.triad-card[data-triad="c"]'),
    },
    images: {
      a: document.querySelector('[data-triad-image="a"]'),
      b: document.querySelector('[data-triad-image="b"]'),
      c: document.querySelector('[data-triad-image="c"]'),
    },
    missing: {
      a: document.querySelector('[data-triad-missing="a"]'),
      b: document.querySelector('[data-triad-missing="b"]'),
      c: document.querySelector('[data-triad-missing="c"]'),
    },
    imageIds: {
      a: document.querySelector('[data-triad-image-id="a"]'),
      b: document.querySelector('[data-triad-image-id="b"]'),
      c: document.querySelector('[data-triad-image-id="c"]'),
    },
  };

  const getActiveView = () => {
    if (!state.sequenceStates.length) return null;
    const safeIndex = Math.max(
      0,
      Math.min(state.sequenceStates.length - 1, state.index),
    );
    return state.sequenceStates[safeIndex] || null;
  };

  const updateCardOverlay = (selection) => {
    Object.values(elements.cards).forEach((card) => {
      if (!card) return;
      card.classList.remove("is-pair", "is-odd");
      const pairTag = card.querySelector(".annotation-tag-pair");
      const oddTag = card.querySelector(".annotation-tag-odd");
      if (pairTag) {
        pairTag.textContent = "";
        pairTag.classList.remove("is-visible");
      }
      if (oddTag) {
        oddTag.textContent = "";
        oddTag.classList.remove("is-visible");
      }
    });

    if (!selection) return;

    selection.split("").forEach((key) => {
      const card = elements.cards[key];
      if (!card) return;
      card.classList.add("is-pair");
      // const tag = card.querySelector(".annotation-tag-pair");
      // if (tag) {
      //   tag.textContent = "PAIR";
      //   tag.classList.add("is-visible");
      // }
    });

    const odd = selectionToOdd(selection);
    if (odd && elements.cards[odd]) {
      elements.cards[odd].classList.add("is-odd");
      // const tag = elements.cards[odd].querySelector(".annotation-tag-odd");
      // if (tag) {
      //   tag.textContent = "ODD";
      //   tag.classList.add("is-visible");
      // }
    }
  };

  const setForwardNextTriadReady = (ready) => {
    if (!elements.forwardBtn) return;
    elements.forwardBtn.classList.toggle("is-next-triad-ready", Boolean(ready));
    if (ready) {
      elements.forwardBtn.title = "Next click: new triad";
      elements.forwardBtn.setAttribute("aria-label", "Open new triad form");
    } else {
      elements.forwardBtn.title = "Next display state";
      elements.forwardBtn.setAttribute("aria-label", "Next display state");
    }
  };

  const updateNavUi = (selection) => {
    const total = state.sequenceStates.length;
    const hasStates = total > 0;
    const atStart = !hasStates || state.index <= 0;
    const atEnd = hasStates && state.index >= total - 1;

    if (elements.backBtn) {
      elements.backBtn.disabled = atStart;
    }

    if (elements.forwardBtn) {
      elements.forwardBtn.disabled = !hasStates;
    }
    setForwardNextTriadReady(atEnd && hasStates);

    elements.stepButtons.forEach((button) => {
      const stepRaw = button.dataset.seqStep || "none";
      const stepSelection = stepRaw === "none" ? null : normalisePair(stepRaw);
      button.disabled = !hasStates;
      button.classList.toggle("is-active", stepSelection === selection);
    });
  };

  const renderTriad = (viewState) => {
    const triad = sanitiseTriad(viewState?.triad);
    const triadImages = cloneImageMap(viewState?.triadImages) || {};

    ["a", "b", "c"].forEach((key) => {
      const triadValue = triad?.[key] || "";
      const imageSrc = triadImages[key] || "";

      if (elements.stage) {
        elements.stage.dataset[`triad${key.toUpperCase()}`] = triadValue;
      }

      const image = elements.images[key];
      if (image) {
        if (imageSrc) {
          image.src = imageSrc;
          image.hidden = false;
        } else {
          image.removeAttribute("src");
          image.hidden = true;
        }
      }

      const missing = elements.missing[key];
      if (missing) {
        missing.hidden = Boolean(imageSrc);
      }

      const imageId = elements.imageIds[key];
      if (imageId) {
        imageId.textContent = triadValue || "empty";
      }
    });
  };

  const buildSequenceStates = (events, fallbackView) => {
    const triadOrder = [];
    const triadMap = new Map();

    const upsertTriad = (viewState) => {
      const triad = sanitiseTriad(viewState?.triad);
      if (!triad) return null;

      const key = triadKey(triad);
      if (!triadMap.has(key)) {
        triadMap.set(key, {
          triad,
          triadImages: cloneImageMap(viewState?.triadImages),
        });
        triadOrder.push(key);
        return triadMap.get(key);
      }

      const existing = triadMap.get(key);
      if (!existing.triadImages) {
        const nextImages = cloneImageMap(viewState?.triadImages);
        if (nextImages) existing.triadImages = nextImages;
      }
      return existing;
    };

    for (const event of events) {
      upsertTriad({ triad: event?.triad, triadImages: event?.triad_images });
    }

    const fallbackTriad = sanitiseTriad(fallbackView?.triad);
    const fallbackKey = triadKey(fallbackTriad);
    const fallbackEntry = upsertTriad(fallbackView);
    if (fallbackEntry && fallbackKey) {
      const existingIndex = triadOrder.indexOf(fallbackKey);
      if (existingIndex >= 0) triadOrder.splice(existingIndex, 1);
      triadOrder.push(fallbackKey);
    }

    const sequenceStates = [];
    for (const key of triadOrder) {
      const entry = triadMap.get(key);
      if (!entry) continue;
      for (const selection of SEQUENCE_STEPS) {
        sequenceStates.push({
          triad: cloneTriad(entry.triad),
          triadImages: cloneImageMap(entry.triadImages),
          selection,
        });
      }
    }

    return sequenceStates;
  };

  const findStateIndexForTriadSelection = (triad, selection) => {
    if (!state.sequenceStates.length) return -1;
    const key = triadKey(triad);
    const pair = normalisePair(selection);
    const exact = state.sequenceStates.findIndex(
      (item) => triadKey(item.triad) === key && item.selection === pair,
    );
    if (exact >= 0) return exact;
    return state.sequenceStates.findIndex(
      (item) => triadKey(item.triad) === key && item.selection === null,
    );
  };

  const logCombo = async (viewState) => {
    if (!logUrl) return;
    const triad = sanitiseTriad(viewState?.triad);
    if (!triad) return;

    try {
      await fetch(logUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          triad,
          selectedPair: normalisePair(viewState?.selection),
          sessionId: cfg.sessionId,
        }),
      });
    } catch {
      // Ignore logging errors.
    }
  };

  const applyStateByIndex = (nextIndex, options = {}) => {
    if (!state.sequenceStates.length) {
      updateCardOverlay(null);
      updateNavUi(null);
      return;
    }

    const shouldLog = Boolean(options.log);
    state.index = Math.max(
      0,
      Math.min(state.sequenceStates.length - 1, nextIndex),
    );
    const active = getActiveView();
    const selection = normalisePair(active?.selection);

    renderTriad(active);
    updateCardOverlay(selection);
    updateNavUi(selection);

    if (shouldLog) {
      logCombo(active);
    }
  };

  const goHistory = (direction) => {
    if (!state.sequenceStates.length) return;
    const step = direction < 0 ? -1 : 1;
    const nextIndex = Math.max(
      0,
      Math.min(state.sequenceStates.length - 1, state.index + step),
    );
    if (nextIndex === state.index) return;
    applyStateByIndex(nextIndex, { log: true });
  };

  const goToStepSelection = (selection) => {
    const active = getActiveView();
    const activeTriad = sanitiseTriad(active?.triad);
    if (!activeTriad) return;

    const target = findStateIndexForTriadSelection(activeTriad, selection);
    if (target < 0 || target === state.index) return;
    applyStateByIndex(target, { log: true });
  };

  const loadHistory = async () => {
    const fallbackTriad = sanitiseTriad(cfg.triad);
    const fallbackImages = {
      a: elements.images.a?.getAttribute("src") || null,
      b: elements.images.b?.getAttribute("src") || null,
      c: elements.images.c?.getAttribute("src") || null,
    };
    const fallbackView = {
      triad: fallbackTriad,
      triadImages: cloneImageMap(fallbackImages),
    };

    try {
      const res = await fetch(`${historyUrl}?limit=500`, { cache: "no-store" });
      if (!res.ok) throw new Error("history-failed");
      const data = await res.json();
      const events = Array.isArray(data?.events) ? data.events : [];
      state.sequenceStates = buildSequenceStates(events, fallbackView);
    } catch {
      state.sequenceStates = buildSequenceStates([], fallbackView);
    }

    if (!state.sequenceStates.length && fallbackTriad) {
      state.sequenceStates = SEQUENCE_STEPS.map((selection) => ({
        triad: cloneTriad(fallbackTriad),
        triadImages: cloneImageMap(fallbackImages),
        selection,
      }));
    }

    const desiredSelection = normalisePair(cfg.initialSelection);
    const initialIndex = findStateIndexForTriadSelection(
      fallbackTriad,
      desiredSelection,
    );
    state.index = initialIndex >= 0 ? initialIndex : 0;
  };

  const bindHandlers = () => {
    if (elements.backBtn) {
      elements.backBtn.addEventListener("click", () => {
        goHistory(-1);
      });
    }

    if (elements.forwardBtn) {
      elements.forwardBtn.addEventListener("click", () => {
        if (!state.sequenceStates.length) return;
        const atEnd = state.index >= state.sequenceStates.length - 1;
        if (atEnd) {
          window.location.assign(nextTriadUrl);
          return;
        }
        goHistory(1);
      });
    }

    elements.stepButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const stepRaw = button.dataset.seqStep || "none";
        const stepSelection = stepRaw === "none" ? null : stepRaw;
        goToStepSelection(stepSelection);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (!state.sequenceStates.length) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goHistory(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;

      event.preventDefault();
      const atEnd = state.index >= state.sequenceStates.length - 1;
      if (atEnd) {
        window.location.assign(nextTriadUrl);
        return;
      }
      goHistory(1);
    });
  };

  async function initSequenceOverlay() {
    if (!elements.stage || !elements.backBtn || !elements.forwardBtn) return;

    await loadHistory();
    applyStateByIndex(state.index, { log: false });

    const active = getActiveView();
    if (active) {
      logCombo(active);
    }

    bindHandlers();
  }

  document.addEventListener("DOMContentLoaded", initSequenceOverlay);
})();
