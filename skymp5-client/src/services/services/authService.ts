import * as crypto from "crypto";
import * as fs from "fs";
import { AuthGameData, RemoteAuthGameData, authGameDataStorageKey } from "../../features/authModel";
import { FunctionInfo } from "../../lib/functionInfo";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, HttpHeaders, Menu, browser } from "skyrimPlatform";
import { AuthNeededEvent } from "../events/authNeededEvent";
import { BrowserWindowLoadedEvent } from "../events/browserWindowLoadedEvent";
import { TimersService } from "./timersService";
import { MasterApiAuthStatus } from "../messages_http/masterApiAuthStatus";
import { logTrace, logError } from "../../logging";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { NetworkingService } from "./networkingService";
import { MsgType } from "../../messages";
import { ConnectionDenied } from "../events/connectionDenied";
import { SettingsService } from "./settingsService";
import { getClientLoadOrder } from "./clientLoadOrder";

// for browsersideWidgetSetter
declare const window: any;

// Constants used on both client and browser side (see browsersideWidgetSetter)
const events = {
  openDiscordOauth: 'openDiscordOauth',
  authAttempt: 'authAttemptEvent',
  legacyAuthAttempt: 'authAttempt',
  openGithub: 'openGithub',
  openPatreon: 'openPatreon',
  clearAuthData: 'clearAuthData',
  updateRequired: 'updateRequired',
  backToLogin: 'backToLogin',
  joinDiscord: 'joinDiscord',
  authStart: 'vgr:auth:start',
  characterSelect: 'vgr:character:select',
  characterCreate: 'vgr:character:create',
  characterDelete: 'vgr:character:delete',
  characterCancelDelete: 'vgr:character:cancel-delete',
  charactersRefresh: 'vgr:characters:refresh',
  queueJoin: 'vgr:queue:join',
  queueLeave: 'vgr:queue:leave',
  queueWsOpen: 'vgr:queue:ws-open',
  queueWsClosed: 'vgr:queue:ws-closed',
  banned: 'vgr:banned',
};

// Vaiables used on both client and browser side (see browsersideWidgetSetter)
let browserState = {
  comment: '',
  failCount: 9000,
  loginFailedReason: '',
};
let authData: RemoteAuthGameData | null = null;

const translations = {
  "ru": {
    loginViaDiscord: 'войдите через discord',
    joinDiscordServer: 'вступите в discord сервер',
    banned: 'вы забанены',
    whatWasThat: 'что это было?',
    openingBrowser: 'открываем браузер...',
    loginFirst: 'сначала войдите',
    linkedSuccessfully: 'привязан успешно',
    connecting: 'подключение',
    technicalIssues: 'технические шоколадки\nпопробуйте еще раз\nпожалуйста\nили напишите нам в discord',
    authorization: 'Авторизация',
    notAuthorized: 'не авторизирован',
    changeAccount: 'сменить аккаунт',
    loginViaSkymp: 'войти через skymp',
    play: 'Играть',
    loginOrChangeHint: 'Вы можете войти или поменять аккаунт',
    connectToServer: 'Подключиться к игровому серверу',
    updateCaption: 'новинка',
    updateAvailable: 'ура! вышло обновление',
    downloadAt: 'спешите скачать на',
    openSkympNet: 'открыть skymp.net',
    updateDownloadHint: 'Перейти на страницу скачивания обновления',
    oops: 'упс',
    join: 'вступить',
    back: 'назад',
  },
  "en": {
    loginViaDiscord: 'log in via Discord',
    joinDiscordServer: 'join the Discord server',
    banned: 'you are banned',
    whatWasThat: 'what was that?',
    openingBrowser: 'opening browser...',
    loginFirst: 'log in first',
    linkedSuccessfully: 'linked successfully',
    connecting: 'connecting',
    technicalIssues: 'technical difficulties\nplease try again\nor contact us on Discord',
    authorization: 'Authorization',
    notAuthorized: 'not authorized',
    changeAccount: 'change account',
    loginViaSkymp: 'log in via skymp',
    play: 'Play',
    loginOrChangeHint: 'You can log in or change your account',
    connectToServer: 'Connect to game server',
    updateCaption: 'Update',
    updateAvailable: 'a new update is available!',
    downloadAt: 'download it at',
    openSkympNet: 'open skymp.net',
    updateDownloadHint: 'Go to the update download page',
    oops: 'oops',
    join: 'join',
    back: 'back',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['en']]: string };

let strings: TranslationStrings = translations['en'];

try {
  const lang = fs.readFileSync('./Data/Platform/Distribution/locale', 'utf8').trim();
  if (lang in translations) {
    strings = translations[lang as keyof typeof translations];
    const src = `window.setLanguage(${lang})`;
    browser.executeJavaScript(src);
  }
} catch {
  // locale file not found or unreadable, default to 'en'
}

export class AuthService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("authNeeded", (e) => this.onAuthNeeded(e));
    this.controller.emitter.on("browserWindowLoaded", (e) => this.onBrowserWindowLoaded(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.emitter.on("connectionAccepted", () => this.handleConnectionAccepted());
    this.controller.emitter.on("connectionDenied", (e) => this.handleConnectionDenied(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("tick", () => this.onTick());
    this.controller.once("update", () => this.onceUpdate());
  }

  private onAuthNeeded(e: AuthNeededEvent) {
    logTrace(this, `Received authNeeded event`);

    const settingsGameData = this.sp.settings["skymp5-client"]["gameData"] as any;
    const isOfflineMode = Number.isInteger(settingsGameData?.profileId);
    if (isOfflineMode) {
      logTrace(this, `Offline mode detected in settings, emitting auth event with authGameData.local`);
      this.controller.emitter.emit("authAttempt", { authGameData: { local: { profileId: settingsGameData.profileId } } });
    } else {
      logTrace(this, `No offline mode detectted in settings, regular auth needed`);
      this.setListenBrowserMessage(true, 'authNeeded event received');

      this.trigger.authNeededFired = true;
      if (this.trigger.conditionMet) {
        this.onBrowserWindowLoadedAndOnlineAuthNeeded();
      }
    }
  }

  private onBrowserWindowLoaded(e: BrowserWindowLoadedEvent) {
    logTrace(this, `Received browserWindowLoaded event`);

    this.trigger.browserWindowLoadedFired = true;
    if (this.trigger.conditionMet) {
      this.onBrowserWindowLoadedAndOnlineAuthNeeded();
    }

    if (this.pendingGameplayFrontendReason) {
      this.enterGameplayFrontend(this.pendingGameplayFrontendReason);
    }
  }

  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>) {
    if (e.message.isMe) {
      this.completeLoginQueue();
      if (this.authDialogOpen) {
        logTrace(this, `Received createActorMessage for self, resetting widgets`);
        this.sp.browser.executeJavaScript('window.skyrimPlatform.widgets.set([]);');
        this.authDialogOpen = false;
      } else {
        logTrace(this, `Received createActorMessage for self, but auth dialog was not open so not resetting widgets`);
      }
      this.hideLoginUiAfterSuccessfulAuth();
    }

    this.loggingStartMoment = 0;
    this.authAttemptProgressIndicator = false;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const msg = event.message;

    let msgContent: Record<string, unknown> = {};

    try {
      msgContent = JSON.parse(msg.contentJsonDump);
    } catch (e) {
      if (e instanceof SyntaxError) {
        logError(this, "onCustomPacketMessage failed to parse JSON", e.message, "json:", msg.contentJsonDump);
        return;
      } else {
        throw e;
      }
    }

    switch (msgContent["customPacketType"]) {
      // case 'loginRequired':
      //   logTrace(this, 'loginRequired received');
      //   this.loginWithSkympIoCredentials();
      //   break;
      case 'loginFailedNotLoggedViaDiscord':
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedNotLoggedViaDiscord received');
        browserState.loginFailedReason = strings.loginViaDiscord;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedNotLoggedViaDiscord received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'loginFailedNotInTheDiscordServer':
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedNotInTheDiscordServer received');
        browserState.loginFailedReason = strings.joinDiscordServer;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedNotInTheDiscordServer received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'loginFailedBanned':
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedBanned received');
        this.showBannedAndQuit();
        break;
      case 'loginFailedIpMismatch':
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedIpMismatch received');
        browserState.loginFailedReason = strings.whatWasThat;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedIpMismatch received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'loginFailedLoadOrderMismatch':
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        {
          const reason = String(msgContent["reason"] || "load order mismatch");
          const expectedCount = Number(msgContent["expectedCount"]);
          const receivedCount = Number(msgContent["receivedCount"]);
          const countText = Number.isFinite(expectedCount) && Number.isFinite(receivedCount)
            ? ` Server expected ${expectedCount} plugins, client reported ${receivedCount}.`
            : '';
          logTrace(this, 'loginFailedLoadOrderMismatch received', JSON.stringify(msgContent));
          logError(this, `Login blocked by server: load order mismatch (${reason}).${countText}`);
          browserState.comment = `Login blocked: ${reason}.${countText} Check your MO2 profile load order and try again.`;
        }
        browserState.loginFailedReason = 'Load order mismatch';
        this.setListenBrowserMessage(true, 'loginFailedLoadOrderMismatch received');
        this.loggingStartMoment = 0;
        this.sp.browser.setVisible(true);
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'vgrCharacterKill':
        // The server retired this character (permadeath). Return to character select.
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        {
          const reason = String(msgContent["reason"] || "This character can no longer be played.");
          logTrace(this, 'vgrCharacterKill received', JSON.stringify(msgContent));
          browserState.comment = reason;
        }
        browserState.loginFailedReason = 'Character retired';
        this.setListenBrowserMessage(true, 'vgrCharacterKill received');
        this.loggingStartMoment = 0;
        this.sp.browser.setVisible(true);
        this.sp.browser.setFocused(true);
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
    }
  }

  private onBrowserWindowLoadedAndOnlineAuthNeeded() {
    if (!this.isListenBrowserMessage) {
      logError(this, `isListenBrowserMessage was false for some reason, aborting auth`);
      return;
    }

    logTrace(this, `Showing widgets and starting loop`);

    this.restoreLoginUiForAuth();
    authData = this.readAuthDataFromDisk();
    this.refreshWidgets();
    this.refreshLoginUi();
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);

    const timersService = this.controller.lookupListener(TimersService);

    logTrace(this, "Calling setTimeout for testing");
    try {
      timersService.setTimeout(() => {
        logTrace(this, "Test timeout fired");
      }, 1);
    } catch (e) {
      logError(this, "Failed to call setTimeout");
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    if (!this.isListenBrowserMessage) {
      logTrace(this, `onBrowserMessage: isListenBrowserMessage was false, ignoring message`, JSON.stringify(e.arguments));
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);

    logTrace(this, `onBrowserMessage:`, JSON.stringify(e.arguments));

    const eventKey = e.arguments[0];
    switch (eventKey) {
      case events.openDiscordOauth:
        browserState.comment = strings.openingBrowser;
        this.refreshWidgets();
        this.sp.win32.loadUrl(`${settingsService.getMasterUrl()}/api/users/login-discord?state=${this.discordAuthState}`);

        // Launch checkLoginState loop
        this.checkLoginState();
        break;
      case events.authAttempt:
      case events.legacyAuthAttempt:
        if (authData === null) {
          browserState.comment = strings.loginFirst;
          this.refreshWidgets();
          this.setLoginUiError(strings.loginFirst);
          break;
        }

        this.applySelectedProfileToPlaySession((error) => {
          if (error) {
            browserState.comment = error;
            this.refreshWidgets();
            this.setLoginUiError(error);
            return;
          }

          const remoteAuthData = authData;
          if (remoteAuthData === null) {
            browserState.comment = strings.loginFirst;
            this.refreshWidgets();
            this.setLoginUiError(strings.loginFirst);
            return;
          }

          this.writeAuthDataToDisk(remoteAuthData);
          logTrace(this, 'Emitting authAttempt for profileId:', remoteAuthData.masterApiId);
          this.showLoginUiAuthorizing();
          this.controller.emitter.emit("authAttempt", { authGameData: { remote: remoteAuthData } });
          this.authAttemptProgressIndicator = true;
        });

        break;
      case events.authStart:
        {
          const payload = this.parseBrowserPayload(e.arguments[1]) as { profileId?: unknown };
          const profileId = Number(payload.profileId);
          this.selectedProfileId = Number.isInteger(profileId) ? profileId : null;
          logTrace(this, `Selected auth profileId:`, this.selectedProfileId);
        }
        break;
      case events.characterSelect:
        {
          const payload = this.parseBrowserPayload(e.arguments[1]) as { profileId?: unknown };
          const profileId = Number(payload.profileId);
          this.selectedProfileId = Number.isInteger(profileId) ? profileId : null;
          logTrace(this, `Selected character profileId:`, this.selectedProfileId);
        }
        break;
      case events.characterCreate:
        this.createLoginUiCharacter();
        break;
      case events.characterDelete:
        {
          const payload = this.parseBrowserPayload(e.arguments[1]) as { profileId?: unknown };
          const profileId = Number(payload.profileId);
          if (Number.isInteger(profileId)) {
            this.deleteLoginUiCharacter(profileId);
          } else {
            this.setLoginUiError('Invalid character delete request.');
          }
        }
        break;
      case events.characterCancelDelete:
        {
          const payload = this.parseBrowserPayload(e.arguments[1]) as { profileId?: unknown };
          const profileId = Number(payload.profileId);
          if (Number.isInteger(profileId)) {
            this.cancelLoginUiCharacterDeletion(profileId);
          } else {
            this.setLoginUiError('Invalid character deletion cancellation request.');
          }
        }
        break;
      case events.charactersRefresh:
        this.loadLoginUiCharacters();
        break;
      case events.queueJoin:
        {
          const payload = this.parseBrowserPayload(e.arguments[1]) as { profileId?: unknown };
          const profileId = Number(payload.profileId);
          if (Number.isInteger(profileId)) {
            this.joinLoginQueue(profileId);
          } else {
            this.setLoginUiError('Select a character before joining queue.');
          }
        }
        break;
      case events.queueLeave:
        this.leaveLoginQueue();
        this.loadLoginUiCharacters();
        break;
      case events.queueWsOpen:
        this.queueWsConnected = true;
        logTrace(this, 'Queue WebSocket connected');
        break;
      case events.queueWsClosed:
        {
          this.queueWsConnected = false;
          const payload = this.parseBrowserPayload(e.arguments[1]) as { timedOut?: unknown };
          logTrace(this, 'Queue WebSocket closed', JSON.stringify(payload));
          if (payload.timedOut === true) {
            this.loadLoginUiCharacters();
          }
        }
        break;
      case events.banned:
        this.showBannedAndQuit();
        break;
      case events.clearAuthData:
        // Doesn't seem to be used
        this.writeAuthDataToDisk(null);
        break;
      case events.openGithub:
        this.sp.win32.loadUrl(this.githubUrl);
        break;
      case events.openPatreon:
        this.sp.win32.loadUrl(this.patreonUrl);
        break;
      case events.updateRequired:
        this.sp.win32.loadUrl("https://skymp.net/UpdInstall");
        break;
      case events.backToLogin:
        this.sp.browser.executeJavaScript(new FunctionInfo(this.browsersideWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case events.joinDiscord:
        this.sp.win32.loadUrl("https://discord.gg/9KhSZ6zjGT");
        break;
      default:
        break;
    }
  }

  private applySelectedProfileToPlaySession(callback: (err: string) => void) {
    if (authData === null) {
      callback(strings.loginFirst);
      return;
    }
    if (!Number.isInteger(this.selectedProfileId)) {
      callback('Select a character before joining the realm.');
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);
    const timersService = this.controller.lookupListener(TimersService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());
    const route = `/api/users/me/play/${settingsService.getServerMasterKey()}`;
    let completed = false;

    const finish = (error: string) => {
      if (completed) return;
      completed = true;
      callback(error);
    };

    logTrace(this, 'Applying selected profile to play session:', this.selectedProfileId);
    timersService.setTimeout(() => {
      finish('Timed out while preparing the play session.');
    }, 10000);

    client.post(route, {
      body: JSON.stringify({ profileId: this.selectedProfileId }),
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, (res) => {
      if (completed) return;
      logTrace(this, 'Play session response:', res.status, res.body || res.error || '');

      if (this.handleBannedResponse(res)) {
        finish(strings.banned);
        return;
      }

      if (res.status != 200) {
        const detail = res.body || res.error || '';
        finish(`Play session failed: status ${res.status}${detail ? ` (${detail})` : ''}`);
        return;
      }

      try {
        const response = JSON.parse(res.body);
        const profileId = Number(response.profileId);
        if (!Number.isInteger(profileId) || profileId < 0) {
          finish('Play session response did not include a valid profileId.');
          return;
        }

        authData = {
          ...authData!,
          session: response.session || authData!.session,
          masterApiId: profileId,
        };
        logTrace(this, 'Play session accepted profileId:', profileId);
        finish('');
      } catch (e) {
        finish('failed to parse play session response');
      }
    });
  }

  private checkLoginState() {
    if (!this.isListenBrowserMessage) {
      logTrace(this, `checkLoginState: isListenBrowserMessage was false, aborting check`);
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);
    const timersService = this.controller.lookupListener(TimersService);

    // Social engineering protection, don't show the full state
    const halfDiscordAuthState = this.discordAuthState.slice(0, 16);

    logTrace(this, `Checking login state`, halfDiscordAuthState, '...');

    new this.sp.HttpClient(settingsService.getMasterUrl())
      .get("/api/users/login-discord/status?state=" + this.discordAuthState, undefined,
        // @ts-ignore
        (response) => {
          switch (response.status) {
            case 200:
              const {
                token,
                masterApiId,
                discordUsername,
                discordDiscriminator,
                discordAvatar,
              } = JSON.parse(response.body) as MasterApiAuthStatus;
              browserState.failCount = 0;
              authData = {
                session: token,
                masterApiId,
                discordUsername,
                discordDiscriminator,
                discordAvatar,
                hwidHash: this.getHwidHash(),
              };
              this.writeAuthDataToDisk(authData);
              browserState.comment = strings.linkedSuccessfully;
              this.refreshWidgets();
              this.refreshLoginUi();
              break;
            case 401: // Unauthorized
              browserState.failCount = 0;
              browserState.comment = '';//(`Still waiting...`);
              timersService.setTimeout(() => this.checkLoginState(), Math.floor((1.5 + Math.random() * 2) * 1000));
              break;
            case 403: // Forbidden
            case 404: // Not found
              browserState.failCount = 9000;
              browserState.comment = (`Fail: ${response.body}`);
              break;
            default:
              ++browserState.failCount;
              browserState.comment = `Server returned ${response.status.toString() || "???"} "${response.body || response.error}"`;
              timersService.setTimeout(() => this.checkLoginState(), Math.floor((1.5 + Math.random() * 2) * 1000));
          }
        });
  };

  private refreshWidgets() {
    this.sp.browser.executeJavaScript(new FunctionInfo(this.browsersideWidgetSetter).getText({ events, browserState, authData: authData, strings }));
    this.authDialogOpen = true;
  };

  private parseBrowserPayload(payload: unknown): unknown {
    if (typeof payload !== 'string') {
      return payload || {};
    }

    try {
      return JSON.parse(payload);
    } catch {
      return {};
    }
  }

  private executeLoginUiCall(method: string, payload?: unknown) {
    const serialized = payload === undefined
      ? ''
      : JSON.stringify(payload).replace(/</g, '\\u003c');
    this.executeBrowserScript(
      `window.VGRLoginUI&&window.VGRLoginUI.${method}&&window.VGRLoginUI.${method}(${serialized});`
    );
  }

  private executeBrowserScript(script: string) {
    try {
      this.sp.browser.executeJavaScript(script);
    } catch (e) {
      logError(this, 'Failed to execute browser script:', e);
    }
  }

  private setLoginUiError(message: string) {
    this.executeLoginUiCall('setError', message);
  }

  private restoreLoginUiForAuth() {
    this.executeLoginUiCall('restoreForAuth');
  }

  private hideLoginUiAfterSuccessfulAuth() {
    logTrace(this, 'Successful auth reached client actor creation, entering gameplay UI');
    this.executeLoginUiCall('hideAfterSuccessfulAuth');
    this.enterGameplayFrontend('actor created');
    this.authDialogOpen = false;
  }

  private enterGameplayFrontend(reason: string) {
    this.pendingGameplayFrontendReason = reason;

    if (!this.trigger.browserWindowLoadedFired) {
      logTrace(this, `Gameplay frontend entry deferred until browser load:`, reason);
      return;
    }

    this.pendingGameplayFrontendReason = null;
    const serializedReason = JSON.stringify(reason).replace(/</g, '\\u003c');

    this.executeBrowserScript(`
(function(reason){
  if (window.VGRFrontend && typeof window.VGRFrontend.enterGameplay === 'function') {
    window.VGRFrontend.enterGameplay(reason);
    return;
  }

  if (window.VGRLoginUI && typeof window.VGRLoginUI.hideAfterSuccessfulAuth === 'function') {
    window.VGRLoginUI.hideAfterSuccessfulAuth();
    return;
  }

  if (window.VGRUI && typeof window.VGRUI.completeLogin === 'function') {
    window.VGRUI.completeLogin();
    return;
  }

  if (window.VGRUI && typeof window.VGRUI.showGameplay === 'function') {
    window.VGRUI.showGameplay();
    if (typeof window.vgrInitRegistryUI === 'function') {
      window.vgrInitRegistryUI();
    }
  }
})(${serializedReason});`);
  }

  private showLoginUiAuthorizing() {
    this.executeLoginUiCall('showAuthStatus', {
      eyebrow: 'ENTERING REALM',
      title: 'Authorizing session',
      message: 'The game server is validating your selected profile.',
      footer: 'Authorization started. Waiting for the game server.'
    });
  }

  private showLoginUiLoading() {
    this.executeLoginUiCall('showLoading', {
      eyebrow: 'ENTERING REALM',
      title: 'Loading realm',
      message: 'Authorization accepted. Waiting for Skyrim to load your character.',
      footer: 'Session accepted. Loading into the realm.'
    });
  }

  private refreshLoginUi() {
    if (authData) {
      this.executeLoginUiCall('setUser', {
        username: authData.discordUsername,
        avatar: authData.discordAvatar,
      });
      this.loadLoginUiCharacters();
    } else {
      this.executeLoginUiCall('setCharacters', { characters: [], maxCharacterSlots: 0 });
      this.setLoginUiError(strings.loginFirst);
    }
  }

  private authHeaders(): HttpHeaders {
    const headers: HttpHeaders = {};
    if (authData) {
      headers.authorization = authData.session;
    }

    const hwidHash = authData?.hwidHash || this.getHwidHash();
    if (hwidHash) {
      headers['x-hwid-hash'] = hwidHash;
    }

    return headers;
  }

  private loadLoginUiCharacters() {
    if (!authData) {
      this.setLoginUiError(strings.loginFirst);
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.get('/api/users/me/characters', { headers: this.authHeaders() },
      // @ts-ignore
      (res) => {
        if (this.handleBannedResponse(res)) return;

        if (res.status !== 200) {
          this.setLoginUiError(`Failed to load characters: status ${res.status}`);
          return;
        }

        try {
          this.executeLoginUiCall('setCharacters', JSON.parse(res.body));
        } catch {
          this.setLoginUiError('Failed to parse character list.');
        }
      });
  }

  private createLoginUiCharacter() {
    if (!authData) {
      this.setLoginUiError(strings.loginFirst);
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.post('/api/users/me/characters', {
      body: '{}',
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, (res) => {
      if (this.handleBannedResponse(res)) return;

      if (res.status !== 201) {
        const detail = res.error || res.body || '';
        logTrace(this, `Failed to create character: status ${res.status}`, detail);
        this.setLoginUiError(`Failed to create character: status ${res.status}${detail ? ` (${detail})` : ''}`);
        return;
      }

      try {
        const data = JSON.parse(res.body);
        this.executeLoginUiCall('confirmCharacter', data.character);
      } catch {
        this.setLoginUiError('Failed to parse created character.');
      }
    });
  }

  private deleteLoginUiCharacter(profileId: number) {
    if (!authData) {
      this.setLoginUiError(strings.loginFirst);
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.post(`/api/users/me/characters/${profileId}/delete`, {
      body: '{}',
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, (res) => {
      if (this.handleBannedResponse(res)) return;

      if (res.status !== 200) {
        this.setLoginUiError(`Failed to delete character: status ${res.status}`);
        return;
      }

      this.loadLoginUiCharacters();
    });
  }

  private cancelLoginUiCharacterDeletion(profileId: number) {
    if (!authData) {
      this.setLoginUiError(strings.loginFirst);
      return;
    }

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.post(`/api/users/me/characters/${profileId}/cancel-delete`, {
      body: '{}',
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, (res) => {
      if (this.handleBannedResponse(res)) return;

      if (res.status !== 200) {
        this.setLoginUiError(`Failed to cancel character deletion: status ${res.status}`);
        this.loadLoginUiCharacters();
        return;
      }

      this.loadLoginUiCharacters();
    });
  }

  private joinLoginQueue(profileId: number) {
    if (!authData) {
      this.setLoginUiError(strings.loginFirst);
      return;
    }

    this.selectedProfileId = profileId;
    this.queuePollId++;
    this.queueWsConnected = false;

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.post('/api/users/me/queue', {
      body: JSON.stringify({ profileId }),
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, (res) => {
      if (this.handleBannedResponse(res)) return;

      if (res.status !== 200) {
        this.setLoginUiError(`Failed to join queue: status ${res.status}`);
        return;
      }

      try {
        const data = JSON.parse(res.body);
        const pollId = this.queuePollId;
        this.handleQueueResponse(data.queue, pollId, false);
        this.openLoginQueueSocket(pollId);
        this.controller.lookupListener(TimersService).setTimeout(() => {
          if (!this.queueWsConnected && pollId === this.queuePollId) {
            this.pollLoginQueue(pollId);
          }
        }, 4000);
      } catch {
        this.setLoginUiError('Failed to parse queue status.');
      }
    });
  }

  private openLoginQueueSocket(pollId: number) {
    if (!authData || pollId !== this.queuePollId) return;

    const settingsService = this.controller.lookupListener(SettingsService);
    const wsUrl = settingsService.getMasterUrl().replace(/^http/i, 'ws') + '/api/users/me/queue/ws';
    const token = authData.session;
    const hwidHash = authData.hwidHash || this.getHwidHash();
    const openEvent = events.queueWsOpen;
    const closeEvent = events.queueWsClosed;
    const bannedEvent = events.banned;

    this.executeBrowserScript(`
(function(){
  try {
    if (window.__vgrQueueSocket) {
      window.__vgrQueueSocket.onclose = null;
      window.__vgrQueueSocket.close(1000, 'replaced');
    }
    var socket = new WebSocket(${JSON.stringify(wsUrl)});
    window.__vgrQueueSocket = socket;
    socket.onopen = function () {
      window.skyrimPlatform.sendMessage(${JSON.stringify(openEvent)});
      socket.send(JSON.stringify({ type: 'auth', token: ${JSON.stringify(token)}, hwidHash: ${JSON.stringify(hwidHash)} }));
    };
    socket.onmessage = function (event) {
      var data = JSON.parse(event.data);
      if (data && data.type === 'queue' && window.VGRLoginUI) {
        window.VGRLoginUI.setQueue(data.queue);
      }
      if (data && data.type === 'banned') {
        socket.__vgrBanned = true;
        window.skyrimPlatform.sendMessage(${JSON.stringify(bannedEvent)});
      }
    };
    socket.onclose = function (event) {
      var state = window.VGRLoginUI && window.VGRLoginUI.getState ? window.VGRLoginUI.getState() : null;
      var timedOut = !socket.__vgrBanned && !!(state && state.view === 'queue');
      window.skyrimPlatform.sendMessage(${JSON.stringify(closeEvent)}, JSON.stringify({
        code: event.code,
        reason: event.reason || '',
        timedOut: timedOut
      }));
      if (timedOut) {
        window.VGRLoginUI.showCharacters();
        window.VGRLoginUI.setError("Authentication timed out. Queue did not succeed. Please try again.");
      }
    };
    socket.onerror = function () {};
  } catch (e) {
    window.skyrimPlatform.sendMessage(${JSON.stringify(closeEvent)}, JSON.stringify({ code: 0, reason: String(e) }));
  }
})();`);
  }

  private pollLoginQueue(pollId: number) {
    if (!authData || pollId !== this.queuePollId) return;

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.get('/api/users/me/queue', { headers: this.authHeaders() },
      // @ts-ignore
      (res) => {
        if (pollId !== this.queuePollId) return;
        if (this.handleBannedResponse(res)) return;

        if (res.status !== 200) {
          if (res.status === 404) {
            this.executeLoginUiCall('showCharacters');
            this.setLoginUiError('Authentication timed out. Queue did not succeed. Please try again.');
            this.loadLoginUiCharacters();
            return;
          }
          this.setLoginUiError(`Failed to poll queue: status ${res.status}`);
          return;
        }

        try {
          const data = JSON.parse(res.body);
          this.handleQueueResponse(data.queue, pollId, true);
        } catch {
          this.setLoginUiError('Failed to parse queue status.');
        }
      });
  }

  private handleQueueResponse(queue: unknown, pollId: number, continuePolling: boolean) {
    this.executeLoginUiCall('setQueue', queue || {});

    const status = String((queue as { status?: unknown } || {}).status || '');
    if (status === 'ready' || status === 'admitting') {
      return;
    }

    if (!continuePolling) return;

    this.controller.lookupListener(TimersService).setTimeout(
      () => this.pollLoginQueue(pollId),
      2000,
    );
  }

  private leaveLoginQueue() {
    this.queuePollId++;
    this.queueWsConnected = false;
    this.executeBrowserScript(`
(function(){
  if (window.__vgrQueueSocket) {
    window.__vgrQueueSocket.onclose = null;
    window.__vgrQueueSocket.close(1000, 'left queue');
    window.__vgrQueueSocket = null;
  }
})();`);
    if (!authData) return;

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.post('/api/users/me/queue/leave', {
      body: '{}',
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, () => {});
  }

  private completeLoginQueue() {
    this.queuePollId++;
    this.queueWsConnected = false;
    this.executeBrowserScript(`
(function(){
  if (window.__vgrQueueSocket) {
    window.__vgrQueueSocket.onclose = null;
    window.__vgrQueueSocket.close(1000, 'queue complete');
    window.__vgrQueueSocket = null;
  }
})();`);
    if (!authData) return;

    const settingsService = this.controller.lookupListener(SettingsService);
    const client = new this.sp.HttpClient(settingsService.getMasterUrl());

    client.post('/api/users/me/queue/complete', {
      body: '{}',
      contentType: 'application/json',
      headers: this.authHeaders(),
      // @ts-ignore
    }, () => {});
  }

  public getAuthData(): RemoteAuthGameData | null {
    if (authData) {
      authData = this.withHwidHash(authData);
      return authData;
    }

    authData = this.readAuthDataFromDisk();
    return authData;
  }

  public readAuthDataFromDisk(): RemoteAuthGameData | null {
    // logTrace(this, `Reading`, this.pluginAuthDataName, `from disk`);

    try {
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(this.pluginAuthDataName, "PluginsNoLoad");

      if (!data) {
        logTrace(this, `Read empty`, this.pluginAuthDataName, `returning null`);
        return null;
      }

      const parsed = JSON.parse(data.slice(2)) || null;
      if (!parsed) return null;
      return this.withHwidHash(parsed);
    } catch (e) {
      logError(this, `Error reading`, this.pluginAuthDataName, `from disk:`, e, `, falling back to null`);
      return null;
    }
  }

  private writeAuthDataToDisk(data: RemoteAuthGameData | null) {
    authData = this.withHwidHash(data);
    const content = "//" + (authData ? JSON.stringify(authData) : "null");

    logTrace(this, `Writing`, this.pluginAuthDataName, `to disk:`, content);

    try {
      this.sp.writePlugin(
        this.pluginAuthDataName,
        content,
        // @ts-expect-error (TODO: Remove in 2.10.0)
        "PluginsNoLoad"
      );
    } catch (e) {
      logError(this, `Error writing`, this.pluginAuthDataName, `to disk:`, e, `, will not remember user`);
    }
  };

  private deniedWidgetSetter = () => {
    const widget = {
      type: "form",
      id: 2,
      caption: strings.updateCaption,
      elements: [
        {
          type: "text",
          text: strings.updateAvailable,
          tags: []
        },
        {
          type: "text",
          text: strings.downloadAt,
          tags: []
        },
        {
          type: "text",
          text: "skymp.net",
          tags: []
        },
        {
          type: "button",
          text: strings.openSkympNet,
          tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.updateRequired),
          hint: strings.updateDownloadHint,
        }
      ]
    }
    window.skyrimPlatform.widgets.set([widget]);

    // Make sure gamemode will not be able to update widgets anymore
    window.skyrimPlatform.widgets = null;
  }

  private loginFailedWidgetSetter = () => {
    const splitParts = browserState.loginFailedReason.split('\n');

    const textElements = splitParts.map((part) => ({
      type: "text",
      text: part,
      tags: [],
    }));

    const widget = {
      type: "form",
      id: 2,
      caption: strings.oops,
      elements: new Array<any>()
    }

    textElements.forEach((element) => widget.elements.push(element));

    if (browserState.loginFailedReason === strings.joinDiscordServer) {
      widget.elements.push({
        type: "button",
        text: strings.join,
        tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
        click: () => window.skyrimPlatform.sendMessage(events.joinDiscord),
        hint: null
      });
    }

    widget.elements.push({
      type: "button",
      text: strings.back,
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.backToLogin),
      hint: undefined
    });

    window.skyrimPlatform.widgets.set([widget]);
  }

  private browsersideWidgetSetter = () => {
    const loginWidget = {
      type: "form",
      id: 1,
      caption: strings.authorization,
      elements: [
        // {
        //   type: "button",
        //   tags: ["BUTTON_STYLE_GITHUB"],
        //   hint: "get a colored nickname and mention in news",
        //   click: () => window.skyrimPlatform.sendMessage(events.openGithub),
        // },
        // {
        //   type: "button",
        //   tags: ["BUTTON_STYLE_PATREON", "ELEMENT_SAME_LINE", "HINT_STYLE_RIGHT"],
        //   hint: "get a colored nickname and other bonuses for patrons",
        //   click: () => window.skyrimPlatform.sendMessage(events.openPatreon),
        // },
        // {
        //   type: "icon",
        //   text: "username",
        //   tags: ["ICON_STYLE_SKYMP"],
        // },
        // {
        //   type: "icon",
        //   text: "",
        //   tags: ["ICON_STYLE_DISCORD"],
        // },
        {
          type: "text",
          text: (
            authData ? (
              authData.discordUsername
                ? `${authData.discordUsername}`
                : `id: ${authData.masterApiId}`
            ) : strings.notAuthorized
          ),
          tags: [/*"ELEMENT_SAME_LINE", "ELEMENT_STYLE_MARGIN_EXTENDED"*/],
        },
        // {
        //   type: "icon",
        //   text: "discord",
        //   tags: ["ICON_STYLE_DISCORD"],
        // },
        {
          type: "button",
          text: authData ? strings.changeAccount : strings.loginViaSkymp,
          tags: [/*"ELEMENT_SAME_LINE"*/],
          click: () => window.skyrimPlatform.sendMessage(events.openDiscordOauth),
          hint: strings.loginOrChangeHint,
        },
        {
          type: "button",
          text: strings.play,
          tags: ["BUTTON_STYLE_FRAME", "ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.authAttempt),
          hint: strings.connectToServer,
        },
        {
          type: "text",
          text: browserState.comment,
          tags: [],
        },
      ]
    };
    window.skyrimPlatform.widgets.set([loginWidget]);
  };

  private handleConnectionDenied(e: ConnectionDenied) {
    this.authAttemptProgressIndicator = false;
    this.leaveLoginQueue();

    if (e.error.toLowerCase().includes("invalid password")) {
      this.controller.once("tick", () => {
        this.controller.lookupListener(NetworkingService).close();
      });
      this.sp.browser.executeJavaScript(new FunctionInfo(this.deniedWidgetSetter).getText({ events, strings }));
      this.sp.browser.setVisible(true);
      this.sp.browser.setFocused(true);
      this.controller.once("update", () => {
        this.sp.Game.disablePlayerControls(true, true, true, true, true, true, true, true, 0);
      });
      this.setListenBrowserMessage(true, 'connectionDenied event received');
    }
  }

  private handleConnectionAccepted() {
    this.setListenBrowserMessage(false, 'connectionAccepted event received');
    this.loggingStartMoment = Date.now();

    const authData = this.sp.storage[authGameDataStorageKey] as AuthGameData | undefined;
    if (authData?.local) {
      logTrace(this,
        `Logging in offline mode, profileId =`, authData.local.profileId
      );
      const message: CustomPacketMessage = {
        t: MsgType.CustomPacket,
        contentJsonDump: JSON.stringify({
          customPacketType: 'loginWithSkympIo',
          gameData: {
            profileId: authData.local.profileId,
          },
        }),
      };
      this.controller.emitter.emit("sendMessage", {
        message: message,
        reliability: "reliable"
      });
      return;
    }

    if (authData?.remote) {
      logTrace(this, 'Logging in as a master API user');
      this.showLoginUiLoading();
      const hwidHash = authData.remote.hwidHash || this.getHwidHash();
      const clientLoadOrder = getClientLoadOrder(this.sp.Game);
      const message: CustomPacketMessage = {
        t: MsgType.CustomPacket,
        contentJsonDump: JSON.stringify({
          customPacketType: 'loginWithSkympIo',
          gameData: {
            session: authData.remote.session,
            hwidHash,
            clientLoadOrder,
          },
        }),
      };
      this.controller.emitter.emit("sendMessage", {
        message: message,
        reliability: "reliable"
      });
      return;
    }

    logError(this, 'Not found authentication method');
  };

  private onTick() {
    // TODO: Should be no hardcoded/magic-number limit
    // TODO: Busy waiting is bad. Should be replaced with some kind of event
    const maxLoggingDelay = 15000;
    if (this.loggingStartMoment && Date.now() - this.loggingStartMoment > maxLoggingDelay) {
      logTrace(this, 'Max logging delay reached received');

      if (this.playerEverSawActualGameplay) {
        logTrace(this, 'Player saw actual gameplay, reconnecting');
        this.loggingStartMoment = 0;
        this.controller.lookupListener(NetworkingService).reconnect();
        // TODO: should we prompt user to relogin?
      } else {
        logTrace(this, 'Player never saw actual gameplay, showing login dialog');
        this.loggingStartMoment = 0;
        this.authAttemptProgressIndicator = false;
        this.leaveLoginQueue();
        this.controller.lookupListener(NetworkingService).close();
        browserState.comment = "";
        browserState.loginFailedReason = strings.technicalIssues;
        this.executeLoginUiCall('showCharacters');
        this.setLoginUiError('Authentication timed out. Queue did not succeed. Please try again.');
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));

        authData = null;
        this.writeAuthDataToDisk(null);
      }
    }

    if (this.authAttemptProgressIndicator) {
      this.authAttemptProgressIndicatorCounter++;

      if (this.authAttemptProgressIndicatorCounter === 1000000) {
        this.authAttemptProgressIndicatorCounter = 0;
      }

      const slowCounter = Math.floor(this.authAttemptProgressIndicatorCounter / 15);

      const dot = slowCounter % 3 === 0 ? '.' : slowCounter % 3 === 1 ? '..' : '...';

      browserState.comment = strings.connecting + dot;
      this.refreshWidgets();
    }
  }

  private onceUpdate() {
    this.playerEverSawActualGameplay = true;
  }

  private isListenBrowserMessage() {
    return this._isListenBrowserMessage;
  }

  private setListenBrowserMessage(value: boolean, reason: string) {
    logTrace(this, `setListenBrowserMessage:`, value, `reason:`, reason);
    this._isListenBrowserMessage = value;
  }

  private handleBannedResponse(res: { status?: number, body?: string, error?: string }): boolean {
    if (!this.isBannedResponse(res)) return false;
    this.showBannedAndQuit();
    return true;
  }

  private isBannedResponse(res: { status?: number, body?: string, error?: string }): boolean {
    if (res.status !== 403) return false;

    const raw = String(res.body || res.error || '');
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (parsed && parsed.error === 'banned') return true;
    } catch {
      // Fall back to the plain text check below.
    }

    return raw.toLowerCase().includes('banned');
  }

  private showBannedAndQuit() {
    if (this.banShutdownStarted) return;
    this.banShutdownStarted = true;

    this.authAttemptProgressIndicator = false;
    this.leaveLoginQueue();
    this.controller.lookupListener(NetworkingService).close();
    browserState.loginFailedReason = strings.banned;
    browserState.comment = '';
    this.setListenBrowserMessage(true, 'banned player shutdown started');
    this.loggingStartMoment = 0;

    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
    this.executeBrowserScript(`
(function(){
  var id = 'vgr-ban-warning';
  var existing = document.getElementById(id);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  var remaining = 15;
  var overlay = document.createElement('div');
  overlay.id = id;
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:rgba(0,0,0,.62)',
    'color:#f4dfb0',
    'font-family:Georgia,Times New Roman,serif',
    'letter-spacing:.08em',
    'text-align:center',
    'pointer-events:auto'
  ].join(';');
  overlay.innerHTML = '<div style="width:min(520px,80vw);padding:34px 42px;border:1px solid rgba(177,48,39,.85);background:linear-gradient(180deg,rgba(22,6,5,.92),rgba(6,4,3,.96));box-shadow:0 0 70px rgba(0,0,0,.85),0 0 34px rgba(113,10,7,.35)">' +
    '<div style="width:64px;height:64px;border-radius:50%;border:1px solid rgba(244,223,176,.58);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;color:#d45c4e;font-size:34px">X</div>' +
    '<div style="font-size:13px;color:#b28a4f;text-transform:uppercase;margin-bottom:10px">Access denied</div>' +
    '<div style="font-size:32px;font-weight:bold;text-transform:uppercase;margin-bottom:12px">You have been banned</div>' +
    '<div style="font-size:15px;line-height:1.55;letter-spacing:0;color:#d8c8aa">This account or device is not allowed to enter Vengeful Realms.</div>' +
    '<div style="margin-top:18px;font-size:14px;letter-spacing:0;color:#b9aa8c">The game will close in <span id="vgr-ban-countdown">15</span> seconds.</div>' +
  '</div>';
  document.body.appendChild(overlay);

  if (window.__vgrBanCountdownTimer) clearInterval(window.__vgrBanCountdownTimer);
  window.__vgrBanCountdownTimer = setInterval(function(){
    remaining -= 1;
    var el = document.getElementById('vgr-ban-countdown');
    if (el) el.textContent = String(Math.max(remaining, 0));
    if (remaining <= 0) clearInterval(window.__vgrBanCountdownTimer);
  }, 1000);
})();`);

    this.controller.lookupListener(TimersService).setTimeout(() => {
      try {
        this.sp.win32.exitProcess();
      } catch (e) {
        logError(this, 'Failed to close process after ban warning:', e);
      }
    }, 15000);
  }

  private getHwidHash(): string {
    if (this.hwidHashCache) return this.hwidHashCache;

    const seed = this.getOrCreateDeviceSeed();
    const env = this.getMachineHint();
    this.hwidHashCache = crypto
      .createHash('sha256')
      .update(`vgr-client-hwid-v1:${seed}:${env}`)
      .digest('hex');

    return this.hwidHashCache;
  }

  private getOrCreateDeviceSeed(): string {
    try {
      const existing = fs.readFileSync(this.deviceSeedPath, 'utf8').trim();
      if (existing) return existing;
    } catch {
      // First run, unreadable file, or old install without a seed.
    }

    const seed = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync('./Data/Platform/PluginsNoLoad', { recursive: true });
      fs.writeFileSync(this.deviceSeedPath, `${seed}\n`);
    } catch (e) {
      logError(this, 'Failed to persist HWID seed, using session-only seed:', e);
    }

    return seed;
  }

  private getMachineHint(): string {
    try {
      const env = typeof process !== 'undefined' ? process.env : {};
      return [
        env.COMPUTERNAME,
        env.USERDOMAIN,
        env.PROCESSOR_IDENTIFIER,
      ].filter(Boolean).join('|');
    } catch {
      return '';
    }
  }

  private withHwidHash(data: RemoteAuthGameData | null): RemoteAuthGameData | null {
    if (!data) return null;
    return {
      ...data,
      hwidHash: data.hwidHash || this.getHwidHash(),
    };
  }

  private _isListenBrowserMessage = false;

  private trigger = {
    authNeededFired: false,
    browserWindowLoadedFired: false,

    get conditionMet() {
      return this.authNeededFired && this.browserWindowLoadedFired
    }
  };
  private discordAuthState = crypto.randomBytes(32).toString('hex');
  private selectedProfileId: number | null = null;
  private queuePollId = 0;
  private queueWsConnected = false;
  private authDialogOpen = false;
  private pendingGameplayFrontendReason: string | null = null;
  private banShutdownStarted = false;
  private hwidHashCache: string | null = null;

  private loggingStartMoment = 0;

  private authAttemptProgressIndicator = false;
  private authAttemptProgressIndicatorCounter = 0;

  private playerEverSawActualGameplay = false;

  private readonly githubUrl = "https://github.com/skyrim-multiplayer/skymp";
  private readonly patreonUrl = "https://www.patreon.com/skymp";
  private readonly pluginAuthDataName = `auth-data-no-load`;
  private readonly deviceSeedPath = './Data/Platform/PluginsNoLoad/vgr-device-id.txt';
}
