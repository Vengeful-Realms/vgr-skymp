(function () {
  "use strict";

  var EVENTS = {
    frontLoaded: "front-loaded",
    characterSelect: "vgr:character:select",
    characterCreate: "vgr:character:create",
    characterDelete: "vgr:character:delete",
    characterCancelDelete: "vgr:character:cancel-delete",
    charactersRefresh: "vgr:characters:refresh",
    quitGame: "vgr:quit-game",
    queueJoin: "vgr:queue:join",
    queueLeave: "vgr:queue:leave",
    authStart: "vgr:auth:start",
    legacyAuthAttempt: "authAttempt"
  };

  var DEFAULT_DISCORD_USERNAME = "[Discord Username]";
  var DEFAULT_PROFILE_AVATAR_URL = "https://cdn.discordapp.com/embed/avatars/4.png";
  var DEFAULT_CHARACTER_PORTRAIT = "assets/portrait-template.png";
  var AUTH_DATA_URLS = [
    "../PluginsNoLoad/auth-data-no-load.js",
    "../../Platform/PluginsNoLoad/auth-data-no-load.js"
  ];
  var SFX = {
    hover: "assets/UI-SFX/Wooden-Hover-Cursor1.ogg",
    characterClick: "assets/UI-SFX/mixkit-camera-shutter-click.wav",
    buttonClick: "assets/UI-SFX/simple-click.mp3",
    queueEnd: "assets/UI-SFX/que-end-sfx.mp3"
  };

  var state = {
    view: "characters",
    characters: [],
    maxCharacterSlots: 3,
    user: { username: DEFAULT_DISCORD_USERNAME, avatar: DEFAULT_PROFILE_AVATAR_URL },
    selected: null,
    createSelected: false,
    queue: { position: null, total: null, status: "idle" },
    authStatus: {
      eyebrow: "ENTERING REALM",
      title: "Authorizing session",
      message: "The game server is validating your selected profile.",
      footer: "Authorization started. Waiting for the game server."
    },
    pendingAuth: false,
    pendingCreate: null,
    musicEnabled: true,
    log: []
  };

  var dom = {};
  var sfx = {};
  var demoTimer = null;
  var queueReadyTimer = null;
  var deletionTimer = null;
  var deletionRefreshRequestedAt = 0;
  var QUEUE_READY_AUTH_DELAY_MS = 1400;
  var DEFAULT_DELETION_GRACE_MS = 3 * 60 * 1000;
  var musicRetryBound = false;
  var musicStartOffsetApplied = false;
  var documentPointerBound = false;

  function hasSkyrimBridge() {
    return !!(window.skyrimPlatform && typeof window.skyrimPlatform.sendMessage === "function");
  }

  function ensureBridge() {
    if (!window.skyrimPlatform) {
      window.skyrimPlatform = {};
    }

    if (typeof window.skyrimPlatform.sendMessage !== "function") {
      window.skyrimPlatform.sendMessage = function (eventName, payload) {
        window.dispatchEvent(new CustomEvent("vgr-login-ui-message", {
          detail: { eventName: eventName, payload: payload || null }
        }));
      };
    }

    if (!window.skyrimPlatform.widgets || typeof window.skyrimPlatform.widgets.set !== "function") {
      var widgets = [];
      var listeners = [];
      window.skyrimPlatform.widgets = {
        get: function () {
          return widgets;
        },
        set: function (nextWidgets) {
          widgets = Array.isArray(nextWidgets) ? nextWidgets : [];
          listeners.slice().forEach(function (listener) {
            listener(widgets);
          });
        },
        addListener: function (listener) {
          if (typeof listener === "function") {
            listeners.push(listener);
          }
        },
        removeListener: function (listener) {
          listeners = listeners.filter(function (candidate) {
            return candidate !== listener;
          });
        }
      };
    }
  }

  function send(eventName, payload) {
    try {
      if (payload === undefined) {
        window.skyrimPlatform.sendMessage(eventName);
      } else {
        window.skyrimPlatform.sendMessage(eventName, JSON.stringify(payload));
      }
    } catch (err) {
      console.warn("[VGRLoginUI] failed to send bridge event", eventName, err);
    }
  }

  function readTextFile(url) {
    if (window.fetch) {
      return window.fetch(url, { cache: "no-store" }).then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.text();
      });
    }

    return new Promise(function (resolve, reject) {
      var request = new XMLHttpRequest();
      request.open("GET", url, true);
      request.onreadystatechange = function () {
        if (request.readyState !== 4) return;
        if ((request.status >= 200 && request.status < 300) || request.status === 0) {
          resolve(request.responseText);
        } else {
          reject(new Error("HTTP " + request.status));
        }
      };
      request.onerror = function () {
        reject(new Error("Request failed"));
      };
      request.send();
    });
  }

  function parseAuthData(text) {
    var match = String(text || "").replace(/^\uFEFF/, "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  }

  function loadAuthDataFromFile() {
    var index = 0;

    var tryNext = function () {
      if (index >= AUTH_DATA_URLS.length) return Promise.resolve(null);

      var url = AUTH_DATA_URLS[index++];
      return readTextFile(url)
        .then(parseAuthData)
        .catch(tryNext);
    };

    return tryNext().then(function (authData) {
      if (!authData) return;
      setUser({
        username: authData.discordUsername,
        avatar: authData.discordAvatar
      });
    }).catch(function (err) {
      console.warn("[VGRLoginUI] failed to read auth data", err);
    });
  }

  function playBackgroundMusic() {
    if (!dom.backgroundMusic) return;
    if (!state.musicEnabled) return;
    if (!dom.backgroundMusic.paused && !dom.backgroundMusic.ended) return;

    applyMusicStartOffset();
    var result = dom.backgroundMusic.play();
    if (result && typeof result.catch === "function") {
      result.catch(function () {
        bindMusicRetry();
      });
    }
  }

  function applyMusicStartOffset() {
    if (musicStartOffsetApplied || !dom.backgroundMusic) return;

    var setOffset = function () {
      if (musicStartOffsetApplied || !dom.backgroundMusic) return;

      musicStartOffsetApplied = true;
      try {
        dom.backgroundMusic.currentTime = 20;
      } catch (err) {
        console.warn("[VGRLoginUI] failed to seek background music", err);
      }
    };

    if (dom.backgroundMusic.readyState > 0) {
      setOffset();
    } else {
      dom.backgroundMusic.addEventListener("loadedmetadata", setOffset, { once: true });
    }
  }

  function startBackgroundMusicOnLoad() {
    if (!dom.backgroundMusic) return;

    dom.backgroundMusic.autoplay = true;
    dom.backgroundMusic.defaultMuted = false;
    dom.backgroundMusic.muted = false;
    dom.backgroundMusic.volume = 0.45;

    dom.backgroundMusic.addEventListener("loadedmetadata", applyMusicStartOffset, { once: true });
    if (dom.backgroundMusic.readyState > 0) {
      applyMusicStartOffset();
    }
    bindMusicRetry();
    renderMusicToggle();
  }

  function toggleBackgroundMusic() {
    if (!dom.backgroundMusic) {
      state.musicEnabled = !state.musicEnabled;
      renderMusicToggle();
      return;
    }

    if (dom.backgroundMusic.paused || dom.backgroundMusic.ended) {
      state.musicEnabled = true;
      dom.backgroundMusic.muted = false;
      playBackgroundMusic();
    } else {
      state.musicEnabled = false;
      dom.backgroundMusic.pause();
    }

    renderMusicToggle();
  }

  function getBackgroundMusicElements() {
    var tracks = [];
    if (dom.backgroundMusic) tracks.push(dom.backgroundMusic);

    Array.prototype.forEach.call(document.querySelectorAll(
      "#background-music, audio[src*='Soulforge'], audio"
    ), function (audio) {
      if (tracks.indexOf(audio) === -1) tracks.push(audio);
    });

    return tracks;
  }

  function stopBackgroundMusic(resetPosition) {
    var tracks = getBackgroundMusicElements();
    state.musicEnabled = false;
    musicRetryBound = true;

    if (!tracks.length) {
      renderMusicToggle();
      return;
    }

    tracks.forEach(function (audio) {
      try {
        audio.autoplay = false;
        audio.loop = false;
        audio.muted = true;
        audio.pause();
        if (resetPosition) {
          audio.currentTime = 0;
          musicStartOffsetApplied = false;
        }
      } catch (err) {
        console.warn("[VGRLoginUI] failed to stop background music", err);
      }
    });

    renderMusicToggle();
  }

  function restoreForAuth() {
    document.documentElement.classList.remove("vgr-login-ui-hidden");

    if (window.VGRFrontend && typeof window.VGRFrontend.resetForAuth === "function") {
      window.VGRFrontend.resetForAuth();
    } else if (window.VGRUI && typeof window.VGRUI.showLogin === "function") {
      window.VGRUI.showLogin();
    } else {
      document.body && document.body.setAttribute("data-vgr-mode", "login");
    }

    showCharacters();
  }

  function reloadForMainMenu() {
    restoreForAuth();

    // The permadeath kick lands ~1.5s after this runs and re-arms the client
    // browser-message listeners; refresh once they are live so the character
    // list reloads and fallen characters render with the Fallen state.
    setTimeout(function () {
      send(EVENTS.charactersRefresh);
    }, 2500);
  }

  function hideAfterSuccessfulAuth() {
    clearDemoQueue();
    clearQueueReadyTimer();
    clearDeletionTimer();
    state.view = "characters";
    state.selected = null;
    state.createSelected = false;
    state.queue = { position: null, total: null, status: "idle" };
    state.pendingAuth = false;
    closeDeleteConfirm();
    stopBackgroundMusic(true);
    render();

    if (window.VGRFrontend && typeof window.VGRFrontend.enterGameplay === "function") {
      window.VGRFrontend.enterGameplay("login-success");
    } else if (window.VGRUI && typeof window.VGRUI.completeLogin === "function") {
      window.VGRUI.completeLogin();
    } else {
      document.documentElement.classList.add("vgr-login-ui-hidden");
    }
  }

  function quitGame() {
    send(EVENTS.quitGame);
    setFooter("Quit requested.");
  }

  function renderMusicToggle() {
    if (!dom.audioToggle) return;

    var isPlaying = !!(state.musicEnabled && dom.backgroundMusic &&
      !dom.backgroundMusic.paused && !dom.backgroundMusic.ended);

    dom.audioToggle.textContent = isPlaying ? "Music On" : "Music Off";
    dom.audioToggle.setAttribute("aria-pressed", isPlaying ? "true" : "false");
    dom.audioToggle.classList.toggle("audio-off", !isPlaying);
  }

  function bindMusicRetry() {
    if (musicRetryBound) return;
    musicRetryBound = true;

    var retry = function () {
      playBackgroundMusic();
      if (dom.backgroundMusic && !dom.backgroundMusic.paused) {
        document.removeEventListener("pointerdown", retry);
        document.removeEventListener("keydown", retry);
      }
    };

    document.addEventListener("pointerdown", retry);
    document.addEventListener("keydown", retry);
  }

  function bindMusicStateEvents() {
    if (!dom.backgroundMusic) return;

    ["play", "pause", "ended"].forEach(function (eventName) {
      dom.backgroundMusic.addEventListener(eventName, renderMusicToggle);
    });
  }

  function createSfx(src, volume) {
    var audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = volume;
    return audio;
  }

  function preloadSfx() {
    sfx.hover = createSfx(SFX.hover, 0.36);
    sfx.characterClick = createSfx(SFX.characterClick, 0.46);
    sfx.buttonClick = createSfx(SFX.buttonClick, 0.42);
    sfx.queueEnd = createSfx(SFX.queueEnd, 0.58);
  }

  function playSfx(name) {
    var audio = sfx[name];
    if (!audio) return;

    try {
      audio.currentTime = 0;
      var result = audio.play();
      if (result && typeof result.catch === "function") {
        result.catch(function () {});
      }
    } catch (err) {
      console.warn("[VGRLoginUI] failed to play UI sound", name, err);
    }
  }

  function getClickableUiButton(target) {
    if (!target || typeof target.closest !== "function") return null;

    var button = target.closest("button");
    if (!button) return null;
    if (button.disabled) return null;
    if (!button.closest(".login-panel, .confirm-modal")) return null;
    return button;
  }

  function handleUiPointerRelease(event) {
    var button = getClickableUiButton(event.target);
    if (!button) return;

    var isCharacterSelector = button.classList.contains("character-card") ||
      button.classList.contains("create-character-card");
    playSfx(isCharacterSelector ? "characterClick" : "buttonClick");
  }

  function normalizeCharacter(raw, index) {
    raw = raw || {};
    var profileId = raw.profileId != null ? raw.profileId : raw.id;
    var portrait = raw.portrait || raw.portraitUrl || raw.image || raw.imageUrl ||
      raw.avatar || raw.avatarUrl || DEFAULT_CHARACTER_PORTRAIT;
    return {
      profileId: profileId,
      name: String(raw.name || raw.characterName || "Unnamed Character"),
      portrait: String(portrait || DEFAULT_CHARACTER_PORTRAIT),
      deleteRequestedAt: raw.deleteRequestedAt || null,
      deleteAt: raw.deleteAt || null,
      deletionStartedAt: raw.deletionStartedAt || null,
      deletedAt: raw.deletedAt || null,
      permaDead: raw.permaDead === true,
      index: index || 0
    };
  }

  function setCharacters(data) {
    var selectedProfileId = state.selected && state.selected.profileId;
    var characters = Array.isArray(data) ? data : data && Array.isArray(data.characters) ? data.characters : [];
    var maxSlots = data && (data.maxCharacterSlots != null ? data.maxCharacterSlots : data.maxSlots);
    if (maxSlots != null && Number(maxSlots) >= 0) {
      state.maxCharacterSlots = Number(maxSlots);
    }

    state.characters = characters
      .map(normalizeCharacter)
      .filter(function (character) {
        return character.profileId !== undefined && character.profileId !== null;
      });
    state.view = "characters";
    state.selected = selectedProfileId == null ? null : state.characters.find(function (character) {
      return String(character.profileId) === String(selectedProfileId);
    }) || null;
    state.createSelected = false;
    state.queue = { position: null, total: null, status: "idle" };
    state.pendingAuth = false;
    state.pendingCreate = null;
    pushLog("Character list received.");
    updateDeletionTimer();
    render();
  }

  function isQueueReady(queue) {
    return !!queue && (queue.status === "ready" || queue.status === "admitting");
  }

  function setQueue(queue) {
    queue = queue || {};
    var previousPosition = state.queue.position;
    var previousStatus = state.queue.status;
    state.queue = {
      position: queue.position != null ? Number(queue.position) : null,
      total: queue.total != null ? Number(queue.total) : null,
      status: String(queue.status || "waiting"),
      message: queue.message ? String(queue.message) : null
    };

    if (queue.message) {
      pushLog(String(queue.message));
    } else if (state.queue.position != null && state.queue.total != null) {
      pushLog("Queue position " + state.queue.position + " of " + state.queue.total + ".");
    }

    var authInProgress = state.pendingAuth || state.view === "auth";
    if (!authInProgress) {
      state.view = "queue";
    }
    render();

    if (isQueueReady(state.queue) && !authInProgress) {
      if (!isQueueReady({ status: previousStatus })) {
        playSfx("queueEnd");
      }
      scheduleQueueReadyAuth();
    }
  }

  function setUser(user) {
    user = user || {};
    state.user = {
      username: String(user.username || user.discordUsername || user.tag || state.user.username || DEFAULT_DISCORD_USERNAME),
      avatar: String(user.avatar || user.discordAvatar || state.user.avatar || DEFAULT_PROFILE_AVATAR_URL)
    };
    renderHeader();
  }

  function confirmCharacter(character) {
    var normalized = normalizeCharacter(character);
    if (normalized.profileId === undefined || normalized.profileId === null) {
      setError("Backend confirmed a character without profileId.");
      return;
    }

    var existingIndex = state.characters.findIndex(function (candidate) {
      return String(candidate.profileId) === String(normalized.profileId);
    });
    if (existingIndex >= 0) {
      state.characters[existingIndex] = normalized;
    } else {
      state.characters.unshift(normalized);
    }

    state.pendingCreate = null;
    selectCharacter(normalized, "created");
  }

  function setError(message) {
    setFooter(message || "Unknown login error.");
    pushLog(message || "Unknown login error.");
    render();
  }

  function setFooter(message) {
    if (dom.footerStatus) {
      dom.footerStatus.textContent = message;
    }
  }

  function pushLog(message) {
    if (!message) return;
    var time = new Date();
    var stamp = String(time.getHours()).padStart(2, "0") + ":" + String(time.getMinutes()).padStart(2, "0");
    state.log.push(stamp + " - " + message);
    if (state.log.length > 8) {
      state.log = state.log.slice(state.log.length - 8);
    }
  }

  function getCharacterInitials(character) {
    return String(character.name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(function (part) {
        return part.charAt(0);
      })
      .join("")
      .toUpperCase() || "?";
  }

  function isSampleCharacter(character) {
    return false;
  }

  function getDeleteAtMs(character) {
    if (!character || !character.deleteAt) return null;
    var value = Date.parse(character.deleteAt);
    return Number.isFinite(value) ? value : null;
  }

  function isPendingDeletion(character) {
    return !!character && !character.deletedAt && getDeleteAtMs(character) !== null;
  }

  function deletionSecondsRemaining(character) {
    var deleteAtMs = getDeleteAtMs(character);
    if (deleteAtMs === null) return 0;
    return Math.max(0, Math.ceil((deleteAtMs - Date.now()) / 1000));
  }

  function formatDeletionCountdown(seconds) {
    if (seconds <= 0) return "Deletion pending";

    var minutes = Math.floor(seconds / 60);
    var remainingSeconds = seconds % 60;
    if (minutes <= 0) return seconds + "s";
    return minutes + "m " + String(remainingSeconds).padStart(2, "0") + "s";
  }

  function updateLocalCharacter(profileId, patch) {
    var nextSelected = null;
    state.characters = state.characters.map(function (character) {
      if (String(character.profileId) !== String(profileId)) return character;
      var updated = Object.assign({}, character, patch);
      if (state.selected && String(state.selected.profileId) === String(profileId)) {
        nextSelected = updated;
      }
      return updated;
    });

    if (nextSelected) {
      state.selected = nextSelected;
    }
  }

  function clearDeletionTimer() {
    if (deletionTimer) {
      window.clearInterval(deletionTimer);
      deletionTimer = null;
    }
  }

  function updateDeletionTimer() {
    var hasPendingDeletion = state.characters.some(isPendingDeletion);
    if (!hasPendingDeletion) {
      clearDeletionTimer();
      return;
    }

    if (deletionTimer) return;

    deletionTimer = window.setInterval(function () {
      var hasPending = state.characters.some(isPendingDeletion);
      if (!hasPending) {
        clearDeletionTimer();
        return;
      }

      var hasExpired = state.characters.some(function (character) {
        return isPendingDeletion(character) && deletionSecondsRemaining(character) <= 0;
      });
      if (hasExpired && Date.now() - deletionRefreshRequestedAt > 5000) {
        deletionRefreshRequestedAt = Date.now();
        send(EVENTS.charactersRefresh);
      }

      renderCharacters();
      renderActions();
    }, 1000);
  }

  function chooseCharacter(character) {
    if (character && character.permaDead) {
      state.selected = normalizeCharacter(character);
      state.createSelected = false;
      state.queue = { position: null, total: null, status: "idle" };
      state.pendingAuth = false;
      pushLog("Selected fallen character " + state.selected.name + ".");
      setFooter("That character has passed on permanently. Delete it to free its character slot.");
      render();
      return;
    }
    state.selected = normalizeCharacter(character);
    state.createSelected = false;
    state.queue = { position: null, total: null, status: "idle" };
    state.pendingAuth = false;
    pushLog("Selected " + state.selected.name + ".");
    setFooter(state.selected.name + " selected.");
    render();
  }

  function chooseCreateCharacter() {
    state.selected = null;
    state.createSelected = true;
    state.queue = { position: null, total: null, status: "idle" };
    state.pendingAuth = false;
    setFooter("Create new character selected.");
    render();
  }

  function openDeleteConfirm() {
    if (!state.selected || state.createSelected) {
      setFooter("Select a character to delete.");
      render();
      return;
    }

    if (isPendingDeletion(state.selected)) {
      cancelCharacterDeletion();
      return;
    }

    var targetLabel = state.selected.permaDead ? "the fallen character " : "";
    dom.deleteMessage.textContent = "Are you really sure you want to delete " + targetLabel + state.selected.name
      + "? Your character will be marked for deletion and removed permanently after the grace period.";
    dom.deleteModal.hidden = false;
  }

  function closeDeleteConfirm() {
    dom.deleteModal.hidden = true;
  }

  function confirmDeleteCharacter() {
    if (!state.selected) {
      closeDeleteConfirm();
      return;
    }

    var deleted = state.selected;
    var deleteRequestedAt = new Date().toISOString();
    var deleteAt = new Date(Date.now() + DEFAULT_DELETION_GRACE_MS).toISOString();
    updateLocalCharacter(deleted.profileId, {
      deleteRequestedAt: deleteRequestedAt,
      deleteAt: deleteAt,
      deletionStartedAt: null
    });
    state.createSelected = false;
    state.queue = { position: null, total: null, status: "idle" };
    state.pendingAuth = false;

    send(EVENTS.characterDelete, {
      profileId: deleted.profileId,
      name: deleted.name
    });

    pushLog("Deletion scheduled for " + deleted.name + ".");
    setFooter(deleted.name + " will be deleted in 3 minutes.");
    updateDeletionTimer();
    closeDeleteConfirm();
    render();
  }

  function cancelCharacterDeletion() {
    if (!state.selected || state.createSelected) {
      setFooter("Select a character with pending deletion.");
      render();
      return;
    }

    var character = state.selected;
    updateLocalCharacter(character.profileId, {
      deleteRequestedAt: null,
      deleteAt: null,
      deletionStartedAt: null
    });

    send(EVENTS.characterCancelDelete, {
      profileId: character.profileId,
      name: character.name
    });

    pushLog("Cancelled deletion for " + character.name + ".");
    setFooter("Deletion cancelled for " + character.name + ".");
    updateDeletionTimer();
    render();
  }

  function loadSelectedCharacter() {
    if (state.createSelected) {
      createCharacter();
      return;
    }

    if (!state.selected) {
      setFooter("Select a character first.");
      render();
      return;
    }

    if (isPendingDeletion(state.selected)) {
      setFooter("Cancel deletion before loading this character.");
      render();
      return;
    }

    if (state.selected.permaDead) {
      setFooter("That character has passed on permanently. Delete it to free its character slot.");
      render();
      return;
    }

    selectCharacter(state.selected, "existing");
  }

  function selectCharacter(character, source) {
    state.selected = normalizeCharacter(character);
    if (isPendingDeletion(state.selected)) {
      setFooter("Cancel deletion before loading this character.");
      render();
      return;
    }

    if (state.selected.permaDead) {
      setFooter("That character has passed on permanently. Delete it to free its character slot.");
      render();
      return;
    }

    var simulateQueue = false;
    state.queue = { position: null, total: null, status: "joining" };
    state.pendingAuth = false;
    state.view = "queue";
    pushLog("Selected " + state.selected.name + ".");

    if (!simulateQueue) {
      send(EVENTS.characterSelect, {
        profileId: state.selected.profileId,
        source: source || "existing"
      });
      send(EVENTS.queueJoin, {
        profileId: state.selected.profileId,
        source: source || "existing"
      });
    }

    render();

    if (!hasSkyrimBridge()) {
      startDemoQueue();
    }
  }

  function createCharacter() {
    var draft = {
      source: "racemenu"
    };

    state.pendingCreate = draft;
    state.view = "creating";
    pushLog("Create character request sent.");
    send(EVENTS.characterCreate, draft);
    render();

    if (!hasSkyrimBridge()) {
      window.setTimeout(function () {
        confirmCharacter({
          profileId: Date.now() % 1000000,
          name: "New Character"
        });
      }, 700);
    }
  }

  function startDemoQueue() {
    clearDemoQueue();
    var total = 18;
    var position = 6;
    setQueue({
      position: position,
      total: total,
      status: "waiting",
      message: "Demo queue assigned."
    });

    demoTimer = window.setInterval(function () {
      position -= 1;
      setQueue({
        position: position,
        total: total,
        status: position <= 1 ? "ready" : "waiting"
      });
      if (position <= 1) {
        clearDemoQueue();
      }
    }, 1800);
  }

  function clearDemoQueue() {
    if (demoTimer) {
      window.clearInterval(demoTimer);
      demoTimer = null;
    }
  }

  function clearQueueReadyTimer() {
    if (queueReadyTimer) {
      window.clearTimeout(queueReadyTimer);
      queueReadyTimer = null;
    }
  }

  function scheduleQueueReadyAuth() {
    clearQueueReadyTimer();
    queueReadyTimer = window.setTimeout(function () {
      queueReadyTimer = null;
      if (state.view === "queue" && isQueueReady(state.queue)) {
        startAuth();
      }
    }, QUEUE_READY_AUTH_DELAY_MS);
  }

  function startAuth() {
    if (state.pendingAuth) return;
    clearQueueReadyTimer();
    state.pendingAuth = true;
    pushLog("Queue ready. Starting authorization.");
    showAuthStatus({
      eyebrow: "ENTERING REALM",
      title: "Authorizing session",
      message: "The game server is validating your selected profile.",
      footer: "Authorization started. Waiting for the game server."
    });

    send(EVENTS.authStart, {
      profileId: state.selected ? state.selected.profileId : null,
      queue: state.queue
    });

    // Compatibility with the current SkyMP AuthService. It reads the launcher
    // session from auth-data-no-load.js and sends that session to the game server.
    send(EVENTS.legacyAuthAttempt);
  }

  function showAuthStatus(payload) {
    payload = payload || {};
    state.pendingAuth = true;
    state.view = "auth";
    state.authStatus = {
      eyebrow: String(payload.eyebrow || "ENTERING REALM"),
      title: String(payload.title || "Authorizing session"),
      message: String(payload.message || "The game server is validating your selected profile."),
      footer: String(payload.footer || payload.message || "Authorization in progress.")
    };
    setFooter(state.authStatus.footer);
    render();
  }

  function showLoading(payload) {
    payload = payload || {};
    showAuthStatus({
      eyebrow: payload.eyebrow || "ENTERING REALM",
      title: payload.title || "Loading realm",
      message: payload.message || "Authorization accepted. Waiting for Skyrim to load your character.",
      footer: payload.footer || "Session accepted. Loading into the realm."
    });
    stopBackgroundMusic(true);
  }

  function showCharacters() {
    clearDemoQueue();
    clearQueueReadyTimer();
    if (state.view === "queue") {
      send(EVENTS.queueLeave);
    }
    state.view = "characters";
    state.selected = null;
    state.createSelected = false;
    state.queue = { position: null, total: null, status: "idle" };
    state.pendingAuth = false;
    closeDeleteConfirm();
    render();
  }

  function cacheDom() {
    dom.discordAvatar = document.getElementById("discord-avatar");
    dom.backgroundMusic = document.getElementById("background-music");
    dom.audioToggle = document.getElementById("audio-toggle");
    dom.quitGame = document.getElementById("quit-game");
    dom.discordAvatarInitial = document.getElementById("discord-avatar-initial");
    dom.discordAvatarImage = document.getElementById("discord-avatar-image");
    dom.discordUsernameLabel = document.getElementById("discord-username-label");
    dom.viewTitle = document.getElementById("view-title");
    dom.characterView = document.getElementById("character-view");
    dom.characterStage = document.querySelector(".character-stage");
    dom.creatingView = document.getElementById("creating-view");
    dom.queueView = document.getElementById("queue-view");
    dom.authView = document.getElementById("auth-view");
    dom.characterList = document.getElementById("character-list");
    dom.characterCount = document.getElementById("character-count");
    dom.loadCharacter = document.getElementById("load-character");
    dom.createCharacter = document.getElementById("create-character");
    dom.deleteCharacter = document.getElementById("delete-character");
    dom.deleteModal = document.getElementById("delete-modal");
    dom.deleteMessage = document.getElementById("delete-message");
    dom.cancelDelete = document.getElementById("cancel-delete");
    dom.confirmDelete = document.getElementById("confirm-delete");
    dom.creatingName = document.getElementById("creating-name");
    dom.queuePosition = document.getElementById("queue-position");
    dom.queueTotal = document.getElementById("queue-total");
    dom.queueProgress = document.getElementById("queue-progress");
    dom.authEyebrow = dom.authView.querySelector(".small-label");
    dom.authTitle = dom.authView.querySelector("h3");
    dom.authMessage = dom.authView.querySelector(".muted");
    dom.backToCharacters = document.getElementById("back-to-characters");
    dom.footerStatus = document.getElementById("footer-status");
  }

  function bindEvents() {
    dom.loadCharacter.addEventListener("click", loadSelectedCharacter);
    dom.createCharacter.addEventListener("click", chooseCreateCharacter);
    dom.deleteCharacter.addEventListener("click", openDeleteConfirm);
    dom.cancelDelete.addEventListener("click", closeDeleteConfirm);
    dom.confirmDelete.addEventListener("click", confirmDeleteCharacter);
    dom.backToCharacters.addEventListener("click", showCharacters);
    dom.audioToggle.addEventListener("click", toggleBackgroundMusic);
    dom.quitGame.addEventListener("click", quitGame);
    dom.createCharacter.addEventListener("mouseenter", function () {
      playSfx("hover");
    });
    if (!documentPointerBound) {
      document.addEventListener("pointerup", handleUiPointerRelease, true);
      documentPointerBound = true;
    }
    bindMusicStateEvents();
  }

  function rehydrateRestoredLoginLayer() {
    musicRetryBound = false;
    musicStartOffsetApplied = false;
    cacheDom();
    bindEvents();
    render();
    startBackgroundMusicOnLoad();
    loadAuthDataFromFile();
  }

  function render() {
    renderHeader();
    renderViews();
    renderCharacters();
    renderActions();
    renderCreating();
    renderQueue();
    renderAuthStatus();
    renderMusicToggle();
  }

  function renderHeader() {
    var labels = {
      characters: "Select Character",
      creating: "Create Character",
      queue: "Waiting In Queue",
      auth: "Authorizing"
    };
    var active = labels[state.view] || labels.characters;
    dom.viewTitle.textContent = active;
    if (dom.discordUsernameLabel) {
      dom.discordUsernameLabel.textContent = state.user.username || DEFAULT_DISCORD_USERNAME;
    }

    var initial = (state.user.username || "?").trim().charAt(0) || "?";
    dom.discordAvatarInitial.textContent = initial;
    if (state.user.avatar) {
      dom.discordAvatarImage.src = state.user.avatar;
      dom.discordAvatar.classList.add("has-image");
    } else {
      dom.discordAvatarImage.removeAttribute("src");
      dom.discordAvatar.classList.remove("has-image");
    }
  }

  function renderViews() {
    [
      [dom.characterView, "characters"],
      [dom.creatingView, "creating"],
      [dom.queueView, "queue"],
      [dom.authView, "auth"]
    ].forEach(function (entry) {
      entry[0].classList.toggle("view-active", state.view === entry[1]);
    });
  }

  function renderCharacters() {
    var usedSlots = state.characters.length;
    var freeSlots = Math.max(0, state.maxCharacterSlots - usedSlots);
    var slotText = usedSlots + "/" + state.maxCharacterSlots + " slots used";
    slotText += " - " + freeSlots + (freeSlots === 1 ? " slot free" : " slots free");
    dom.characterCount.textContent = slotText;
    dom.characterList.innerHTML = "";

    if (state.characters.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "No characters available yet.";
      dom.characterList.appendChild(empty);
      return;
    }

    state.characters.forEach(function (character) {
      var pendingDeletion = isPendingDeletion(character);
      var card = document.createElement("button");
      card.type = "button";
      card.className = "character-card";
      if (pendingDeletion) {
        card.classList.add("pending-deletion");
      }
      if (character.permaDead) {
        card.classList.add("perma-dead");
      }
      if (state.selected && String(state.selected.profileId) === String(character.profileId)) {
        card.classList.add("selected");
      }

      var portrait = document.createElement("div");
      portrait.className = "character-portrait";

      if (pendingDeletion) {
        var deletionNotice = document.createElement("div");
        deletionNotice.className = "deletion-countdown";

        var deletionLabel = document.createElement("span");
        deletionLabel.textContent = "Will be deleted in";

        var deletionTime = document.createElement("strong");
        deletionTime.textContent = formatDeletionCountdown(deletionSecondsRemaining(character));

        deletionNotice.appendChild(deletionLabel);
        deletionNotice.appendChild(deletionTime);
        portrait.appendChild(deletionNotice);
      } else {
        var portraitImage = document.createElement("img");
        portraitImage.src = character.portrait || DEFAULT_CHARACTER_PORTRAIT;
        portraitImage.alt = "";
        portraitImage.onerror = function () {
          if (portraitImage.src.indexOf("portrait-template.png") === -1) {
            portraitImage.src = DEFAULT_CHARACTER_PORTRAIT;
            return;
          }

          portrait.classList.add("portrait-missing");
          portraitImage.removeAttribute("src");
        };

        var initials = document.createElement("span");
        initials.textContent = getCharacterInitials(character);
        portrait.appendChild(portraitImage);
        portrait.appendChild(initials);

        if (character.permaDead) {
          var skull = document.createElement("div");
          skull.className = "perma-skull";
          var skullIcon = document.createElement("strong");
          skullIcon.textContent = "☠";
          var skullLabel = document.createElement("span");
          skullLabel.textContent = "Fallen";
          skull.appendChild(skullIcon);
          skull.appendChild(skullLabel);
          portrait.appendChild(skull);
        }
      }

      var info = document.createElement("div");
      info.className = "character-info";

      var title = document.createElement("strong");
      title.textContent = character.name;

      info.appendChild(title);
      card.appendChild(portrait);
      card.appendChild(info);
      card.addEventListener("click", function () {
        chooseCharacter(character);
      });
      card.addEventListener("mouseenter", function () {
        playSfx("hover");
      });
      dom.characterList.appendChild(card);
    });

    updateDeletionTimer();
  }

  function renderActions() {
    var pendingSelectedDeletion = isPendingDeletion(state.selected);
    if (dom.loadCharacter) {
      var selectedFallen = !!(state.selected && state.selected.permaDead);
      dom.loadCharacter.disabled = (!state.selected && !state.createSelected) || pendingSelectedDeletion || selectedFallen;
      dom.loadCharacter.textContent = state.createSelected ? "Create Character" : selectedFallen ? "Character Unavailable" : "Load Character";
    }

    if (dom.createCharacter) {
      dom.createCharacter.classList.toggle("selected", state.createSelected);
      dom.createCharacter.disabled = state.characters.length >= state.maxCharacterSlots;
    }

    if (dom.deleteCharacter) {
      dom.deleteCharacter.disabled = !state.selected || state.createSelected;
      dom.deleteCharacter.textContent = pendingSelectedDeletion
        ? "Cancel Deletion"
        : state.selected && state.selected.permaDead
          ? "Delete Fallen Character"
          : "Delete Character";
      dom.deleteCharacter.classList.toggle("cancel-deletion", pendingSelectedDeletion);
    }
  }

  function renderCreating() {
    dom.creatingName.textContent = "Character request sent";
  }

  function renderAuthStatus() {
    var status = state.authStatus || {};
    if (dom.authEyebrow) dom.authEyebrow.textContent = status.eyebrow || "ENTERING REALM";
    if (dom.authTitle) dom.authTitle.textContent = status.title || "Authorizing session";
    if (dom.authMessage) dom.authMessage.textContent = status.message || "The game server is validating your selected profile.";
    if (state.view === "auth") {
      setFooter(status.footer || status.message || "Authorization in progress.");
    }
  }

  function renderQueue() {
    var position = state.queue.position;
    var total = state.queue.total;

    dom.queuePosition.textContent = position == null ? "-" : String(position);
    dom.queueTotal.textContent = total == null ? "of - players" : "of " + total + " players";

    var progress = 0;
    if (position != null && total) {
      progress = Math.max(0, Math.min(100, Math.round(((total - position + 1) / total) * 100)));
    }
    dom.queueProgress.style.width = progress + "%";

    if (state.view === "queue") {
      if (state.queue.message) {
        setFooter(state.queue.message);
      } else if (position == null) {
        setFooter("Waiting for queue placement from backend.");
      } else if (isQueueReady(state.queue)) {
        setFooter("Queue ready. Starting authorization.");
      } else {
        setFooter("Queue position " + position + " of " + total + ".");
      }
    }
  }

  function exposeApi() {
    window.VGRLoginUI = {
      events: EVENTS,
      setCharacters: setCharacters,
      confirmCharacter: confirmCharacter,
      setUser: setUser,
      chooseCharacter: chooseCharacter,
      chooseCreateCharacter: chooseCreateCharacter,
      quitGame: quitGame,
      loadSelectedCharacter: loadSelectedCharacter,
      setQueue: setQueue,
      queueUpdate: setQueue,
      setError: setError,
      showCharacters: showCharacters,
      restoreForAuth: restoreForAuth,
      reloadForMainMenu: reloadForMainMenu,
      hideAfterSuccessfulAuth: hideAfterSuccessfulAuth,
      stopBackgroundMusic: stopBackgroundMusic,
      showAuthStatus: showAuthStatus,
      showLoading: showLoading,
      startAuth: startAuth,
      getState: function () {
        return JSON.parse(JSON.stringify(state));
      }
    };
  }

  function init() {
    ensureBridge();
    cacheDom();
    preloadSfx();
    bindEvents();
    exposeApi();
    window.addEventListener("vgr:login:restored", rehydrateRestoredLoginLayer);
    render();

    send(EVENTS.frontLoaded);
    loadAuthDataFromFile();
    startBackgroundMusicOnLoad();
    setFooter(hasSkyrimBridge()
      ? "Interface loaded. Waiting for character data."
      : "Standalone preview mode.");

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
