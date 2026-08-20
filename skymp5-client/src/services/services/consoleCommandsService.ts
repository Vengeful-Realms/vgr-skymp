import { logError, logTrace } from "../../logging";
import { MsgType } from "../../messages";

// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { ClientListener, Sp, CombinedController } from "./clientListener";
import { AuthService } from "./authService";
import { SettingsService } from "./settingsService";

enum CmdArgument {
    ObjectReference,
    BaseForm,
    Int,
    String,
}

type CmdName = "additem" | "equipitem" | "placeatme" | "mp";
type ConsoleCommandExecutor = (...args: unknown[]) => boolean;

export class ConsoleCommandsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.schemas = ConsoleCommandsService.createSchemas();
        this.setupMpCommand();
        this.setupVanilaCommands();
        this.setupBlockedCheatCommands();
        this.controller.emitter.on("authAttempt", () => this.forceAdminPermissionRefresh());
        this.controller.on("tick", () => this.refreshAdminPermissionIfNeeded());
    }

    private static createSchemas() {
        const schemas = new Map<CmdName, CmdArgument[]>();
        schemas.set("additem", [CmdArgument.ObjectReference, CmdArgument.BaseForm, CmdArgument.Int]);
        schemas.set("equipitem", [CmdArgument.ObjectReference, CmdArgument.BaseForm]);
        schemas.set("placeatme", [CmdArgument.ObjectReference, CmdArgument.BaseForm]);
        schemas.set("mp", [CmdArgument.ObjectReference, CmdArgument.String]);
        return schemas;
    }

    private setupMpCommand() {
        const command = this.sp.findConsoleCommand(" ConfigureUM") || this.sp.findConsoleCommand("test");
        if (command === null) {
            logError(this, "command was null in setupMpCommand");
            return;
        }

        command.shortName = "mp";
        command.execute = this.getCommandExecutor("mp");
    }

    private setupVanilaCommands() {
        logTrace(this, `Setting up vanila commands`);
        this.schemas.forEach((_, commandName) => {
            logTrace(this, `Setting up command`, commandName);
            const command = this.sp.findConsoleCommand(commandName);
            if (command === null) {
                logError(this, `command`, commandName, `was null in setupVanilaCommands`);
                return;
            }
            if (this.nonVanilaCommands.includes(commandName)) {
                logTrace(this, `command`, commandName, ` is non-vanila command`);
                return;
            }
            const originalExecute = command.execute?.bind(command) as ConsoleCommandExecutor | undefined;
            command.execute = this.getCommandExecutor(commandName, originalExecute);
        });
        logTrace(this, `Vanila commands set up`);
    }

    private setupBlockedCheatCommands() {
        this.blockedCheatCommands.forEach((commandName) => {
            const command = this.sp.findConsoleCommand(commandName);
            if (command === null) {
                logTrace(this, `Cheat command`, commandName, `was null in setupBlockedCheatCommands`);
                return;
            }

            const originalExecute = command.execute?.bind(command) as ConsoleCommandExecutor | undefined;
            command.execute = (...args: unknown[]) => {
                if (this.allowConsoleCheats) {
                    this.logAllowedConsoleCommand(commandName, args);
                    return originalExecute ? originalExecute(...args) : true;
                }

                this.sp.printConsole("Console cheats are disabled on this server.");
                return false;
            };
        });
    }

    private getCommandExecutor(commandName: CmdName, originalExecute?: ConsoleCommandExecutor): (...args: unknown[]) => boolean {
        return (...args: unknown[]) => {
            const rawArgs = [...args];
            if (this.allowConsoleCheats && originalExecute && !this.nonVanilaCommands.includes(commandName)) {
                this.logAllowedConsoleCommand(commandName, args);
                return originalExecute(...args);
            }

            // TODO: handle possible exceptions in this function
            const schema = this.schemas.get(commandName);
            if (schema === undefined) {
                logError(this, `Schema not found for command`, commandName);
                return false;
            }

            logTrace(
                this,
                `Console command intercepted`,
                commandName,
                `rawArgs:`,
                this.safeStringify(rawArgs),
                `schema:`,
                this.safeStringify(schema.map((arg) => CmdArgument[arg])),
            );

            if (args.length !== schema.length && !this.immuneSchema.includes(commandName)) {
                logError(this, `Mismatch found in the schema of`, commandName, `command`);
                return false;
            }
            for (let i = 0; i < args.length; ++i) {
                switch (schema[i]) {
                    case CmdArgument.ObjectReference:
                        args[i] = localIdToRemoteId(parseInt(`${args[i]}`));
                        break;
                }
            }

            for (let i = 0; i < args.length; ++i) {
                if (typeof args[i] !== "string" && typeof args[i] !== "number") {
                    logError(this, `Bad argument type in command`, commandName, `argument index`, i);
                    return false;
                }
            }

            logTrace(this, `Console command forwarded`, commandName, `args:`, this.safeStringify(args));

            this.controller.emitter.emit("sendMessage", {
                message: {
                    t: MsgType.ConsoleCommand,
                    data: {
                        commandName,
                        args: args as (string | number)[]
                    }
                },
                reliability: "reliable"
            });

            return false;
        };
    }

    private logAllowedConsoleCommand(commandName: string, args: unknown[]) {
        const now = Date.now();
        const lastLogAt = this.lastAllowedConsoleCommandLogAt.get(commandName) || 0;
        if (now - lastLogAt < 1000) {
            return;
        }

        this.lastAllowedConsoleCommandLogAt.set(commandName, now);
        // logTrace(this, `Admin console passthrough command`, commandName, `args`, this.safeStringify(args));
    }

    private safeStringify(value: unknown) {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return `[unserializable: ${e}]`;
        }
    }

    private refreshAdminPermission() {
        try {
            const authService = this.controller.lookupListener(AuthService);
            const session = authService.getAuthData()?.session || "";
            if (!session) {
                this.lastAdminSession = null;
                this.adminPermissionKnown = false;
                this.setAdminPermission(false);
                return;
            }

            this.adminPermissionRequestInFlight = true;
            const settingsService = this.controller.lookupListener(SettingsService);
            const client = settingsService.makeMasterApiClient();
            client.get('/api/users/me/characters', { headers: { authorization: session } }, (res) => {
                try {
                    this.adminPermissionRequestInFlight = false;
                    if (res.status !== 200) {
                        logTrace(this, `Admin permission lookup failed with status`, res.status);
                        this.adminPermissionKnown = false;
                        this.setAdminPermission(false);
                        return;
                    }

                    const body = JSON.parse(res.body || '{}');
                    this.lastAdminSession = session;
                    this.adminPermissionKnown = true;
                    // logTrace(this, `Admin permission response`, `admin:`, body?.admin);
                    this.setAdminPermission(body?.admin === true);
                } catch (e) {
                    this.adminPermissionRequestInFlight = false;
                    this.adminPermissionKnown = false;
                    logError(this, `Admin permission response parse failed`, e);
                    this.setAdminPermission(false);
                }
            });
        } catch (e) {
            this.adminPermissionRequestInFlight = false;
            this.adminPermissionKnown = false;
            logError(this, `Admin permission lookup failed`, e);
            this.setAdminPermission(false);
        }
    }

    private refreshAdminPermissionIfNeeded() {
        if (this.adminPermissionRequestInFlight) return;

        const now = Date.now();
        const retryDelayMs = this.adminPermissionKnown ? 60000 : 5000;

        if (now - this.lastAdminPermissionRefreshAt < retryDelayMs) return;

        this.lastAdminPermissionRefreshAt = now;
        this.refreshAdminPermission();
    }

    private forceAdminPermissionRefresh() {
        this.adminPermissionKnown = false;
        this.lastAdminPermissionRefreshAt = 0;
        this.refreshAdminPermissionIfNeeded();
    }

    private setAdminPermission(isAdmin: boolean) {
        this.allowConsoleCheats = isAdmin === true;
        logTrace(this, `Console cheat permission`, this.allowConsoleCheats ? `enabled` : `disabled`);
    }

    private readonly schemas: Map<CmdName, CmdArgument[]>;
    private readonly immuneSchema = ["mp"];
    private readonly nonVanilaCommands = ["mp"];
    // Keep this list restricted to commands that are not already owned by
    // normal SkyMP/Papyrus worldstate flows. "setav" is a deliberate test
    // exception and should move to the schema/server route if it destabilizes.
    private readonly blockedCheatCommands = [
        "bat",
        "coc",
        "cow",
        "disable",
        "fov",
        // These commands mutate vanilla reference state locally. Keep them
        // behind the same console-cheat gate as the other cheats.
        "lock",
        "fw",
        "save",
        "saveini",
        "setav",
        "setlocklevel",
        "setopenstate",
        "sgtm",
        "sw",
        "tai",
        "tcai",
        "tdetect",
        "tfc",
        "tfow",
        "tg",
        "tgm",
        "tim",
        "tcl",
        "tm",
        "tmm",
        "twf",
        "unlock",
    ];
    private allowConsoleCheats = false;
    private adminPermissionKnown = false;
    private adminPermissionRequestInFlight = false;
    private lastAdminPermissionRefreshAt = 0;
    private lastAdminSession: string | null = null;
    private readonly lastAllowedConsoleCommandLogAt = new Map<string, number>();
}
