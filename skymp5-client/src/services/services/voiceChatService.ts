import { logTrace, logError } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getViewFromStorage } from "../../view/worldViewMisc";
import { Actor } from "skyrimPlatform";

// Voice chat modes matching C++ VoiceChat::VoiceMode enum
const VOICE_MODE_PROXIMITY = 0;
const VOICE_MODE_GLOBAL = 1;

// Default push-to-talk key (V = DxScanCode 47)
const DEFAULT_PTT_KEY = 47;

// MFG phoneme 0 is the open-mouth Aah driver.
const MOUTH_PHONEME_AAH = 0;

// Minimum interval between reconnect attempts (ms)
const RECONNECT_COOLDOWN_MS = 5000;

export class VoiceChatService extends ClientListener {
  private voiceChatAvailable = false;
  private pttKey = DEFAULT_PTT_KEY;
  private localPttKey: number | null = null;
  private pttPressed = false;
  private lastReconnectRequestTime = 0;
  // Maps LiveKit identity -> server-side actor refrId
  private voiceParticipantMap = new Map<string, number>();
  // Last phoneme value applied to each mapped voice participant. Keeping this
  // state avoids redundant native face updates while still tracking speech.
  private mouthPhonemeValues = new Map<string, { localRefrId: number; value: number }>();

  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    // Launcher-written binding wins over the server's voiceConfig pttKey
    this.localPttKey = this.readLocalKeyOverride("voicePushToTalkKeyCode");
    if (this.localPttKey !== null) {
      this.pttKey = this.localPttKey;
    }

    // Overrides go to the CEF page even without native voice; gamemode UI code reads them there
    this.injectKeyOverrides();
    this.controller.emitter.on("browserWindowLoaded", () => this.injectKeyOverrides());

    // Check if voice chat functions exist on the native plugin
    this.voiceChatAvailable = typeof this.sp.mpClientPlugin?.initVoiceChat === "function";
    if (!this.voiceChatAvailable) {
      logTrace(this, "Voice chat not available (MpClientPlugin built without SKYMP_VOICE_CHAT_ENABLED)");
      return;
    }

    this.controller.on("tick", () => this.onTick());
    this.controller.on("update", () => {
      try { this.handlePTT(); }
      catch (e) { logError(this, "handlePTT error: " + String(e)); }
      try { this.updateSpatialPositions(); }
      catch (e) { logError(this, "updateSpatialPositions error: " + String(e)); }
    });
    this.controller.emitter.on("connectionDisconnect", () => this.onDisconnected());

    // Voice config arrives via customPacket AFTER the server creates
    // the player's actor (onPlayerLoaded server-side). We do NOT init
    // voice on connectionAccepted — only when we receive the config,
    // which the server sends only after the actor exists in the world.
    this.controller.emitter.on("customPacketMessage", (e) => {
      try {
        const parsed = JSON.parse(e.message?.contentJsonDump || "{}");
        if (parsed.customPacketType === "voiceConfig") {
          this.onVoiceConfig(parsed);
        } else if (parsed.customPacketType === "voiceParticipantMap") {
          this.onVoiceParticipantMap(parsed);
        }
      } catch (_) { /* ignore parse errors from other packets */ }
    });

    logTrace(this, "Voice chat service initialized");
  }

  // Reads a DxScanCode binding written by the launcher into skymp5-client-settings.txt
  private readLocalKeyOverride(settingName: string): number | null {
    try {
      const settings = this.sp.settings["skymp5-client"] as Record<string, unknown> | undefined;
      const value = settings ? settings[settingName] : undefined;
      if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 0xff) {
        return value;
      }
    } catch (_) {
      // settings block missing, fall through
    }
    return null;
  }

  // Publishes launcher key overrides to the CEF page as window.vgrKeyOverrides
  // Gamemode-injected browser code reads modeKey/adminMenuKey from there
  private injectKeyOverrides() {
    const overrides = {
      pttKey: this.localPttKey,
      modeKey: this.readLocalKeyOverride("voiceModeCycleKeyCode"),
      adminMenuKey: this.readLocalKeyOverride("adminMenuKeyCode"),
      socialKey: this.readLocalKeyOverride("socialMenuKeyCode"),
      emoteKey: this.readLocalKeyOverride("emoteMenuKeyCode"),
      skillsKey: this.readLocalKeyOverride("skillsMenuKeyCode"),
      interactKey: this.readLocalKeyOverride("interactMenuKeyCode"),
    };
    try {
      this.sp.browser.executeJavaScript(`window.vgrKeyOverrides = ${JSON.stringify(overrides)};`);
    } catch (e) {
      logTrace(this, "injectKeyOverrides failed: " + String(e));
    }
  }

  private onDisconnected() {
    this.shutdownVoice();
  }

  private onVoiceConfig(config: {
    customPacketType: string;
    livekitUrl: string;
    token: string;
    sampleRate?: number;
    numChannels?: number;
    pttKey?: number;
    voiceMode?: number;
    inputGain?: number;
    outputVolume?: number;
    voiceRange?: number;
    noiseGateEnabled?: boolean;
    noiseGateThreshold?: number;
    normalizationEnabled?: boolean;
    normalizationTarget?: number;
  }) {
    if (!this.voiceChatAvailable) return;

    logTrace(this, `Received voice config: LiveKit URL=${config.livekitUrl}`);

    // Shutdown existing voice if any
    this.shutdownVoice();

    // Configure PTT key; the launcher-written local binding beats the server value
    if (this.localPttKey !== null) {
      this.pttKey = this.localPttKey;
    } else if (config.pttKey !== undefined) {
      this.pttKey = config.pttKey;
    }

    // Initialize voice chat
    const sampleRate = config.sampleRate || 48000;
    const numChannels = config.numChannels || 1;

    const success = this.sp.mpClientPlugin.initVoiceChat!(
      config.livekitUrl, config.token, sampleRate, numChannels
    );

    if (!success) {
      logError(this, "Failed to initialize voice chat");
      return;
    }

    logTrace(this, "Voice chat initialized successfully");

    // Apply settings
    if (config.voiceMode !== undefined) {
      this.sp.mpClientPlugin.setVoiceMode!(config.voiceMode);
    }
    if (config.inputGain !== undefined) {
      this.sp.mpClientPlugin.setVoiceInputGain!(config.inputGain);
    }
    if (config.outputVolume !== undefined) {
      this.sp.mpClientPlugin.setVoiceOutputVolume!(config.outputVolume);
    }
    if (config.voiceRange !== undefined && this.sp.mpClientPlugin.setVoiceRange) {
      this.sp.mpClientPlugin.setVoiceRange(config.voiceRange);
    }

    // Mic post-processing: noise gate
    if (config.noiseGateEnabled !== undefined && this.sp.mpClientPlugin.setVoiceNoiseGateEnabled) {
      this.sp.mpClientPlugin.setVoiceNoiseGateEnabled(config.noiseGateEnabled);
    }
    if (config.noiseGateThreshold !== undefined && this.sp.mpClientPlugin.setVoiceNoiseGateThreshold) {
      this.sp.mpClientPlugin.setVoiceNoiseGateThreshold(config.noiseGateThreshold);
    }

    // Mic post-processing: volume normalization (AGC)
    if (config.normalizationEnabled !== undefined && this.sp.mpClientPlugin.setVoiceNormalizationEnabled) {
      this.sp.mpClientPlugin.setVoiceNormalizationEnabled(config.normalizationEnabled);
    }
    if (config.normalizationTarget !== undefined && this.sp.mpClientPlugin.setVoiceNormalizationTarget) {
      this.sp.mpClientPlugin.setVoiceNormalizationTarget(config.normalizationTarget);
    }
  }

  private onVoiceParticipantMap(data: {
    customPacketType: string;
    participants: Record<string, number>;
  }) {
    this.voiceParticipantMap.clear();
    if (data.participants) {
      const keys = Object.keys(data.participants);
      for (let i = 0; i < keys.length; i++) {
        this.voiceParticipantMap.set(keys[i], data.participants[keys[i]]);
      }
    }
  }

  private onTick() {
    if (!this.voiceChatAvailable) return;

    // Only process voice if initialized
    if (!this.sp.mpClientPlugin.isVoiceChatInitialized?.()) return;

    // Tick voice chat (processes LiveKit events, registers new participants)
    this.sp.mpClientPlugin.tickVoiceChat!();
    this.updateMouthMovement();

    // Check if the LiveKit connection was lost and we need a fresh token.
    // This handles the case where LiveKit's built-in reconnect failed
    // (e.g. network was down for > 30s or token expired).
    if (this.sp.mpClientPlugin.needsVoiceReconnect?.()) {
      const now = Date.now();
      if (now - this.lastReconnectRequestTime >= RECONNECT_COOLDOWN_MS) {
        this.lastReconnectRequestTime = now;
        logTrace(this, "Voice disconnected — requesting fresh token from game server");

        // Shut down the dead voice session
        this.shutdownVoice();

        // Request a new voiceConfig by sending a custom packet to the server.
        // The server will generate a new JWT and send it back via CustomPacket.
        this.controller.emitter.emit("sendMessage", {
          message: {
            t: MsgType.CustomPacket,
            contentJsonDump: JSON.stringify({ customPacketType: "voiceReconnectRequest" })
          },
          reliability: "reliable"
        });
      }
    }

  }

  private updateSpatialPositions() {
    if (!this.sp.mpClientPlugin.setVoiceListenerPosition) return;
    if (!this.sp.mpClientPlugin.setVoiceParticipantPosition) return;

    // Update listener (local player) position and facing direction
    try {
      const player = this.sp.Game.getPlayer();
      if (player) {
        const px = player.getPositionX();
        const py = player.getPositionY();
        const pz = player.getPositionZ();
        const angleZ = player.getAngleZ() * (Math.PI / 180.0);
        const dirX = Math.sin(angleZ);
        const dirY = Math.cos(angleZ);
        this.sp.mpClientPlugin.setVoiceListenerPosition!(px, py, pz, dirX, dirY, 0);
      } else {
        logTrace(this, "setVoiceListenerPosition skipped: player is null");
      }
    } catch (e: any) {
      logTrace(this, `setVoiceListenerPosition error: ${e?.message || e}`);
    }

    // Update positions for each remote participant using their in-game actor
    const view = getViewFromStorage();
    if (!view) return;

    this.voiceParticipantMap.forEach((serverRefrId, identity) => {
      // Only server-assigned 0xff... refs can be looked up
      if (serverRefrId < 0xff000000) return;

      let localRefrId: number;
      try {
        localRefrId = view.getLocalRefrId(serverRefrId);
      } catch (_) {
        return;
      }
      if (!localRefrId || localRefrId <= 0) return;

      const refr = this.sp.ObjectReference.from(this.sp.Game.getFormEx(localRefrId));
      if (!refr) return;

      const x = refr.getPositionX();
      const y = refr.getPositionY();
      const z = refr.getPositionZ();
      this.sp.mpClientPlugin.setVoiceParticipantPosition!(identity, x, y, z);
    });

  }

  private updateMouthMovement() {
    if (!this.sp.mpClientPlugin.getVoiceParticipantActivity) return;

    let activity: Record<string, number> = {};
    try {
      const parsed = JSON.parse(this.sp.mpClientPlugin.getVoiceParticipantActivity!());
      if (parsed && typeof parsed === "object") {
        activity = parsed as Record<string, number>;
      }
    } catch (e) {
      logTrace(this, `Voice activity parse failed: ${String(e)}`);
      return;
    }

    const view = getViewFromStorage();
    if (!view) return;

    const activeIdentities = new Set<string>();
    this.voiceParticipantMap.forEach((serverRefrId, identity) => {
      activeIdentities.add(identity);

      let localRefrId: number;
      try {
        if (serverRefrId < 0xff000000) return;
        localRefrId = view.getLocalRefrId(serverRefrId);
      } catch (_) {
        return;
      }
      if (!localRefrId || localRefrId <= 0) return;

      let actor: Actor | null;
      try {
        actor = this.sp.Actor.from(this.sp.Game.getFormEx(localRefrId));
      } catch (_) {
        return;
      }
      if (!actor) return;

      const rawLevel = Number(activity[identity]);
      const level = Number.isFinite(rawLevel)
        ? Math.max(0, Math.min(1, rawLevel))
        : 0;
      const previous = this.mouthPhonemeValues.get(identity);
      if (previous && previous.localRefrId === localRefrId &&
          Math.abs(previous.value - level) < 0.02) {
        return;
      }

      try {
        if (previous && previous.localRefrId !== localRefrId) {
          this.clearMouthForLocalRefr(previous.localRefrId);
        }
        actor.setExpressionPhoneme(MOUTH_PHONEME_AAH, level);
        this.mouthPhonemeValues.set(identity, { localRefrId, value: level });
      } catch (_) {
        // The actor may be unloading between the view lookup and this tick.
      }
    });

    this.mouthPhonemeValues.forEach((previous, identity) => {
      if (activeIdentities.has(identity)) return;
      this.clearMouthForLocalRefr(previous.localRefrId);
      this.mouthPhonemeValues.delete(identity);
    });
  }

  private clearMouthForLocalRefr(localRefrId: number) {
    try {
      const actor = this.sp.Actor.from(this.sp.Game.getFormEx(localRefrId));
      actor?.setExpressionPhoneme(MOUTH_PHONEME_AAH, 0);
    } catch (_) {
      // The actor may already have been destroyed.
    }
  }

  private handlePTT() {
    if (!this.voiceChatAvailable) return;
    if (!this.sp.mpClientPlugin.isVoiceChatInitialized?.()) return;

    let keyPressed: boolean;
    try {
      keyPressed = this.sp.Input.isKeyPressed(this.pttKey);
    } catch (_) {
      return;
    }

    if (keyPressed && !this.pttPressed) {
      // Key just pressed — start talking
      this.pttPressed = true;
      logTrace(this, "PTT pressed — start talking");
      this.sp.mpClientPlugin.startTalking!();
    } else if (!keyPressed && this.pttPressed) {
      // Key just released — stop talking
      this.pttPressed = false;
      logTrace(this, "PTT released — stop talking");
      this.sp.mpClientPlugin.stopTalking!();
    }
  }

  private shutdownVoice() {
    if (!this.voiceChatAvailable) return;

    this.mouthPhonemeValues.forEach(({ localRefrId }) => {
      this.clearMouthForLocalRefr(localRefrId);
    });
    this.mouthPhonemeValues.clear();

    if (this.sp.mpClientPlugin.isVoiceChatInitialized?.()) {
      this.sp.mpClientPlugin.shutdownVoiceChat!();
      this.pttPressed = false;
      logTrace(this, "Voice chat shut down");
    }
  }
}
