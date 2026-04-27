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
 * Deletes all all-day events matching the given title and date from a calendar.
 * Returns the number of events deleted.
 */
export async function deleteAllDayEvent(auth, calendarId, title, dateISO) {
  const calendar = google.calendar({ version: 'v3', auth });

  // Query a 3-day window (same as createAllDayEvent) to catch timezone-shifted all-day events
  const d = new Date(dateISO + 'T12:00:00Z');
  const dayBefore = new Date(d); dayBefore.setDate(d.getDate() - 1);
  const dayAfter  = new Date(d); dayAfter.setDate(d.getDate() + 2);

  const existing = await calendar.events.list({
    calendarId,
    timeMin:       dayBefore.toISOString(),
    timeMax:       dayAfter.toISOString(),
    singleEvents:  true,
    maxResults:    100,
  });

  let deleted = 0;
  for (const ev of existing.data.items || []) {
    const evDate = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
    if (evDate === dateISO && (ev.summary || '').trim() === title.trim()) {
      await calendar.events.delete({ calendarId, eventId: ev.id });
      deleted++;
    }
  }
  return deleted;
}

/**
 * Force-reconcile Google Calendar against the given plan tasks.
 *
 * For each calendar (grouped by whatsappGroup):
 *  1. Fetch all events in a ±60-day window.
 *  2. For any event whose title matches a plan task title but sits on a
 *     date NOT listed in the plan for that title → delete it (stale event).
 *  3. For each plan task, if no event exists on the correct date → create it.
 *
 * Returns { deleted, created, skipped, errors }.
 */
export async function forceResyncCalendar(auth, calendarIdMap, tasks) {
  const cal = google.calendar({ version: 'v3', auth });
  const results = { deleted: 0, created: 0, skipped: 0, errors: [] };

  // Group mapped tasks by calendarId
  const byCalId = {};
  for (const task of tasks) {
    if (!task.willSend || !task.whatsappGroup) continue;
    const calId = calendarIdMap[task.whatsappGroup];
    if (!calId) continue;
    if (!byCalId[calId]) byCalId[calId] = [];
    byCalId[calId].push(task);
  }

  const now      = new Date();
  const timeMin  = new Date(now.getTime() - 60 * 86400000).toISOString();
  const timeMax  = new Date(now.getTime() + 90 * 86400000).toISOString();

  for (const [calId, calTasks] of Object.entries(byCalId)) {
    // Fetch all events for this calendar in the window
    let allEvents = [];
    try {
      const resp = await cal.events.list({
        calendarId:   calId,
        timeMin,
        timeMax,
        singleEvents: true,
        maxResults:   500,
      });
      allEvents = resp.data.items || [];
    } catch (err) {
      results.errors.push(`list events: ${err.message}`);
      continue;
    }

    // Build { title -> Set<correctDates> } from plan tasks in this calendar
    const titleToDates = {};
    for (const t of calTasks) {
      const key = t.taskText.trim();
      if (!titleToDates[key]) titleToDates[key] = new Set();
      titleToDates[key].add(t.dateISO);
    }
    const planTitles = new Set(Object.keys(titleToDates));

    // Delete stale events: title in plan but date wrong
    for (const ev of allEvents) {
      const evTitle = (ev.summary || '').trim();
      if (!planTitles.has(evTitle)) continue; // not a plan event — leave alone
      const evDate = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
      if (!titleToDates[evTitle].has(evDate)) {
        // Stale — on wrong date
        try {
          await cal.events.delete({ calendarId: calId, eventId: ev.id });
          results.deleted++;
        } catch (e) {
          results.errors.push(`delete ${evTitle}@${evDate}: ${e.message}`);
        }
      }
    }

    // Ensure each plan task's event exists on the correct date (create if missing)
    for (const task of calTasks) {
      const title = task.taskText.trim();
      const date  = task.dateISO;
      const exists = allEvents.some(ev => {
        const evDate = ev.start?.date || ev.start?.dateTime?.slice(0, 10);
        return (ev.summary || '').trim() === title && evDate === date;
      });
      if (exists) {
        results.skipped++;
      } else {
        try {
          await cal.events.insert({
            calendarId:  calId,
            requestBody: { summary: title, start: { date }, end: { date } },
          });
          results.created++;
        } catch (e) {
          results.errors.push(`create ${title}@${date}: ${e.message}`);
        }
      }
    }
  }

  return results;
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
