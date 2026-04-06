import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import 'dotenv/config';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getCredentialsPath() {
  return process.env.GOOGLE_CREDENTIALS_PATH || './credentials/google-oauth.json';
}

function getTokenPath() {
  return process.env.GOOGLE_TOKEN_PATH || './credentials/google-token.json';
}

export function createOAuthClient(customRedirectUri) {
  const credsPath = getCredentialsPath();
  if (!existsSync(credsPath)) {
    throw new Error(`Google credentials not found at ${credsPath}. See README for setup instructions.`);
  }
  const credentials = JSON.parse(readFileSync(credsPath, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, customRedirectUri || redirect_uris[0]);
}

export function isGoogleAuthenticated() {
  return existsSync(getTokenPath());
}

export async function getAuthenticatedClient() {
  const oAuth2Client = createOAuthClient();
  if (!existsSync(getTokenPath())) {
    throw new Error('Google not authenticated. Run: npm run setup-auth');
  }
  const token = JSON.parse(readFileSync(getTokenPath(), 'utf8'));
  oAuth2Client.setCredentials(token);

  // Persist refreshed tokens automatically
  oAuth2Client.on('tokens', (newTokens) => {
    const existing = existsSync(getTokenPath())
      ? JSON.parse(readFileSync(getTokenPath(), 'utf8'))
      : {};
    writeFileSync(getTokenPath(), JSON.stringify({ ...existing, ...newTokens }, null, 2));
  });

  return oAuth2Client;
}

/**
 * Returns a map of { calendarDisplayName -> calendarId }
 */
export async function resolveCalendarIds(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  const response = await calendar.calendarList.list();
  const map = {};
  for (const cal of response.data.items || []) {
    map[cal.summary] = cal.id;
  }
  return map;
}

/**
 * Gets existing calendar ID or creates a new calendar with the given name.
 */
export async function getOrCreateCalendar(auth, calendarName, calendarIdMap) {
  if (calendarIdMap[calendarName]) return calendarIdMap[calendarName];

  const calendar = google.calendar({ version: 'v3', auth });
  const newCal = await calendar.calendars.insert({
    requestBody: { summary: calendarName },
  });
  calendarIdMap[calendarName] = newCal.data.id;
  console.log(`[Calendar] Created new calendar: "${calendarName}"`);
  return newCal.data.id;
}

/**
 * Creates an all-day event on the given calendar.
 */
export async function createAllDayEvent(auth, calendarId, title, dateISO) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      start: { date: dateISO },
      end: { date: dateISO },
    },
  });
}

/**
 * Fetches upcoming all-day events for the given calendar names within the next `days` days.
 * Returns a flat array of { title, date, calendar, color } objects.
 */
export async function fetchUpcomingEvents(auth, calendarNames, days = 60) {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarIds = await resolveCalendarIds(auth);

  const now = new Date();
  const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const results = [];
  for (const name of calendarNames) {
    const calId = calendarIds[name];
    if (!calId) continue;
    try {
      const resp = await calendar.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      for (const ev of resp.data.items || []) {
        const date = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
        if (date) results.push({ title: ev.summary || '', date, calendar: name });
      }
    } catch {}
  }
  return results;
}

/**
 * Fetches all events for the current week (Sunday to Friday, Israel week).
 * Returns a flat array of { title, date, calendar } sorted by date.
 */
export async function fetchWeekEvents(auth, calendarNames) {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarIds = await resolveCalendarIds(auth);

  const now = new Date();
  // Find Sunday of current week
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay());
  sunday.setHours(0, 0, 0, 0);
  // Friday end = Saturday 00:00 (exclusive upper bound)
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  saturday.setHours(0, 0, 0, 0);

  const timeMin = sunday.toISOString();
  const timeMax = saturday.toISOString();

  const results = [];
  for (const name of calendarNames) {
    const calId = calendarIds[name];
    if (!calId) continue;
    try {
      const resp = await calendar.events.list({
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      for (const ev of resp.data.items || []) {
        const date = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
        if (date) results.push({ title: ev.summary || '', date, calendar: name });
      }
    } catch {}
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Starts the Google OAuth2 flow from within the running server.
 * Returns the auth URL to open in the browser.
 * onSuccess is called when the token is saved successfully.
 */
export function startGoogleAuthFlow(onSuccess) {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  const callbackServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost:3001');
      const code = url.searchParams.get('code');
      if (!code) { res.end('No code received.'); return; }
      const { tokens } = await oAuth2Client.getToken(code);
      writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;direction:rtl">
        <h2>✅ Google Calendar מחובר בהצלחה!</h2>
        <p>אפשר לסגור את הכרטיסייה הזו ולחזור לבוט.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>`);
      callbackServer.close();
      if (onSuccess) onSuccess();
    } catch (err) {
      res.end('Error: ' + err.message);
      callbackServer.close();
    }
  });

  callbackServer.on('error', () => {}); // ignore EADDRINUSE if already listening
  callbackServer.listen(3001);
  return authUrl;
}

// ─── One-time OAuth2 setup (npm run setup-auth) ──────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('calendar.js') && process.argv[2] === '--auth') {
  runAuthFlow();
}

async function runAuthFlow() {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\nOpen this URL in your browser to authorize Google Calendar access:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...\n');

  // Start a local server to capture the OAuth2 redirect
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost:3001');
      const code = url.searchParams.get('code');
      if (!code) {
        res.end('No code received. Please try again.');
        return;
      }
      const { tokens } = await oAuth2Client.getToken(code);
      writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));
      res.end('<h1>Authorization successful!</h1><p>You can close this tab. The bot is now authorized.</p>');
      console.log('Authorization successful! Token saved to', getTokenPath());
      server.close(() => process.exit(0));
    } catch (err) {
      res.end('Error: ' + err.message);
      console.error('Auth error:', err.message);
      server.close(() => process.exit(1));
    }
  });

  server.listen(3001, () => {
    console.log('Listening for OAuth2 callback on http://localhost:3001');
    console.log('(Make sure your Google OAuth2 redirect URI includes http://localhost:3001)\n');
  });
}
