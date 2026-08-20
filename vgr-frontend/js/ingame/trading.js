

const demoTradeData = {
    playerName: "Lord Valion",
    partnerName: "Eirik Ironhand",
    playerWeight: { current: 142, max: 300 },
    partnerWeight: { current: 88, max: 500 },
    playerGold: 685,
    partnerGold: 1240,
    playerItems: [
        { id: "steel_sword", name: "Steel Sword", type: "weapon", qty: 1, value: 45, weight: 10, description: "A reliable blade carried by guards and sellswords." },
        { id: "iron_dagger", name: "Iron Dagger", type: "weapon", qty: 2, value: 10, weight: 2, description: "A small dagger suited for concealed defense." },
        { id: "hide_boots", name: "Hide Boots", type: "armor", qty: 1, value: 10, weight: 2, description: "Light leather boots made for travel." },
        { id: "health_potion", name: "Potion of Minor Healing", type: "potion", qty: 4, value: 30, weight: 0.5, description: "Restores a small amount of health." },
        { id: "iron_ore", name: "Iron Ore", type: "material", qty: 7, value: 2, weight: 1, description: "Raw ore used for smelting and smithing." },
        { id: "bread", name: "Loaf of Bread", type: "food", qty: 3, value: 2, weight: 0.5, description: "Simple food for long roads and cold nights." },
        { id: "ruby", name: "Flawless Ruby", type: "misc", qty: 1, value: 350, weight: 0.1, description: "A rare gemstone desired by nobles and craftsmen." }
    ],
    partnerItems: [
        { id: "lockpick", name: "Lockpick", type: "misc", qty: 15, value: 5, weight: 0, description: "A thin tool used to open locked chests and doors." },
        { id: "steel_ingot", name: "Steel Ingot", type: "material", qty: 6, value: 20, weight: 1, description: "A refined ingot ready for the forge." },
        { id: "stamina_potion", name: "Potion of Stamina", type: "potion", qty: 5, value: 35, weight: 0.5, description: "Restores stamina for labour or battle." },
        { id: "fur_armor", name: "Fur Armor", type: "armor", qty: 1, value: 25, weight: 6, description: "Warm armour common among hunters and northern travellers." },
        { id: "hunting_bow", name: "Hunting Bow", type: "weapon", qty: 1, value: 50, weight: 7, description: "A basic bow used by hunters across Skyrim." },
        { id: "apple", name: "Red Apple", type: "food", qty: 8, value: 3, weight: 0.1, description: "Fresh fruit from a local hold market." }
    ]
};

const tradeState = {
    isOpen: false,
    partnerName: "",
    playerName: "",
    playerGoldMax: 0,
    partnerGoldMax: 0,
    partnerGoldOffer: 0,
    playerGoldOffer: 0,
    playerAccepted: false,
    partnerAccepted: false,
    selected: null,
    playerItems: [],
    partnerItems: [],
    playerOffer: [],
    partnerOffer: [],
    filters: {
        playerSearch: "",
        partnerSearch: "",
        playerType: "all",
        partnerType: "all"
    },
    weight: {
        player: { current: 0, max: 0 },
        partner: { current: 0, max: 0 }
    }
};

const tradeRequestState = {
    requestId: null,
    mode: null,
    countdownTimer: null
};

const elements = {};
let tradingUiReady = false;
let pendingTradingPayload = null;
let tradingManagedUiRequested = false;

function cacheElements() {
    const ids = [
        "skyrim-trade",
        "trade-partner-name",
        "player-title",
        "partner-title",
        "player-weight",
        "partner-weight",
        "player-search",
        "partner-search",
        "player-filter",
        "partner-filter",
        "player-inventory",
        "partner-inventory",
        "player-offer-list",
        "partner-offer-list",
        "player-offer-total",
        "partner-offer-total",
        "player-gold",
        "player-gold-max",
        "partner-gold",
        "selected-item-icon",
        "selected-item-name",
        "selected-item-desc",
        "selected-item-type",
        "selected-item-value",
        "selected-item-weight",
        "offer-selected",
        "clear-offer",
        "accept-trade",
        "cancel-trade",
        "player-status",
        "partner-status",
        "vgr-trade-request",
        "tradeRequestTitle",
        "tradeRequestName",
        "tradeRequestMessage",
        "tradeRequestCountdown",
        "tradeRequestActions",
        "tradeRequestClose"
    ];

    ids.forEach((id) => {
        elements[id] = document.getElementById(id);
    });
}

function ensureTradingUiReady() {
    if (!elements["skyrim-trade"]) {
        cacheElements();
    }
    return !!elements["skyrim-trade"];
}

function requestManagedUi(name, open) {
    if (!name) return;
    window.skyrimPlatform?.sendMessage?.("vgr:ui", name);
}

function setPanelVisible(element, visible) {
    if (!element) return;
    element.hidden = !visible;
    element.classList.toggle("visible", visible);
    element.setAttribute("aria-hidden", visible ? "false" : "true");
}

function makeTradeRequestButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", (event) => {
        event.preventDefault();
        onClick();
    });
    return button;
}

function initTradingUi() {
    if (tradingUiReady) return;
    ensureTradingUiReady();
    bindEvents();
    tradingUiReady = true;

    if (pendingTradingPayload) {
        const event = pendingTradingPayload.eventName;
        const payload = pendingTradingPayload.payload;
        pendingTradingPayload = null;
        receiveTradingUiEvent(event, payload);
    }
}

function cloneItems(items) {
    return (items || []).map((item) => ({ ...item, qty: Number(item.qty || 0) }));
}

function openTradingMenu(data = demoTradeData) {
	if (!tradingManagedUiRequested) {
		tradingManagedUiRequested = true;
		requestManagedUi("trading", true);
	}
    tradeState.isOpen = true;
    tradeState.partnerName = data.partnerName || data.tradingWithName || data.targetPlayerName || data.otherPlayerName || "Unknown Player";
    tradeState.playerName = data.playerName || data.myPlayerName || data.characterName || "Adventurer";
    tradeState.playerGoldMax = Number(data.playerGold || 0);
    tradeState.partnerGoldMax = Number(data.partnerGold || 0);
    tradeState.playerGoldOffer = Number(data.playerGoldOffer || 0);
    tradeState.partnerGoldOffer = Number(data.partnerGoldOffer || 0);
    tradeState.playerAccepted = false;
    tradeState.partnerAccepted = false;
    tradeState.selected = null;
    tradeState.playerItems = cloneItems(data.playerItems);
    tradeState.partnerItems = cloneItems(data.partnerItems);
    tradeState.playerOffer = cloneItems(data.playerOffer);
    tradeState.partnerOffer = cloneItems(data.partnerOffer);
    tradeState.weight.player = data.playerWeight || { current: 0, max: 0 };
    tradeState.weight.partner = data.partnerWeight || { current: 0, max: 0 };

    elements["skyrim-trade"].classList.add("visible");
    elements["skyrim-trade"].setAttribute("aria-hidden", "false");
    if (elements["player-gold"]) {
        elements["player-gold"].value = tradeState.playerGoldOffer;
    }
    renderTradeMenu();
}

function closeTradingMenu() {
	tradingManagedUiRequested = false;
	requestManagedUi("trading", false);
    tradeState.isOpen = false;
    closeQtyPicker();
    elements["skyrim-trade"].classList.remove("visible");
    elements["skyrim-trade"].setAttribute("aria-hidden", "true");
    triggerTradeAction("close", {});
}

function tradeRequestTitle(data) {
    if (data.title) return data.title;
    return data.mode === "outgoing" ? "TRADE REQUEST SENT" : "TRADE REQUEST";
}

function tradeRequestMessage(data) {
    if (data.message) return data.message;
    if (data.mode === "outgoing") return "Waiting for response.";
    const name = data.requesterName || data.partnerName || "STRANGER";
    return `${name} WANTS TO TRADE`;
}

function clearTradeRequestTimer() {
    window.clearInterval(tradeRequestState.countdownTimer);
    tradeRequestState.countdownTimer = null;
}

function clearTradeRequestState() {
    tradeRequestState.requestId = null;
    tradeRequestState.mode = null;
    clearTradeRequestTimer();
}

function closeTradeRequestFromPayload() {
    clearTradeRequestState();
    setPanelVisible(elements["vgr-trade-request"], false);
}

function updateTradeRequestCountdown(expiresAt) {
    if (!elements.tradeRequestCountdown) return;
    const remaining = Math.max(0, Math.ceil((Number(expiresAt || 0) - Date.now()) / 1000));
    elements.tradeRequestCountdown.textContent = remaining > 0 ? `${remaining}s remaining` : "Expired";
    if (remaining <= 0) clearTradeRequestTimer();
}

function closeTradeRequest(response) {
    const requestId = tradeRequestState.requestId;
    const mode = tradeRequestState.mode;
    clearTradeRequestState();
    setPanelVisible(elements["vgr-trade-request"], false);
    requestManagedUi("trade_request", false);
    if (response && requestId) {
        window.skyrimPlatform?.sendMessage?.("vgr:trading:tradeRequestResponse", {
            requestId,
            response: response === "cancel" && mode !== "outgoing" ? "deny" : response
        });
    }
}

function renderTradeRequest(data) {
    tradeRequestState.requestId = data.requestId || null;
    tradeRequestState.mode = data.mode || "incoming";
    clearTradeRequestTimer();

    if (elements.tradeRequestTitle) elements.tradeRequestTitle.textContent = tradeRequestTitle(data);
    if (elements.tradeRequestName) elements.tradeRequestName.textContent = data.requesterName || data.partnerName || "";
    if (elements.tradeRequestMessage) elements.tradeRequestMessage.textContent = tradeRequestMessage(data);
    if (elements.tradeRequestActions) {
        elements.tradeRequestActions.textContent = "";
        if (tradeRequestState.mode === "incoming") {
            elements.tradeRequestActions.appendChild(makeTradeRequestButton("Accept", "trade-request-button", () => closeTradeRequest("accept")));
            elements.tradeRequestActions.appendChild(makeTradeRequestButton("Deny", "trade-request-button secondary", () => closeTradeRequest("deny")));
        } else {
            elements.tradeRequestActions.appendChild(makeTradeRequestButton("Cancel", "trade-request-button secondary", () => closeTradeRequest("cancel")));
        }
    }

    updateTradeRequestCountdown(data.expiresAt);
    tradeRequestState.countdownTimer = window.setInterval(() => updateTradeRequestCountdown(data.expiresAt), 500);
    setPanelVisible(elements["vgr-trade-request"], true);
    const first = elements.tradeRequestActions && elements.tradeRequestActions.querySelector("button");
    if (first) window.setTimeout(() => first.focus(), 0);
}

function resetAcceptedState() {
    tradeState.playerAccepted = false;
    tradeState.partnerAccepted = false;
}

function formatName(name) {
    return String(name || "")
        .replace(/[-_]/g, " ")
        .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function getListBySide(side) {
    return side === "player" ? tradeState.playerItems : tradeState.partnerItems;
}

function getOfferBySide(side) {
    return side === "player" ? tradeState.playerOffer : tradeState.partnerOffer;
}

function setListBySide(side, list) {
    if (side === "player") tradeState.playerItems = list;
    else tradeState.partnerItems = list;
}

function setOfferBySide(side, list) {
    if (side === "player") tradeState.playerOffer = list;
    else tradeState.partnerOffer = list;
}

function getFilteredItems(side) {
    const list = getListBySide(side);
    const search = side === "player" ? tradeState.filters.playerSearch : tradeState.filters.partnerSearch;
    const type = side === "player" ? tradeState.filters.playerType : tradeState.filters.partnerType;
    const term = search.trim().toLowerCase();

    return list.filter((item) => {
        const matchesSearch = !term || item.name.toLowerCase().includes(term) || item.type.toLowerCase().includes(term);
        const matchesType = type === "all" || item.type === type;
        return item.qty > 0 && matchesSearch && matchesType;
    });
}

function renderTradeMenu() {
    elements["trade-partner-name"].textContent = tradeState.partnerName;
    elements["player-title"].textContent = tradeState.playerName;
    elements["partner-title"].textContent = tradeState.partnerName;
    elements["player-weight"].textContent = `${tradeState.weight.player.current} / ${tradeState.weight.player.max}`;
    elements["partner-weight"].textContent = `${tradeState.weight.partner.current} / ${tradeState.weight.partner.max}`;
    elements["partner-gold"].textContent = tradeState.partnerGoldOffer;
    if (elements["player-gold-max"]) {
        elements["player-gold-max"].textContent = `${tradeState.playerGoldMax} Septims`;
    }

    renderInventory("player");
    renderInventory("partner");
    renderOffer("player");
    renderOffer("partner");
    renderSelectedItem();
    renderTotals();
    renderAcceptedStatus();
    refreshQtyPicker();
}

function renderInventory(side) {
    const container = elements[`${side}-inventory`];
    const items = getFilteredItems(side);
    container.innerHTML = "";

    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "trade-empty";
        empty.textContent = "No items found";
        container.appendChild(empty);
        return;
    }

    items.forEach((item) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "trade-item";
        row.dataset.side = side;
        row.dataset.itemId = item.id;

        if (tradeState.selected && tradeState.selected.side === side && tradeState.selected.item.id === item.id) {
            row.classList.add("selected");
        }

        row.innerHTML = `
            <span class="item-icon" aria-hidden="true">${getIconSvg(item)}</span>
            <span class="item-main">
                <span class="item-name">${escapeHtml(item.name)}</span>
                <span class="item-sub">${escapeHtml(formatName(item.type))} • ${Number(item.value || 0)} Septims</span>
            </span>
            <span class="item-qty">x${Number(item.qty || 0)}</span>
        `;

        row.addEventListener("click", () => selectItem(side, item.id));
        row.addEventListener("dblclick", () => requestAddToOffer(side, item.id));
        container.appendChild(row);
    });
}

function renderOffer(side) {
    const container = elements[`${side}-offer-list`];
    const items = getOfferBySide(side);
    container.innerHTML = "";
    container.classList.toggle("empty", !items.length);

    items.forEach((item) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "offer-item";
        row.dataset.side = side;
        row.dataset.itemId = item.id;
        row.innerHTML = `
            <span class="item-icon" aria-hidden="true">${getIconSvg(item)}</span>
            <span class="offer-main">
                <span class="offer-name">${escapeHtml(item.name)}</span>
                <span class="offer-sub">${Number(item.value || 0)} Septims each</span>
            </span>
            <span class="offer-qty">x${Number(item.qty || 0)}</span>
        `;

        row.addEventListener("click", () => selectOfferItem(side, item.id));

        // Players can only remove items from their own offer.
        // The other player's offer is updated only through updatePartnerOffer() from the game/backend.
        if (side === "player") {
            row.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                removeItemFromOffer(side, item.id, 1);
            });
            row.addEventListener("dblclick", () => removeItemFromOffer(side, item.id, 1));
        }

        container.appendChild(row);
    });
}

function renderSelectedItem() {
    const selected = tradeState.selected;

    if (!selected) {
        elements["selected-item-icon"].innerHTML = getIconSvg({ type: "misc" });
        elements["selected-item-name"].textContent = "No Item Selected";
        elements["selected-item-desc"].textContent = "Select an item from your inventory or an offered item to view details.";
        elements["selected-item-type"].textContent = "Type: -";
        elements["selected-item-value"].textContent = "Value: -";
        elements["selected-item-weight"].textContent = "Weight: -";
        elements["offer-selected"].disabled = true;
        return;
    }

    const item = selected.item;
    elements["selected-item-icon"].innerHTML = getIconSvg(item);
    elements["selected-item-name"].textContent = item.name;
    elements["selected-item-desc"].textContent = item.description || "No item description available.";
    elements["selected-item-type"].textContent = `Type: ${formatName(item.type)}`;
    elements["selected-item-value"].textContent = `Value: ${Number(item.value || 0)}`;
    elements["selected-item-weight"].textContent = `Weight: ${Number(item.weight || 0)}`;
    elements["offer-selected"].disabled = !(selected.side === "player" && selected.location === "inventory");
}

function renderTotals() {
    const playerItemTotal = totalOfferValue(tradeState.playerOffer);
    const partnerItemTotal = totalOfferValue(tradeState.partnerOffer);

    elements["player-offer-total"].textContent = `${playerItemTotal + tradeState.playerGoldOffer} Septims`;
    elements["partner-offer-total"].textContent = `${partnerItemTotal + tradeState.partnerGoldOffer} Septims`;
}

function renderAcceptedStatus() {
    updateStatusSeal(elements["player-status"], tradeState.playerAccepted);
    updateStatusSeal(elements["partner-status"], tradeState.partnerAccepted);

    elements["accept-trade"].textContent = tradeState.playerAccepted ? "Accepted" : "Accept Trade";
}

function updateStatusSeal(element, accepted) {
    element.classList.toggle("accepted", accepted);
    element.querySelector("strong").textContent = accepted ? "Accepted" : "Pending";
}

function totalOfferValue(items) {
    return items.reduce((sum, item) => sum + Number(item.value || 0) * Number(item.qty || 0), 0);
}

function selectItem(side, itemId) {
    const item = getListBySide(side).find((entry) => entry.id === itemId);
    if (!item) return;

    tradeState.selected = { side, location: "inventory", item: { ...item } };
    renderTradeMenu();
}

function selectOfferItem(side, itemId) {
    const item = getOfferBySide(side).find((entry) => entry.id === itemId);
    if (!item) return;

    tradeState.selected = { side, location: "offer", item: { ...item } };
    renderSelectedItem();
}

// Stacks at or above this size open the amount picker instead of adding one.
const QTY_PICKER_MIN_STACK = 5;

const qtyPickerState = { open: false, side: null, itemId: null };
let qtyPickerEls = null;

// Builds the amount picker DOM once and reuses it afterwards.
function ensureQtyPicker() {
    if (qtyPickerEls) return qtyPickerEls;

    const overlay = document.createElement("div");
    overlay.className = "qty-picker-overlay";
    overlay.hidden = true;

    const modal = document.createElement("div");
    modal.className = "qty-picker-modal";

    const kicker = document.createElement("span");
    kicker.className = "trade-small-label";
    kicker.textContent = "Select Amount";

    const name = document.createElement("div");
    name.className = "qty-picker-name";

    const input = document.createElement("input");
    input.type = "number";
    input.className = "gold-input qty-picker-input";
    input.min = "1";
    input.step = "1";

    const max = document.createElement("div");
    max.className = "qty-picker-max";

    const quick = document.createElement("div");
    quick.className = "qty-picker-quick";

    const makeQuickButton = (label, pick) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "qty-quick-button";
        button.textContent = label;
        button.addEventListener("click", () => {
            const limit = Math.max(1, Math.floor(Number(input.max) || 1));
            input.value = String(Math.max(1, Math.min(pick(limit), limit)));
            input.focus();
        });
        return button;
    };

    quick.appendChild(makeQuickButton("1", () => 1));
    quick.appendChild(makeQuickButton("Half", (limit) => Math.floor(limit / 2)));
    quick.appendChild(makeQuickButton("Max", (limit) => limit));

    const actions = document.createElement("div");
    actions.className = "qty-picker-actions";

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "skyrim-button compact";
    confirmButton.textContent = "Confirm";
    confirmButton.addEventListener("click", confirmQtyPicker);

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "skyrim-button muted compact";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => closeQtyPicker());

    actions.appendChild(confirmButton);
    actions.appendChild(cancelButton);

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            confirmQtyPicker();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeQtyPicker();
        }
    });

    // Clicking the dimmed backdrop cancels without adding anything.
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeQtyPicker();
    });

    modal.appendChild(kicker);
    modal.appendChild(name);
    modal.appendChild(input);
    modal.appendChild(max);
    modal.appendChild(quick);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    const host = elements["skyrim-trade"] || document.body;
    host.appendChild(overlay);

    qtyPickerEls = { overlay, name, input, max };
    return qtyPickerEls;
}

function openQtyPicker(side, itemId) {
    const item = getListBySide(side).find((entry) => entry.id === itemId);
    if (!item || item.qty <= 0) return;

    const els = ensureQtyPicker();
    qtyPickerState.open = true;
    qtyPickerState.side = side;
    qtyPickerState.itemId = itemId;
    els.name.textContent = item.name;
    els.max.textContent = `of ${item.qty} available`;
    els.input.max = String(item.qty);
    els.input.value = "1";
    els.overlay.hidden = false;
    window.setTimeout(() => {
        els.input.focus();
        els.input.select();
    }, 0);
}

function closeQtyPicker() {
    if (!qtyPickerState.open) return;
    qtyPickerState.open = false;
    qtyPickerState.side = null;
    qtyPickerState.itemId = null;
    if (qtyPickerEls) qtyPickerEls.overlay.hidden = true;
}

function confirmQtyPicker() {
    if (!qtyPickerState.open || !qtyPickerEls) return;
    const side = qtyPickerState.side;
    const itemId = qtyPickerState.itemId;
    const item = getListBySide(side).find((entry) => entry.id === itemId);
    if (!item || item.qty <= 0) {
        closeQtyPicker();
        return;
    }

    const max = Math.max(1, Math.floor(Number(item.qty) || 1));
    const raw = Math.floor(Number(qtyPickerEls.input.value) || 1);
    const qty = Math.max(1, Math.min(raw, max));
    closeQtyPicker();
    addItemToOffer(side, itemId, qty);
}

// Keeps an open picker in sync when a server push changes the stack.
function refreshQtyPicker() {
    if (!qtyPickerState.open || !qtyPickerEls) return;
    const item = getListBySide(qtyPickerState.side).find((entry) => entry.id === qtyPickerState.itemId);
    if (!item || item.qty <= 0) {
        closeQtyPicker();
        return;
    }
    qtyPickerEls.input.max = String(item.qty);
    qtyPickerEls.max.textContent = `of ${item.qty} available`;
    const current = Math.floor(Number(qtyPickerEls.input.value) || 1);
    if (current > item.qty) qtyPickerEls.input.value = String(item.qty);
}

// Small stacks keep the legacy add-one behavior; larger stacks ask for an amount.
function requestAddToOffer(side, itemId) {
    if (side !== "player") return;
    const item = getListBySide(side).find((entry) => entry.id === itemId);
    if (!item || item.qty <= 0) return;
    if (item.qty < QTY_PICKER_MIN_STACK) {
        addItemToOffer(side, itemId, 1);
        return;
    }
    openQtyPicker(side, itemId);
}

function addItemToOffer(side, itemId, qty = 1) {
    if (side !== "player") return;

    const sourceList = getListBySide(side).map((item) => ({ ...item }));
    const offerList = getOfferBySide(side).map((item) => ({ ...item }));
    const sourceItem = sourceList.find((item) => item.id === itemId);

    if (!sourceItem || sourceItem.qty <= 0) return;

    const transferQty = Math.min(Number(qty || 1), sourceItem.qty);
    sourceItem.qty -= transferQty;

    const existingOffer = offerList.find((item) => item.id === itemId);
    if (existingOffer) {
        existingOffer.qty += transferQty;
    } else {
        offerList.push({ ...sourceItem, qty: transferQty });
    }

    setListBySide(side, sourceList.filter((item) => item.qty > 0));
    setOfferBySide(side, offerList);
    resetAcceptedState();
    triggerTradeAction("offerItem", { side, itemId, qty: transferQty });
    renderTradeMenu();
}

function removeItemFromOffer(side, itemId, qty = 1) {
    if (side !== "player") return;

    const sourceList = getListBySide(side).map((item) => ({ ...item }));
    const offerList = getOfferBySide(side).map((item) => ({ ...item }));
    const offerItem = offerList.find((item) => item.id === itemId);

    if (!offerItem || offerItem.qty <= 0) return;

    const transferQty = Math.min(Number(qty || 1), offerItem.qty);
    offerItem.qty -= transferQty;

    const existingSource = sourceList.find((item) => item.id === itemId);
    if (existingSource) {
        existingSource.qty += transferQty;
    } else {
        sourceList.push({ ...offerItem, qty: transferQty });
    }

    setOfferBySide(side, offerList.filter((item) => item.qty > 0));
    setListBySide(side, sourceList);
    resetAcceptedState();
    triggerTradeAction("removeOfferItem", { side, itemId, qty: transferQty });
    renderTradeMenu();
}

function clearPlayerOffer() {
    const itemsToReturn = tradeState.playerOffer.map((item) => ({ ...item }));
    const sourceList = tradeState.playerItems.map((item) => ({ ...item }));

    itemsToReturn.forEach((item) => {
        const existing = sourceList.find((sourceItem) => sourceItem.id === item.id);
        if (existing) existing.qty += item.qty;
        else sourceList.push(item);
    });

    tradeState.playerItems = sourceList;
    tradeState.playerOffer = [];
    tradeState.playerGoldOffer = 0;
    elements["player-gold"].value = 0;
    resetAcceptedState();
    triggerTradeAction("clearOffer", { side: "player" });
    renderTradeMenu();
}

function acceptTrade() {
    tradeState.playerAccepted = !tradeState.playerAccepted;

    triggerTradeAction("accept", {
        accepted: tradeState.playerAccepted,
        playerOffer: tradeState.playerOffer,
        playerGold: tradeState.playerGoldOffer
    });

    renderAcceptedStatus();
}

function setPartnerAccepted(accepted) {
    tradeState.partnerAccepted = Boolean(accepted);
    renderAcceptedStatus();
}

function updatePartnerOffer(data = {}) {
    tradeState.partnerOffer = cloneItems(data.items || tradeState.partnerOffer);
    tradeState.partnerGoldOffer = Number(data.gold || 0);
    tradeState.partnerAccepted = Boolean(data.accepted || false);
    renderTradeMenu();
}

function updatePlayerGoldOffer(value) {
    const numericValue = Number(value || 0);
    const amount = Math.max(0, Math.min(Math.floor(numericValue), tradeState.playerGoldMax));
    tradeState.playerGoldOffer = amount;
    elements["player-gold"].value = amount;
    resetAcceptedState();
    triggerTradeAction("offerGold", { side: "player", gold: amount });
    renderTotals();
    renderAcceptedStatus();
}

function mapPayloadToServer(type, payload) {
    const baseId = Number(payload && (payload.baseId != null ? payload.baseId : payload.itemId));
    const count = Number((payload && (payload.count || payload.qty)) || 1);

    if (type === "offerItem" || type === "removeOfferItem") {
        return { baseId: baseId, count: count };
    }
    if (type === "offerGold") {
        return { gold: Number((payload && payload.gold) || 0) };
    }
    if (type === "accept") {
        return { accepted: !!(payload && payload.accepted) };
    }
    if (type === "close") {
        return { reason: (payload && payload.reason) || "ui" };
    }
    return payload || {};
}

function triggerTradeAction(type, payload) {
    const msgMap = {
        offerItem: "vgr:trading:addOffer",
        removeOfferItem: "vgr:trading:removeOffer",
        clearOffer: "vgr:trading:clearOffer",
        offerGold: "vgr:trading:offerGold",
        accept: "vgr:trading:accept",
        close: "vgr:trading:cancel"
    };

    const msg = msgMap[type];
    if (!msg) return;
    window.skyrimPlatform?.sendMessage?.(msg, mapPayloadToServer(type, payload));
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getIconSvg(item = {}) {
    const type = item.type || "misc";

    const icons = {
        weapon: `
            <svg viewBox="0 0 64 64" role="img" aria-label="Weapon">
                <path class="svg-steel" d="M46 4l14 0-4 14-31 31-6-6L50 12z"/>
                <path class="svg-dark" d="M13 39l12 12-5 5L8 44z"/>
                <path class="svg-wood" d="M6 49l9 9-4 4-9-9z"/>
                <path class="svg-line" d="M50 12L25 37M19 43l6 6M8 44l12 12"/>
            </svg>
        `,
        armor: `
            <svg viewBox="0 0 64 64" role="img" aria-label="Armor">
                <path class="svg-dark" d="M20 7l12 6 12-6 10 9-6 10v28l-16 6-16-6V26l-6-10z"/>
                <path class="svg-steel" d="M22 12l10 5 10-5 6 6-5 9v23l-11 4-11-4V27l-5-9z"/>
                <path class="svg-line" d="M32 17v36M21 27h22M24 13l8 4 8-4"/>
            </svg>
        `,
        potion: `
            <svg viewBox="0 0 64 64" role="img" aria-label="Potion">
                <path class="svg-gold" d="M25 5h14v10l-4 5v4l12 20c4 7-1 15-9 15H26c-8 0-13-8-9-15l12-20v-4l-4-5z"/>
                <path class="svg-red" d="M22 42h20l3 7c2 4-1 7-6 7H25c-5 0-8-3-6-7z"/>
                <path class="svg-line" d="M25 15h14M29 24l-12 21M35 24l12 21"/>
            </svg>
        `,
        food: `
            <svg viewBox="0 0 64 64" role="img" aria-label="Food">
                <path class="svg-gold" d="M20 26c1-10 10-17 21-14 11 4 15 16 8 27-6 10-20 16-30 8-7-6-8-15 1-21z"/>
                <path class="svg-dark" d="M38 6c5 1 8 3 10 8-6 1-11-1-14-6z"/>
                <path class="svg-line" d="M22 27c5-4 13-4 20 1M28 16c2 5 1 10-3 15"/>
            </svg>
        `,
        material: `
            <svg viewBox="0 0 64 64" role="img" aria-label="Material">
                <path class="svg-steel" d="M14 39l10-19 16-10 12 13-5 22-20 9z"/>
                <path class="svg-dark" d="M24 20l16-10 12 13-16 4z"/>
                <path class="svg-line" d="M14 39l22-12 16-4M27 54l9-27M24 20l12 7"/>
            </svg>
        `,
        misc: `
            <svg viewBox="0 0 64 64" role="img" aria-label="Misc">
                <path class="svg-gold" d="M18 18h28l8 10-22 27L10 28z"/>
                <path class="svg-dark" d="M18 18l14 37 14-37z" opacity="0.55"/>
                <path class="svg-line" d="M10 28h44M18 18l14 10 14-10M32 28v27"/>
            </svg>
        `
    };

    return icons[type] || icons.misc;
}

function bindEvents() {
    elements["player-search"].addEventListener("input", (event) => {
        tradeState.filters.playerSearch = event.target.value;
        renderInventory("player");
    });

    elements["partner-search"].addEventListener("input", (event) => {
        tradeState.filters.partnerSearch = event.target.value;
        renderInventory("partner");
    });

    elements["player-filter"].addEventListener("change", (event) => {
        tradeState.filters.playerType = event.target.value;
        renderInventory("player");
    });

    elements["partner-filter"].addEventListener("change", (event) => {
        tradeState.filters.partnerType = event.target.value;
        renderInventory("partner");
    });

    elements["offer-selected"].addEventListener("click", () => {
        if (!tradeState.selected) return;
        requestAddToOffer(tradeState.selected.side, tradeState.selected.item.id);
    });

    elements["player-gold"].addEventListener("input", (event) => {
        updatePlayerGoldOffer(event.target.value);
    });

    elements["clear-offer"].addEventListener("click", clearPlayerOffer);
    elements["accept-trade"].addEventListener("click", acceptTrade);
    elements["cancel-trade"].addEventListener("click", closeTradingMenu);
    elements.tradeRequestClose?.addEventListener("click", () => {
        closeTradeRequest(tradeRequestState.mode === "outgoing" ? "cancel" : "deny");
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && qtyPickerState.open) {
            event.preventDefault();
            closeQtyPicker();
            return;
        }
        if (event.key === "Escape" && tradeState.isOpen) {
            closeTradingMenu();
            return;
        }
        if (event.key === "Escape" && tradeRequestState.requestId) {
            event.preventDefault();
            closeTradeRequest(tradeRequestState.mode === "outgoing" ? "cancel" : "deny");
        }
    });
}

function mapServerToTemplate(data) {
    const availableGold = Number(data.playerGold || 0);
    const goldOffer = Number(data.playerGoldOffer || 0);

    return {
        playerName: data.playerName || "Adventurer",
        partnerName: data.partnerName || "Unknown Player",
        playerGold: availableGold + goldOffer,
        partnerGold: Number(data.partnerGold || 0),
        playerGoldOffer: goldOffer,
        partnerGoldOffer: Number(data.partnerGoldOffer || 0),
        playerItems: cloneItems(data.playerItems || []),
        partnerItems: [],
        playerOffer: cloneItems(data.playerOffer || []),
        partnerOffer: cloneItems(data.partnerOffer || []),
        playerWeight: { current: 0, max: 0 },
        partnerWeight: { current: 0, max: 0 }
    };
}

function applyTradingPayload(eventName, data) {
    const event = String(eventName || "");
    const payload = data || {};

    if (event === "tradeRequest") {
        renderTradeRequest(payload);
        return;
    }
    if (event === "tradeRequestEnded") {
        closeTradeRequestFromPayload();
        return;
    }
    if (event === "sessionClosed") {
        window.vgrTradingClose(payload.reason || "server");
        return;
    }
    if (event !== "snapshot" && event !== "update") return;

    const mapped = mapServerToTemplate(payload);
    openTradingMenu(mapped);
    tradeState.playerAccepted = !!payload.selfAccepted;
    tradeState.partnerAccepted = !!payload.partnerAccepted;
    if (elements["player-gold"]) {
        elements["player-gold"].value = Number(payload.playerGoldOffer || 0);
    }
    renderTradeMenu();
}

function receiveTradingUiEvent(eventName, payload) {
    const event = String(eventName || "");
    if (!event) return;

    if (!tradingUiReady) {
        pendingTradingPayload = { eventName: event, payload: payload || null };
        initTradingUi();
        return;
    }

    applyTradingPayload(event, payload);
}

window.vgrTradingUpdate = function (data) {
    receiveTradingUiEvent("update", data);
};

window.vgr_TradingUI = function (eventName, payload) {
    receiveTradingUiEvent(eventName, payload);
};

window.vgrTradingClose = function (reason) {
	tradingManagedUiRequested = false;
	
    tradeState.isOpen = false;
    closeQtyPicker();
    if (!ensureTradingUiReady()) return;
    elements["skyrim-trade"].classList.remove("visible");
    elements["skyrim-trade"].setAttribute("aria-hidden", "true");
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTradingUi);
} else {
    initTradingUi();
}

window.addEventListener("vgr:ui_manager:open:trading", () => {
    if (!ensureTradingUiReady()) return;
    elements["skyrim-trade"].classList.add("visible");
    elements["skyrim-trade"].setAttribute("aria-hidden", "false");
});

window.addEventListener("vgr:ui_manager:close:trading", () => {
    if (!ensureTradingUiReady()) return;
    closeQtyPicker();
    elements["skyrim-trade"].classList.remove("visible");
    elements["skyrim-trade"].setAttribute("aria-hidden", "true");
    tradeState.isOpen = false;
});

window.addEventListener("vgr:ui_manager:open:trade_request", () => {
    if (!ensureTradingUiReady()) return;
    setPanelVisible(elements["vgr-trade-request"], true);
});

window.addEventListener("vgr:ui_manager:close:trade_request", () => {
    if (!ensureTradingUiReady()) return;
    setPanelVisible(elements["vgr-trade-request"], false);
    if (tradeRequestState.requestId) {
        closeTradeRequest(tradeRequestState.mode === "outgoing" ? "cancel" : "deny");
    }
});

window.openTradingMenu = openTradingMenu;
window.closeTradingMenu = closeTradingMenu;
window.setPartnerAccepted = setPartnerAccepted;
window.updatePartnerOffer = updatePartnerOffer;
