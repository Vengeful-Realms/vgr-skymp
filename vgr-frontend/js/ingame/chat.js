(function () {
  "use strict";

  var MAX_LINES = 80;
  var HISTORY_MAX = 20;
  var IDLE_MS = 9000;
  var SCROLL_TOLERANCE = 40;

  var CHANNEL_STYLE = {
    say: { color: "#e8ddc0" },
    quiet: { color: "#cfc4a4" },
    whisper: { color: "#a99bc4" },
    yell: { color: "#d47f6d" },
    me: { color: "#c2a3da" },
    do: { color: "#8fae9a" },
    ooc: { color: "#7da7d9" },
    system: { color: "#eda841" },
    error: { color: "#c96a5c" },
  };

  var els = {};
  var state = {
    open: false,
    idleTimer: null,
    history: [],
    historyIndex: -1,
    draft: "",
    hidden: false,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function cache() {
    els.root = byId("vgr-chat");
    els.log = byId("vgrChatLog");
    els.inputRow = byId("vgrChatInputRow");
    els.input = byId("vgrChatInput");
  }

  function send(name, payload) {
    window.skyrimPlatform?.sendMessage?.(name, payload || {});
  }

  function touchIdle() {
    if (!els.root) return;
    els.root.classList.remove("idle");
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(function () {
      if (!state.open) els.root.classList.add("idle");
    }, IDLE_MS);
  }

  function nearBottom() {
    if (!els.log) return true;
    return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < SCROLL_TOLERANCE;
  }

  // Builds each line from textContent only; server text never becomes markup
  function addLine(entry) {
    if (!els.log || !entry) return;
    var channel = String(entry.channel || "say");
    var style = CHANNEL_STYLE[channel] || CHANNEL_STYLE.say;
    var line = document.createElement("div");
    line.className = "chat-line chat-" + channel;
    line.style.color = style.color;
    var dim = Number(entry.dim);
    if (Number.isFinite(dim) && dim > 0) {
      line.style.opacity = String(Math.max(0.45, 1 - dim * 0.5));
    }

    var name = String(entry.name || "");
    var text = String(entry.text || "");
    var verb = String(entry.verb || "");

    function span(cls, value) {
      var node = document.createElement("span");
      node.className = cls;
      node.textContent = value;
      line.appendChild(node);
    }

    if (channel === "system") {
      span("chat-tag", "[SYSTEM] ");
      span("chat-text", text);
    } else if (channel === "error") {
      span("chat-text", text);
    } else if (channel === "me") {
      span("chat-text", "* " + name + " " + text);
    } else if (channel === "do") {
      span("chat-text", "* " + text + " (" + name + ")");
    } else if (channel === "ooc") {
      span("chat-tag", "[OOC] ");
      span("chat-name", name + ": ");
      span("chat-text", text);
    } else {
      span("chat-name", name + " ");
      span("chat-verb", (verb || "says") + ": ");
      span("chat-text", "\"" + text + "\"");
    }

    var follow = nearBottom();
    els.log.appendChild(line);
    while (els.log.childElementCount > MAX_LINES) {
      els.log.removeChild(els.log.firstElementChild);
    }
    if (follow) els.log.scrollTop = els.log.scrollHeight;
    touchIdle();
  }

  function openInput() {
    state.open = true;
    if (els.inputRow) els.inputRow.hidden = false;
    if (els.root) {
      els.root.classList.add("focused");
      els.root.classList.remove("idle");
    }
    clearTimeout(state.idleTimer);
    window.setTimeout(function () {
      if (els.input) els.input.focus();
    }, 0);
  }

  function closeInput() {
    state.open = false;
    state.historyIndex = -1;
    if (els.input) els.input.blur();
    if (els.inputRow) els.inputRow.hidden = true;
    if (els.root) els.root.classList.remove("focused");
    touchIdle();
  }

  function setChatHidden(hidden) {
    state.hidden = hidden === true;
    if (els.root) els.root.classList.toggle("manually-hidden", state.hidden);
  }

  function runLocalCommand(text) {
    var command = String(text || "").trim().toLowerCase();
    if (command === "/hide") {
      setChatHidden(true);
      send("vgr:ui:close", "chat");
      return true;
    }
    if (command === "/show") {
      setChatHidden(false);
      send("vgr:ui:close", "chat");
      return true;
    }
    return false;
  }

  function submit() {
    var text = els.input ? els.input.value.trim() : "";
    if (els.input) els.input.value = "";
    if (text && !runLocalCommand(text)) {
      send("vgr:chat:send", { text: text });
      state.history.push(text);
      while (state.history.length > HISTORY_MAX) state.history.shift();
    }
    state.historyIndex = -1;
    send("vgr:ui:close", "chat");
  }

  function recallHistory(delta) {
    if (!els.input || !state.history.length) return;
    if (state.historyIndex === -1) {
      state.draft = els.input.value;
      if (delta < 0) state.historyIndex = state.history.length - 1;
      else return;
    } else {
      state.historyIndex += delta;
    }
    if (state.historyIndex < 0) state.historyIndex = 0;
    if (state.historyIndex >= state.history.length) {
      state.historyIndex = -1;
      els.input.value = state.draft;
      return;
    }
    els.input.value = state.history[state.historyIndex];
  }

  function onInputKeyDown(event) {
    // The window-level ui_manager forwarder skips inputs; handle keys here
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (els.input) els.input.value = "";
      state.historyIndex = -1;
      send("vgr:ui:close", "chat");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      recallHistory(-1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      recallHistory(1);
    }
  }

  function init() {
    cache();
    if (els.input) els.input.addEventListener("keydown", onInputKeyDown);
    window.addEventListener("vgr:ui_manager:open:chat", openInput);
    window.addEventListener("vgr:ui_manager:close:chat", closeInput);
    touchIdle();
  }

  window.vgrChatAdd = addLine;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
