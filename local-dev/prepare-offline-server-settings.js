// Prepare the generated server settings for the local offline launcher.
// This removes copied production-only credentials, disables master/voice, and
// points persistence and VGR extensions at the local no-auth MongoDB instance.
const fs = require('fs');
const path = require('path');

const LOCAL_MONGO_URI = 'mongodb://127.0.0.1:27017/vengeful_realms';
const LOCAL_TEST_ADMIN_PROFILE_ID = 1;

const settingsPath = process.argv[2] || path.join(
  __dirname,
  '..',
  'build',
  'dist',
  'server',
  'server-settings.json',
);

if (!fs.existsSync(settingsPath)) {
  console.error('server-settings.json not found: ' + settingsPath);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

settings.master = '';
settings.masterKey = null;
settings.offlineMode = true;
settings.ip = '127.0.0.1';
settings.databaseDriver = 'mongodb';
settings.databaseName = 'vengeful_realms';
settings.databaseUri = LOCAL_MONGO_URI;

delete settings.masterApiAuthToken;
delete settings.discordAuth;
delete settings.voice;

// Keep the offline test character able to use VGR admin controls after a
// fresh server build regenerates server-settings.json.
const managePermission = settings.vgrAccessControl?.permissions?.['vgr.access.manage'];
if (managePermission) {
  const profileIds = Array.isArray(managePermission.profileIds)
    ? managePermission.profileIds.map(Number).filter(Number.isInteger)
    : [];
  if (!profileIds.includes(LOCAL_TEST_ADMIN_PROFILE_ID)) {
    profileIds.push(LOCAL_TEST_ADMIN_PROFILE_ID);
  }
  managePermission.profileIds = profileIds;
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Prepared offline server settings: master=disabled, database=local MongoDB/vengeful_realms, voice=disabled');
