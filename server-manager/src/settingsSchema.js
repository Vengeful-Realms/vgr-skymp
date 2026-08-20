'use strict'

const serverSettings = [
  // Identity
  { key: 'name',        label: 'Server name',  type: 'text',   group: 'Identity', help: 'Public name shown in the launcher / master list.' },
  { key: 'port',        label: 'Game port (UDP)', type: 'number', group: 'Identity', help: 'RakNet game port.' },
  { key: 'maxPlayers',  label: 'Max players',  type: 'number', group: 'Identity' },
  { key: 'lang',        label: 'Language',     type: 'select', group: 'Identity',
    options: ['english', 'russian', 'german', 'french', 'spanish', 'italian', 'polish', 'chinese', 'japanese'] },

  // Networking
  { key: 'listenHost',   label: 'Listen host',    type: 'text', group: 'Networking', placeholder: '0.0.0.0', help: 'Bind address for game (RakNet) traffic.' },
  { key: 'uiListenHost', label: 'UI listen host', type: 'text', group: 'Networking', placeholder: '0.0.0.0', help: 'Bind address for the HTTP/UI port.' },
  { key: 'ip',           label: 'Advertised IP',  type: 'text', group: 'Networking', help: 'Public IP advertised to clients (NAT).' },

  // Mode & auth
  { key: 'offlineMode', label: 'Offline mode',  type: 'bool', group: 'Mode & auth', help: 'When on, any profile id may connect; master/masterKey are ignored.' },
  { key: 'master',      label: 'Master URL',    type: 'text', group: 'Mode & auth', help: 'Master API URL for online-mode session validation. Empty = offline.' },
  { key: 'masterKey',   label: 'Master key',    type: 'secret', group: 'Mode & auth', help: 'Shared secret; must match the backend SERVER_MASTER_KEY.' },
  { key: 'masterApiAuthToken', label: 'Master API auth token', type: 'secret', group: 'Mode & auth', help: 'Must match the backend MASTER_API_AUTH_TOKEN.' },
  { key: 'enableConsoleCommandsForAll', label: 'Console commands for all', type: 'bool', group: 'Mode & auth', help: 'Allow every player to run console commands (testing only - dangerous).' },

  // Gameplay
  { key: 'characterSelect',         label: 'Character select',      type: 'bool',   group: 'Gameplay', help: 'Show the character-select screen on join.' },
  { key: 'characterSelectMaxCharacters', label: 'Max characters',   type: 'number', group: 'Gameplay', help: 'Character slots per player when character select is on (1-10, default 3).' },
  { key: 'npcEnabled',              label: 'NPCs enabled',          type: 'bool',   group: 'Gameplay' },
  { key: 'isPapyrusHotReloadEnabled', label: 'Papyrus hot reload',  type: 'bool',   group: 'Gameplay', help: 'Reload compiled .pex scripts on change.' },
  { key: 'enableGamemodeDataUpdatesBroadcast', label: 'Broadcast gamemode updates', type: 'bool', group: 'Gameplay', help: 'Push gamemode script updates to connected clients.' },
  { key: 'locale',                  label: 'Locale file',           type: 'text',   group: 'Gameplay', help: 'File in data/localization (no .json) for M.GetText().' },
  { key: 'startingItems',           label: 'Starting items',        type: 'json',   group: 'Gameplay', help: 'Kit granted to fresh characters: [{ baseId, count }]. baseId as a number or "0x..." string.' },
  { key: 'logoutGraceMs',           label: 'Logout grace (ms)',     type: 'number', group: 'Gameplay', help: 'How long a disconnected body stays killable in the world before despawning. Default 300000.' },
  { key: 'respawnSeconds',          label: 'Respawn seconds',       type: 'number', group: 'Gameplay', help: 'Bleedout/respawn timer applied to players (gamemode). Default 15.' },
  { key: 'afkKickMinutes',          label: 'AFK kick (minutes)',    type: 'number', group: 'Gameplay', help: 'Minutes without movement, chat, or voice before an idle player is kicked. 0 disables. Default 20.' },
  { key: 'afkWarnMinutes',          label: 'AFK warning (minutes)', type: 'number', group: 'Gameplay', help: 'Minutes before the AFK kick to warn the player in chat. Default 2.' },
  { key: 'npcSpawnZones',           label: 'NPC spawn zones',       type: 'json',   group: 'Gameplay', help: 'Zones that spawn NPCs when a player enters.' },
  { key: 'regenerationMultiplier',  label: 'Regen multiplier',      type: 'number', group: 'Gameplay', help: 'Scales the health/magicka/stamina regen the server accepts from clients. 1 = race-record rates, 0 = no natural regen.' },
  { key: 'chatRanges',              label: 'Chat ranges',           type: 'json',   group: 'Gameplay', help: 'Audible ranges in game units: { whisper, low, say, wide, shout }. Provided keys override the defaults.' },
  { key: 'voiceChat',               label: 'Voice chat',            type: 'json',   group: 'Gameplay', help: 'LiveKit proximity voice: { enabled, url, apiKey, apiSecret, room, rangeUnits }.' },
  { key: 'vgrSocial',               label: 'Social Chamber',        type: 'json',   group: 'Gameplay', help: 'Friends + pigeon messaging: { enabled, maxFriends, maxPendingRequests, maxMessageLength, actionCooldownMs, pigeonRoutes: [{ maxDistance, cost, delaySeconds }] }. Null maxDistance = unbounded band. Restart the Game service to apply.' },
  { key: 'vgrStaticWorldItems',     label: 'Static world items',    type: 'json',   group: 'Gameplay', help: 'World-placed item refs are static (no pickup/interaction); player drops stay lootable: { enabled, blockedTypes: ["WEAP", ...] }. Restart the Game service to apply.' },

  // Data & storage
  { key: 'dataDir',        label: 'Data directory', type: 'text',   group: 'Data & storage', placeholder: 'data', help: 'ESMs / ESPs / UI / scripts.' },
  { key: 'gamemodePath',   label: 'Gamemode path',  type: 'text',   group: 'Data & storage', placeholder: './gamemode.js' },
  { key: 'databaseDriver', label: 'Database driver', type: 'select', group: 'Data & storage', options: ['file', 'mongodb', 'zip', 'migration'] },
  { key: 'databaseName',   label: 'Database name',   type: 'text',   group: 'Data & storage', placeholder: 'world', help: 'File DB folder / Mongo db name. Characters live in <name>/changeForms.' },
  { key: 'databaseUri',    label: 'Database URI',    type: 'secret', group: 'Data & storage', placeholder: 'mongodb://user:pass@127.0.0.1:27017', help: 'Mongo connection string (mongodb driver only). Embeds credentials - keep it secret.' },
  { key: 'logDir',         label: 'Log directory',   type: 'text',   group: 'Data & storage', placeholder: 'C:\\logs', help: 'Where chat.log and service logs are written. Overridden by the VGR_LOG_DIR env var.' },

  // Complex / nested (rendered as JSON sub-editors)
  { key: 'loadOrder',     label: 'Load order',     type: 'json', group: 'Advanced', help: 'Array of ESM/ESP filenames in order.' },
  { key: 'archives',      label: 'BSA archives',   type: 'json', group: 'Advanced', help: 'Array of BSA filenames to load.' },
  { key: 'startPoints',   label: 'Start points',   type: 'json', group: 'Advanced', help: 'Spawn points: [{ pos:[x,y,z], worldOrCell, angleZ }].' },
  { key: 'reloot',        label: 'Reloot timers',  type: 'json', group: 'Advanced', help: 'Record type → ms before respawn.' },
  { key: 'forbiddenReloot', label: 'Forbidden reloot', type: 'json', group: 'Advanced', help: 'Record types that never respawn.' },
  { key: 'blockedSpells',  label: 'Blocked spells',  type: 'json', group: 'Advanced', help: 'Spell form ids players may not cast (numbers or "0x..." strings).' },
  { key: 'vgrAccessControl', label: 'VGR access control', type: 'json', group: 'Advanced', help: 'Gamemode permission config. Admin menu / access management: { "permissions": { "vgr.access.manage": { "discordRoleIds": ["..."], "discordIds": [], "profileIds": [] } } }.' },
  { key: 'npcSettings',   label: 'NPC settings',   type: 'json', group: 'Advanced' },
  { key: 'metricsAuth',   label: 'Metrics auth',   type: 'json', group: 'Advanced', help: '{ user, password } for /metrics basic auth.' },
  { key: 'damageMultFormulaSettings', label: 'Damage formula', type: 'json', group: 'Advanced' },
  { key: 'discordAuth',   label: 'Discord auth',   type: 'json', group: 'Advanced', help: 'Discord bot integration: { botToken, guilds:[...] }. Holds a bot token - keep it secret.' },
]

// backend .env - the Express backend configuration. `secret: true` masks the value.
const backendEnv = [
  // HTTP / relay
  { key: 'PORT',         label: 'HTTP port',       type: 'number', group: 'HTTP & relay', help: 'Express backend listen port.' },
  { key: 'WS_PORT',      label: 'WS relay port',   type: 'number', group: 'HTTP & relay', help: 'In-game chat + admin console relay.' },
  { key: 'RELAY_SECRET', label: 'Relay secret',    type: 'secret', group: 'HTTP & relay', help: 'Shared between the relay, the gamemode, and this manager.' },

  // Game server connection
  { key: 'SKYMP_HOST',     label: 'Game server host', type: 'text',   group: 'Game server', placeholder: '127.0.0.1' },
  { key: 'SKYMP_PORT',     label: 'Game server port (UDP)', type: 'number', group: 'Game server' },
  { key: 'SKYMP_UI_PORT',  label: 'Game UI/metrics port', type: 'number', group: 'Game server', help: 'HTTP/metrics port of the game server. Empty = 3000 for game port 7777, else game port + 1.' },
  { key: 'SERVER_ADDRESS', label: 'Public address',   type: 'text',   group: 'Game server', help: 'Public IP advertised to external clients.' },
  { key: 'SERVER_SETTINGS_PATH', label: 'server-settings.json path', type: 'text', group: 'Game server', help: 'Where the deployed game server config lives (also used by this manager).' },

  // Server metadata (reported to the launcher)
  { key: 'SERVER_NAME',        label: 'Server name',      type: 'text',   group: 'Server metadata', help: 'Keep in sync with server-settings.json name.' },
  { key: 'SERVER_MAX_PLAYERS', label: 'Max players',      type: 'number', group: 'Server metadata' },
  { key: 'SERVER_OFFLINE_MODE', label: 'Offline mode',    type: 'bool',   group: 'Server metadata', help: 'Must match server-settings.json offlineMode.' },
  { key: 'SERVER_NPC_ENABLED', label: 'NPCs enabled',     type: 'bool',   group: 'Server metadata' },
  { key: 'SERVER_GAMEMODE',    label: 'Gamemode label',   type: 'text',   group: 'Server metadata', placeholder: 'Roleplay' },

  // Master API
  { key: 'SERVER_MASTER_KEY',      label: 'Master key',         type: 'secret', group: 'Master API', help: 'Must match server-settings.json masterKey.' },
  { key: 'MASTER_URL',             label: 'Master URL',         type: 'text',   group: 'Master API' },
  { key: 'MASTER_API_AUTH_TOKEN',  label: 'Master API auth token', type: 'secret', group: 'Master API' },

  // Launcher & client files
  { key: 'LAUNCHER_LATEST_VERSION', label: 'Launcher version',    type: 'text',   group: 'Launcher & client files', help: 'Version the launcher self-update checks against (also editable on the Build tab).' },
  { key: 'LAUNCHER_DOWNLOAD_URL',   label: 'Launcher download URL', type: 'text', group: 'Launcher & client files', help: 'Installer link served by /api/version.' },
  { key: 'CLIENT_ZIP_URL',          label: 'Client zip URL',      type: 'text',   group: 'Launcher & client files', help: 'Remote skymp-client.zip the backend proxies when no local build exists.' },
  { key: 'CLIENT_FILES_DIR',        label: 'Client files directory', type: 'text', group: 'Launcher & client files', help: 'Local bucket holding skymp-client.zip. Empty = build/client-files (absent on this box - the zip is proxied from CLIENT_ZIP_URL).' },
  { key: 'GITHUB_WEBHOOK_SECRET',   label: 'GitHub webhook secret', type: 'secret', group: 'Launcher & client files' },

  // Discord OAuth & bot
  { key: 'DISCORD_CLIENT_ID',     label: 'Discord client ID',     type: 'text',   group: 'Discord' },
  { key: 'DISCORD_CLIENT_SECRET', label: 'Discord client secret', type: 'secret', group: 'Discord' },
  { key: 'DISCORD_REDIRECT_URI',  label: 'Discord redirect URI',  type: 'text',   group: 'Discord' },
  { key: 'DISCORD_BOT_TOKEN',     label: 'Discord bot token',     type: 'secret', group: 'Discord', help: 'Needed for role-based access checks; the backend logs an error on every start while unset.' },
  { key: 'DISCORD_GUILD_ID',      label: 'Discord guild ID',      type: 'text',   group: 'Discord' },

  // Admin dashboard
  { key: 'DASHBOARD_PORT',        label: 'Dashboard port',        type: 'number', group: 'Admin dashboard' },
  { key: 'DASHBOARD_PUBLIC_URL',  label: 'Dashboard public URL',  type: 'text',   group: 'Admin dashboard' },
  { key: 'DASHBOARD_API_BASE_URL', label: 'Dashboard API base URL', type: 'text', group: 'Admin dashboard' },
  { key: 'DISCORD_DASHBOARD_REDIRECT_URI', label: 'Dashboard redirect URI', type: 'text', group: 'Admin dashboard' },
  { key: 'DASHBOARD_DISCORD_IDS', label: 'Dashboard Discord IDs', type: 'text',   group: 'Admin dashboard', help: 'Comma-separated Discord user IDs.' },
  { key: 'WEBSITE_URL',           label: 'Website URL',           type: 'text',   group: 'Admin dashboard' },
  { key: 'ADMIN_URL',             label: 'Admin service URL',     type: 'text',   group: 'Admin dashboard', help: 'Local SkyMP-Admin service - never expose publicly.' },
  { key: 'ADMIN_TOKEN',           label: 'Admin token',           type: 'secret', group: 'Admin dashboard' },

  // Metrics
  { key: 'METRICS_USER',     label: 'Metrics user',     type: 'text',   group: 'Metrics' },
  { key: 'METRICS_PASSWORD', label: 'Metrics password', type: 'secret', group: 'Metrics' },

  // Access control
  { key: 'SERVER_LOCKED',          label: 'Server locked',     type: 'bool', group: 'Access control', help: 'Only allowed roles/users may join when on.' },
  { key: 'SERVER_LOCKED_ROLE_IDS', label: 'Locked role IDs',   type: 'text', group: 'Access control', help: 'Comma-separated Discord role IDs.' },
  { key: 'SERVER_LOCKED_ALLOW',    label: 'Locked allow list', type: 'text', group: 'Access control', help: 'Comma-separated Discord user IDs (legacy).' },
  { key: 'WHITELIST_ROLE_ID',      label: 'Whitelist role ID', type: 'text', group: 'Access control', help: 'Discord role used as the gameplay whitelist.' },
  { key: 'BANNED_ROLE_ID',         label: 'Banned role ID',    type: 'text', group: 'Access control' },
  { key: 'LAUNCH_CHECK_ENFORCE',   label: 'Enforce launch check', type: 'bool', group: 'Access control', help: 'Refuse connections whose launcher did not verify client files + load order. Unset = enforced.' },
  { key: 'BAN_LOG_DIR',            label: 'Ban log directory', type: 'text', group: 'Access control', help: 'Where ban snapshot logs are written. Empty = the default logs folder.' },

  // Databases
  { key: 'BACKEND_DATABASE_URI',  label: 'Backend Mongo URI',   type: 'secret', group: 'Databases', help: 'Empty = reuse the game server databaseUri from server-settings.json.' },
  { key: 'BACKEND_DATABASE_NAME', label: 'Backend database',    type: 'text',   group: 'Databases', placeholder: 'skymp-backend' },
  { key: 'GAME_DATABASE_NAME',    label: 'Game database',       type: 'text',   group: 'Databases', placeholder: 'skymp' },
]

module.exports = { serverSettings, backendEnv }
