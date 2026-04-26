import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import 'dotenv/config';
import { getConfig } from './config.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getSAPath() {
  return process.env.GOOGLE_SA_PATH || './credentials/google-service-account.json';
}

/**
 * Returns true if a Service Account JSON is available (env var or file).
 */
export function isGoogleAuthenticated() {
  return !!process.env.GOOGLE_SA_BASE64 || existsSync(getSAPath());
}

/**
 * Returns an authorized Google JWT client using the Service Account credentials.
 */
export async function getAuthenticatedClient() {
  let sa;

  if (process.env.GOOGLE_SA_BASE64) {
    try {
      sa = JSON.parse(Buffer.from(process.env.GOOGLE_SA_BASE64, 'base64').toString('utf8'));
    } catch (err) {
      throw new Error('Invalid GOOGLE_SA_BASE64: ' + err.message);
    }
  } else {
    const path = getSAPath();
    if (!existsSync(path)) {
      throw new Error(`Service account credentials not found at ${path}. Set GOOGLE_SA_BASE64 env var or place the JSON at ${path}.`);
    }
    sa = JSON.parse(readFileSync(path, 'utf8'));
  }

  const auth = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    SCOPES
  );
  await auth.authorize();
  return auth;
}

/**
 * Returns the calendar ID map from config: { groupName -> calendarId }.
 * This replaces the old API-based calendarList.list() approach — no API call needed.
 */
export async function resolveCalendarIds(_auth) {
  const { calendarMap } = getConfig();
  return calendarMap || {};
}

/**
 * Returns the calendar ID for the given group name from the config map.
 * Returns null if no mapping exists. Never creates new calendars.
 */
export async function getOrCreateCalendar(_auth, calendarName, calendarIdMap) {
  const calId = calendarIdMap[calendarName];
  if (!calId) {
    console.log(`[Calendar] No mapping for "${calendarName}" — skipping calendar write`);
    return null;
  }
  return calId;
}

/**
 * Creates an all-day event only if an event with the same title doesn't
 * already exist on that date in that calendar.
 * Returns true if created, false if skipped (already exists).
 */
export async function createAllDayEvent(auth, calendarId, title, dateISO) {
  const calendar = google.calendar({ version: 'v3', auth });

  // Query a 3-day window to safely catch all-day events regardless of timezone offset
  const d = new Date(dateISO + 'T12:00:00Z');
  const dayBefore = new Date(d); dayBefore.setDate(d.getDate() - 1);
  const dayAfter  = new Date(d); dayAfter.setDate(d.getDate() + 2);

  const existing = await calendar.events.list({
    calendarId,
    timeMin: dayBefore.toISOString(),
    timeMax: dayAfter.toISOString(),
    singleEvents: true,
    maxResults: 100,
  });

  const duplicate = (existing.data.items || []).some(ev => {
    const evDate = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
    return evDate === dateISO && (ev.summary || '').trim() === title.trim();
  });
  if (duplicate) return false;

  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      start: { date: dateISO },
      end: { date: dateISO },
    },
  });
  return true;
}

/**
 * Fetches upcoming all-day events for the given calendar names within the next `days` days.
 * Returns a flat array of { title, date, calendar } objects.
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
  // Saturday 00:00 (exclusive upper bound = end of Friday)
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
