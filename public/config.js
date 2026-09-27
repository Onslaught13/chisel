// Public configuration. None of these values are secrets: the Supabase publishable key only allows
// what the database's row-level security policies allow, and a Google client ID is meant to be public.
// On Netlify, scripts/write-config.js appends overrides from environment variables.
window.CHISEL_CONFIG = {
  supabaseUrl: 'https://xhqokhbqegxyidzqecyj.supabase.co',
  supabaseKey: 'sb_publishable__euqgdanUAfKctiq-qUR1g_Kanhuy7u',
  googleClientId: '',   // OAuth "Web application" client ID, used for the optional Google Drive copy
};
