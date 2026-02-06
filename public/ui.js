function initAnnotationOverlay() {
  const items = Array.from(document.querySelectorAll("[data-annotation]"));
  const stage = document.querySelector(".triad-stage");
  if (!items.length || !stage) return;

  const cards = {
    a: document.querySelector('.triad-card[data-triad="a"]'),
    b: document.querySelector('.triad-card[data-triad="b"]'),
    c: document.querySelector('.triad-card[data-triad="c"]'),
  };
  let active = null;

  const clearOverlay = (shouldLog) => {
    const hadActive = Boolean(active);
    Object.values(cards).forEach((card) => {
      if (!card) return;
      card.classList.remove("is-pair");
      card.classList.remove("is-odd");
      const pairTag = card.querySelector(".annotation-tag-pair");
      const oddTag = card.querySelector(".annotation-tag-odd");
      if (pairTag) pairTag.textContent = "";
      if (oddTag) oddTag.textContent = "";
      if (pairTag) pairTag.classList.remove("is-visible");
      if (oddTag) oddTag.classList.remove("is-visible");
    });
    if (active) active.classList.remove("is-active");
    active = null;
    if (shouldLog && hadActive && window.__COMBO_LOG) logCombo(null);
  };

  const setOverlay = (item) => {
    const pair = item.dataset.pair || "";
    const odd = item.dataset.odd || "";
    const pairLabel = item.dataset.pairLabel || "";
    const oddLabel = item.dataset.oddLabel || "";
    if (!pair && !odd && !pairLabel && !oddLabel) {
      clearOverlay();
      return;
    }

    const pairKeys = pair.split("").filter(Boolean);
    pairKeys.forEach((key) => {
      const card = cards[key];
      if (!card) return;
      card.classList.add("is-pair");
      const tag = card.querySelector(".annotation-tag-pair");
      if (tag) {
        tag.textContent = pairLabel;
        if (pairLabel) tag.classList.add("is-visible");
      }
    });

    if (odd && cards[odd]) {
      const card = cards[odd];
      card.classList.add("is-odd");
      const tag = card.querySelector(".annotation-tag-odd");
      if (tag) {
        tag.textContent = oddLabel;
        if (oddLabel) tag.classList.add("is-visible");
      }
    }
  };

  items.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (active === item) {
        clearOverlay();
        if (window.__COMBO_LOG) logCombo(null);
        return;
      }
      clearOverlay();
      active = item;
      active.classList.add("is-active");
      setOverlay(item);
      if (window.__COMBO_LOG) logCombo(item.dataset.pair || null);
    });
  });

  stage.addEventListener("click", () => clearOverlay(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearOverlay(true);
  });
}

document.addEventListener("DOMContentLoaded", initAnnotationOverlay);

function shuffleCombos() {
  const list = document.querySelector(".annotation-list[data-combo]");
  if (!list) return [];
  const items = Array.from(list.children);
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    list.insertBefore(items[j], items[i]);
    items.splice(j, 1);
  }
  return Array.from(list.children).map((el) => el.dataset.pair);
}

async function logCombo(selectedPair) {
  const cfg = window.__COMBO_LOG;
  if (!cfg || !cfg.url) return;
  const payload = {
    triad: cfg.triad,
    selectedPair,
    order: cfg.order || null,
    sessionId: cfg.sessionId,
  };
  try {
    await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore logging errors
  }
}

function initComboLogging() {
  if (!window.__COMBO_LOG) return;
  const order = shuffleCombos();
  window.__COMBO_LOG.order = order;
  logCombo(null);
}

document.addEventListener("DOMContentLoaded", initComboLogging);
