// Netlify build step: writes public/config.js from the GOOGLE_CLIENT_ID environment variable.
const fs = require('fs');
const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
if (!id) {
  console.warn('GOOGLE_CLIENT_ID is not set; the app will ask for a client ID on first visit.');
} else {
  fs.writeFileSync('public/config.js', 'window.CHISEL_CONFIG = { clientId: ' + JSON.stringify(id) + ' };\n');
  console.log('Wrote public/config.js');
}
