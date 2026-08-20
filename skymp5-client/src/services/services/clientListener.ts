import * as sp from "skyrimPlatform";
import { EventEmitterType } from "../events/events";

export interface ClientListenerEvents {
    on: typeof sp.on,
    once: typeof sp.once
};

// these are only available in the git version, so we augment the module
// TODO: use typings from the current codebase, not npm module
declare module "skyrimPlatform" {
    function setTextsVisibility(visibility: 'inheritBrowser' | 'off' | 'on'): void;
    function getTextsVisibility(): 'inheritBrowser' | 'off' | 'on';
    function setTextRefr(textId: number, refrFormId: number): void; // pass 0 to detach
    function setTextRefrNode(textId: number, nodeName: string): void;
    function setTextRefrOffset(textId: number, offset: number[]): void;
    function setTextRefrScreenOffset(textId: number, offset: number[]): void;
    function getTextRefr(textId: number): number;
    function getTextRefrNode(textId: number): string;
    function getTextRefrOffset(textId: number): number[];
    function getTextRefrScreenOffset(textId: number): number[];

    interface TESModPlatform {
        setNpcBlockedFileIndices(blockedIndices: number[]): void;
    }
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace TESModPlatform {
        function setNpcBlockedFileIndices(blockedIndices: number[]): void;
    }

    interface MpClientPlugin {
        initVoiceChat?(livekitUrl: string, token: string, sampleRate: number, numChannels: number): boolean;
        shutdownVoiceChat?(): void;
        isVoiceChatInitialized?(): boolean;
        startTalking?(): void;
        stopTalking?(): void;
        isTalking?(): boolean;
        setVoiceMode?(mode: number): void;
        setVoiceInputGain?(gain: number): void;
        setVoiceOutputVolume?(volume: number): void;
        tickVoiceChat?(): void;
        needsVoiceReconnect?(): boolean;
        setVoiceParticipantPosition?(identity: string, x: number, y: number, z: number): void;
        setVoiceListenerPosition?(x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number): void;
        setVoiceRange?(range: number): void;
        setVoiceNoiseGateEnabled?(enabled: boolean): void;
        setVoiceNoiseGateThreshold?(threshold: number): void;
        setVoiceNormalizationEnabled?(enabled: boolean): void;
        setVoiceNormalizationTarget?(target: number): void;
        getVoiceRemoteParticipants?(): string;
        getVoiceParticipantActivity?(): string;
    }
}

export type Sp = Omit<typeof sp, "on" | "once">;

export abstract class ClientListener {
    // Don't let TypeScript treat this class as empty
    private _nonEmptyClassMark = '';
}

export type ClientListenerConstructor<T> = {
    new(...args: any[]): T;
    readonly name: string;
}

export type ListenerLookupController = {
    lookupListener<T extends ClientListener>(constructor: ClientListenerConstructor<T>): T;
};

export type EventsController = {
    readonly on: typeof sp.on,
    readonly once: typeof sp.once,
    readonly emitter: EventEmitterType
};

export type CombinedController = EventsController & ListenerLookupController;
