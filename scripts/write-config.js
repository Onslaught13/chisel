// Netlify build step: overrides values in public/config.js from environment variables, when set.
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, GOOGLE_CLIENT_ID
const fs = require('fs');
const env = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
};
const overrides = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, (v || '').trim()]).filter(([, v]) => v));
if (!Object.keys(overrides).length) {
  console.log('No config overrides set; using public/config.js as committed.');
} else {
  fs.appendFileSync('public/config.js', '\nObject.assign(window.CHISEL_CONFIG, ' + JSON.stringify(overrides) + ');\n');
  console.log('Config overrides applied: ' + Object.keys(overrides).join(', '));
}
if (!overrides.googleClientId && !/googleClientId:\s*'[^']+'/.test(fs.readFileSync('public/config.js', 'utf8'))) {
  console.warn('GOOGLE_CLIENT_ID is not set: the "Connect Google Drive" option will be hidden.');
}
