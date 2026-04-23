import 'dotenv/config';
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'fs';

// Decode Google credentials from env vars (for cloud deployments)
{
  const credDir = new URL('../credentials', import.meta.url).pathname;
  mkdirSync(credDir, { recursive: true });
  if (process.env.GOOGLE_OAUTH_BASE64) {
    const p = process.env.GOOGLE_CREDENTIALS_PATH || './credentials/google-oauth.json';
    if (!existsSync(p)) {
      writeFileSync(p, Buffer.from(process.env.GOOGLE_OAUTH_BASE64, 'base64').toString('utf8'));
      console.log('[Server] Google OAuth credentials written from env var');
    }
  }
  if (process.env.GOOGLE_TOKEN_BASE64) {
    const p = process.env.GOOGLE_TOKEN_PATH || './credentials/google-token.json';
    writeFileSync(p, Buffer.from(process.env.GOOGLE_TOKEN_BASE64, 'base64').toString('utf8'));
    console.log('[Server] Google token written from env var →', p);
  }
}

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import QRCode from 'qrcode';

import { initWhatsApp, whatsappEvents, getStatus, getCurrentQr, fetchRecentMessages, sendWhatsAppMessage, stopWhatsApp, startWhatsApp, isBotEnabled, getBotPhoneNumber } from './whatsapp.js';
import { parseMessage } from './parser.js';
import { EventState } from './state.js';
import { getConfig, saveConfig, getGroupMap, saveGroupMap, getWeeklyPlan, saveWeeklyPlan, getCompletedTasks, saveCompletedTasks, getExcelPreview, saveExcelPreview } from './config.js';
import { parseExcelPlan } from './excel.js';
import multer from 'multer';
import {
  getAuthenticatedClient,
  isGoogleAuthenticated,
  resolveCalendarIds,
  getOrCreateCalendar,
  createAllDayEvent,
  fetchUpcomingEvents,
  fetchWeekEvents,
  startGoogleAuthFlow,
  createOAuthClient,
} from './calendar.js';
import { startScheduler, scheduleAt, getCurrentScheduledHour, getCurrentScheduledMinute } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Allow cross-origin requests from the Vercel-hosted frontend (or any origin if not set)
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*', credentials: false }));

// Kill any process already using our port before starting
try {
  execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
} catch (_) {}

// Clean up stale Chromium lock files from previous container (persistent volume)
try {
  const wauthPath = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';
  execSync(`find "${wauthPath}" \\( -name "SingletonLock" -o -name "SingletonCookie" -o -name "SingletonSocket" \\) -delete 2>/dev/null || true`, { stdio: 'ignore' });
} catch (_) {}

app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── State ────────────────────────────────────────────────────────────────────

const state = new EventState(process.env.STATE_FILE_PATH || './data/processed-events.json');
state.purgeOld();

let lastRun = null;
let lastSyncResults = null;
let totalEventsCreated = 0;
let lastTokenWarnDate = null; // prevent duplicate warnings on same day

// ─── Token age helper ─────────────────────────────────────────────────────────
/**
 * Returns how many days ago the Google refresh token was last authorized.
 * Uses the `authorized_at` field in the token JSON (set on OAuth callback),
 * falling back to the file modification time.
 */
function getTokenAgeDays() {
  const tokenPath = process.env.GOOGLE_TOKEN_PATH || './credentials/google-token.json';
  try {
    if (!existsSync(tokenPath)) return null;
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    if (token.authorized_at) {
      return (Date.now() - token.authorized_at) / (1000 * 60 * 60 * 24);
    }
    // fallback: file mtime (less reliable if overwritten by env-var bootstrap)
    return (Date.now() - statSync(tokenPath).mtimeMs) / (1000 * 60 * 60 * 24);
  } catch {
    return null;
  }
}

const sseClients = [];

function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, ts: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function log(msg) {
  console.log(msg);
  broadcast('log', msg);
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

export async function runSync() {
  log('[Sync] Starting...');
  lastRun = new Date().toISOString();
  const config = getConfig();

  // Always send tomorrow's tasks reminder — independent of Google auth
  await sendTomorrowTasks();
  await checkAndWarnTokenExpiry();

  if (!isGoogleAuthenticated()) {
    const err = 'Google Calendar not authenticated. Run: npm run setup-auth';
    log('[Sync] ERROR: ' + err);
    return { created: [], skipped: [], errors: [err] };
  }

  const results = { created: [], skipped: [], errors: [] };

  let auth, calendarIds;
  try {
    auth = await getAuthenticatedClient();
    calendarIds = await resolveCalendarIds(auth);
  } catch (err) {
    log('[Sync] Google auth error: ' + err.message);
    results.errors.push(err.message);
    return results;
  }

  const messages = await fetchRecentMessages(config.syncWindowHours);
  log(`[Sync] Fetched ${messages.length} recent messages from target groups`);

  for (const { body, groupName } of messages) {
    const events = parseMessage(body, groupName);
    if (!events) continue;

    for (const parsed of events) {
      if (state.has(parsed.fingerprint)) {
        results.skipped.push(parsed.fingerprint);
        continue;
      }
      try {
        const calId = await getOrCreateCalendar(auth, groupName, calendarIds);
        await createAllDayEvent(auth, calId, parsed.title, parsed.date);
        state.add(parsed.fingerprint);
        totalEventsCreated++;
        results.created.push({ title: parsed.title, date: parsed.date, calendar: groupName });
        log(`[Sync] Created: "${parsed.title}" on ${parsed.date} → ${groupName}`);
      } catch (err) {
        log(`[Sync] Error: ${err.message}`);
        results.errors.push(err.message);
      }
    }
  }

  log(`[Sync] Done. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`);
  lastSyncResults = results;
  broadcast('syncComplete', results);

  return results;
}

// ─── Token expiry WhatsApp warning ───────────────────────────────────────────

async function checkAndWarnTokenExpiry() {
  const ageDays = getTokenAgeDays();
  if (ageDays == null || ageDays < 5) return; // well within 7-day window

  const today = new Date().toISOString().slice(0, 10);
  if (lastTokenWarnDate === today) return; // already warned today

  const config = getConfig();
  if (!config.summaryRecipient) return;

  const daysLeft = Math.max(0, Math.round(7 - ageDays));
  const baseUrl = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
  const renewUrl = `${baseUrl}/auth/google/redirect`;
  const msg = daysLeft === 0
    ? `🔴 *טוקן Google Calendar פג!*\nהבוט לא יכול לגשת ליומן.\nלחץ לחידוש ישיר:\n${renewUrl}`
    : `⚠️ *טוקן Google Calendar פג בעוד ${daysLeft} ${daysLeft === 1 ? 'יום' : 'ימים'}*\nלחץ לחידוש לפני שיפסיק לעבוד:\n${renewUrl}`;

  const recipients = config.summaryRecipient.split(/[,;]/).map(r => r.trim()).filter(Boolean);
  for (const r of recipients) {
    await sendWhatsAppMessage(r, msg);
  }
  lastTokenWarnDate = today;
  log(`[Token] Expiry warning sent — ${daysLeft} days left`);
}

// ─── Weather helpers ──────────────────────────────────────────────────────────

function weatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 3)  return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  return '⛈️';
}

async function fetchWeatherForDate(isoDate) {
  try {
    const config = getConfig();
    const lat = config.latitude  || 32.0853;
    const lon = config.longitude || 34.7818;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
      `&timezone=Asia%2FJerusalem&forecast_days=4`;
    const resp = await fetch(url);
    const data = await resp.json();
    const idx = (data.daily?.time || []).indexOf(isoDate);
    if (idx === -1) return null;
    return {
      maxTemp: Math.round(data.daily.temperature_2m_max[idx]),
      minTemp: Math.round(data.daily.temperature_2m_min[idx]),
      precipitation: data.daily.precipitation_probability_max[idx] ?? 0,
      code: data.daily.weathercode[idx],
    };
  } catch { return null; }
}

// ─── Tomorrow tasks reminder ──────────────────────────────────────────────────

const HE_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

function getTomorrowISO() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  now.setDate(now.getDate() + 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getHebrewDayName(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  return 'יום ' + HE_DAYS[d.getDay()];
}

export async function sendTomorrowTasks() {
  const config = getConfig();
  if (!config.summaryRecipient || config.summaryEnabled === false) return;

  const plan = getWeeklyPlan();
  if (!plan?.tasks?.length) {
    log('[Tomorrow] No weekly plan saved — skipping daily reminder');
    return;
  }

  const tomorrow = getTomorrowISO();
  const tasks = plan.tasks.filter(t => t.dateISO === tomorrow && t.whatsappGroup);

  if (tasks.length === 0) {
    log(`[Tomorrow] No tasks for ${tomorrow} — skipping reminder`);
    return;
  }

  const dateLabel = tasks[0].dateLabel;
  const dayName = getHebrewDayName(tomorrow);

  let msg = `📋 משימות למחר — ${dayName} ${dateLabel}:\n\n`;
  tasks.forEach(t => { msg += `• ${t.taskText}\n`; });

  // Append weather forecast if available
  const weather = await fetchWeatherForDate(tomorrow);
  if (weather) {
    msg += `\n${weatherEmoji(weather.code)} מזג אוויר: ${weather.maxTemp}°/${weather.minTemp}° • גשם: ${weather.precipitation}%`;
  }
  msg = msg.trim();

  // Support multiple recipients separated by , or ;
  const recipients = config.summaryRecipient
    .split(/[,;]/)
    .map(r => r.trim())
    .filter(Boolean);

  let sentCount = 0;
  for (const recipient of recipients) {
    const sent = await sendWhatsAppMessage(recipient, msg);
    if (sent) sentCount++;
    log(`[Tomorrow] Reminder ${sent ? 'sent ✅' : 'failed ❌'} to ${recipient}`);
  }
  broadcast('log', `[Tomorrow] Reminder sent to ${sentCount}/${recipients.length} recipients — ${tasks.length} tasks`);
}

// ─── Express routes ───────────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.get('/qr', async (req, res) => {
  const qr = getCurrentQr();
  if (!qr) return res.status(404).json({ error: 'No QR code available' });
  try {
    res.json({ qr: await QRCode.toDataURL(qr) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google OAuth endpoints ───────────────────────────────────────────────────
// Helper: get correct protocol even behind Railway's reverse proxy
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return proto + '://' + req.get('host');
}

app.get('/auth/google/start', (req, res) => {
  try {
    const redirectUri = getBaseUrl(req) + '/auth/google/callback';
    const oAuth2Client = createOAuthClient(redirectUri);
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar'],
      prompt: 'consent',
    });
    res.json({ authUrl, redirectUri });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h2>שגיאה — לא התקבל קוד מ-Google</h2>');
  try {
    const oAuth2Client = createOAuthClient(getBaseUrl(req) + '/auth/google/callback');
    const { tokens } = await oAuth2Client.getToken(code);
    // Stamp when the refresh token was issued so we can warn before 7-day expiry (Testing mode)
    const tokenWithMeta = { ...tokens, authorized_at: Date.now() };
    writeFileSync(process.env.GOOGLE_TOKEN_PATH || './credentials/google-token.json', JSON.stringify(tokenWithMeta, null, 2));
    broadcast('google-auth', { authenticated: true });
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;direction:rtl">
      <h2>✅ Google Calendar מחובר בהצלחה!</h2>
      <p>אפשר לסגור את הכרטיסייה הזו ולחזור לבוט.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (err) {
    res.send('<h2>שגיאה: ' + err.message + '</h2><p>ייתכן שצריך להוסיף את כתובת ה-callback לרשימת ה-redirect URIs ב-Google Cloud Console</p>');
  }
});

app.get('/status', (req, res) => {
  const wa = getStatus();
  res.json({
    whatsappConnected: wa.connected,
    qrAvailable: wa.qrAvailable,
    googleAuthenticated: isGoogleAuthenticated(),
    botEnabled: isBotEnabled(),
    botPhoneNumber: getBotPhoneNumber(),
    tokenAgeDays: getTokenAgeDays(),
    lastRun,
    totalEventsCreated,
    lastSyncResults,
  });
});

// ── Bot On/Off ─────────────────────────────────────────────────────────────────
app.post('/bot/start', (req, res) => {
  startWhatsApp();
  broadcast('status', {});
  res.json({ ok: true });
});

app.post('/bot/stop', async (req, res) => {
  await stopWhatsApp();
  broadcast('status', {});
  res.json({ ok: true });
});

app.post('/trigger', async (req, res) => {
  try {
    const results = await runSync();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/test-message', async (req, res) => {
  const { summaryRecipient } = getConfig();
  if (!summaryRecipient) return res.json({ ok: false, error: 'No summary recipient configured' });
  const recipients = summaryRecipient.split(/[,;]/).map(r => r.trim()).filter(Boolean);
  let sentCount = 0;
  for (const r of recipients) {
    const sent = await sendWhatsAppMessage(r, '✅ הודעת בדיקה מהבוט — הכל עובד!');
    if (sent) sentCount++;
    log(`[Test] Message ${sent ? 'sent ✅' : 'failed ❌'} to ${r}`);
  }
  res.json({ ok: sentCount > 0, recipient: summaryRecipient, sent: sentCount, total: recipients.length });
});

// Config endpoints
app.get('/config', (req, res) => res.json(getConfig()));

app.post('/config', (req, res) => {
  const current = getConfig();
  const updated = {
    groups: Array.isArray(req.body.groups) ? req.body.groups.map(g => g.trim()).filter(Boolean) : current.groups,
    syncWindowHours: Number(req.body.syncWindowHours) || current.syncWindowHours,
    summaryRecipient: req.body.summaryRecipient ?? current.summaryRecipient,
    summaryEnabled: req.body.summaryEnabled !== undefined ? Boolean(req.body.summaryEnabled) : (current.summaryEnabled ?? true),
    summaryHour: req.body.summaryHour !== undefined ? Number(req.body.summaryHour) : current.summaryHour,
    summaryMinute: req.body.summaryMinute !== undefined ? Number(req.body.summaryMinute) : (current.summaryMinute ?? 0),
    themeColor: req.body.themeColor ?? current.themeColor ?? '#3DBDB4',
    logoData: current.logoData ?? null,
    logoOrientation: current.logoOrientation ?? 'landscape',
    logoSize: req.body.logoSize !== undefined ? Number(req.body.logoSize) : (current.logoSize ?? 80),
    latitude:  req.body.latitude  !== undefined ? Number(req.body.latitude)  : (current.latitude  ?? 32.0853),
    longitude: req.body.longitude !== undefined ? Number(req.body.longitude) : (current.longitude ?? 34.7818),
  };
  saveConfig(updated);
  // Reschedule if time changed
  if (updated.summaryHour !== getCurrentScheduledHour() || updated.summaryMinute !== getCurrentScheduledMinute()) {
    scheduleAt(updated.summaryHour, updated.summaryMinute, runSync);
  }
  const hh = String(updated.summaryHour).padStart(2,'0');
  const mm = String(updated.summaryMinute ?? 0).padStart(2,'0');
  log(`[Config] Updated: groups=${updated.groups.join(', ')}, window=${updated.syncWindowHours}h, summaryTime=${hh}:${mm}`);
  res.json({ ok: true, config: updated });
});

// Logo upload
app.post('/config/google-credentials', (req, res) => {
  const { oauth, token } = req.body;
  if (!oauth) return res.status(400).json({ ok: false, error: 'oauth missing' });
  try {
    JSON.parse(oauth);
    const credDir = new URL('../credentials', import.meta.url).pathname;
    mkdirSync(credDir, { recursive: true });
    writeFileSync(process.env.GOOGLE_CREDENTIALS_PATH || './credentials/google-oauth.json', oauth);
    if (token) {
      const tokenObj = JSON.parse(token);
      // Stamp authorized_at so the token-age warning works correctly
      if (!tokenObj.authorized_at) tokenObj.authorized_at = Date.now();
      writeFileSync(process.env.GOOGLE_TOKEN_PATH || './credentials/google-token.json', JSON.stringify(tokenObj, null, 2));
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/config/logo', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const allowed = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'File type not supported' });
  const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const current = getConfig();
  saveConfig({ ...current, logoData: b64, logoOrientation: req.body.orientation || 'landscape' });
  res.json({ ok: true, logoData: b64 });
});

app.delete('/config/logo', (req, res) => {
  const current = getConfig();
  saveConfig({ ...current, logoData: null });
  res.json({ ok: true });
});

// Calendar events for the calendar view (next 60 days across all configured calendars)
app.get('/calendar-events', async (req, res) => {
  if (!isGoogleAuthenticated()) return res.json({ events: [] });
  try {
    const auth = await getAuthenticatedClient();
    const { groups } = getConfig();
    const events = await fetchUpcomingEvents(auth, groups, 60);
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Excel routes ─────────────────────────────────────────────────────────────

// Weekly plan persistence (for daily tomorrow-tasks reminder)
app.post('/excel/save-plan', (req, res) => {
  const { weekLabel, tasks, allTasks } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ ok: false, error: 'tasks missing' });
  saveWeeklyPlan({ weekLabel, tasks, savedAt: new Date().toISOString() });
  // Also persist the full table (all tasks including unmapped) for UI restoration after refresh
  if (Array.isArray(allTasks)) {
    saveExcelPreview({ weekLabel, allTasks, savedAt: new Date().toISOString() });
  }
  log(`[Plan] Weekly plan saved: ${tasks.length} tasks (${weekLabel})`);
  res.json({ ok: true, count: tasks.length });
});

app.get('/excel/saved-plan', (req, res) => {
  const plan = getWeeklyPlan();
  res.json(plan || { tasks: [], weekLabel: null, savedAt: null });
});

// Restore full preview table after page refresh — recomputes alreadySent from live state
app.get('/excel/preview', (req, res) => {
  const preview = getExcelPreview();
  if (!preview) return res.json(null);
  const allTasks = (preview.allTasks || []).map(t => ({
    ...t,
    alreadySent: !!t.fingerprint && state.has(t.fingerprint),
  }));
  res.json({ weekLabel: preview.weekLabel, allTasks, savedAt: preview.savedAt });
});

app.get('/excel/group-map', (req, res) => res.json(getGroupMap()));

app.post('/excel/group-map', (req, res) => {
  saveGroupMap(req.body);
  res.json({ ok: true });
});

app.post('/excel/parse', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  try {
    const { weekLabel, columns, tasks } = parseExcelPlan(req.file.buffer);
    const groupMap = getGroupMap();
    const enriched = tasks.map(t => {
      const whatsappGroup = groupMap[t.excelGroup] || '';
      const fingerprint = `${whatsappGroup}|${t.taskText}|${t.dateISO}`;
      return {
        ...t,
        whatsappGroup,
        fingerprint,
        willSend: !!whatsappGroup,
        alreadySent: !!whatsappGroup && state.has(fingerprint),
      };
    });
    res.json({ weekLabel, columns, tasks: enriched });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/excel/dispatch', async (req, res) => {
  const { tasks, calendarOnly = false } = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks missing' });

  const results = { created: [], skipped: [], errors: [] };
  if (!isGoogleAuthenticated()) {
    results.errors.push('Google Calendar not authenticated');
    return res.json(results);
  }

  let auth, calendarIds;
  try {
    auth = await getAuthenticatedClient();
    calendarIds = await resolveCalendarIds(auth);
  } catch (err) {
    results.errors.push(err.message);
    return res.json(results);
  }

  for (const task of tasks) {
    if (!task.whatsappGroup || !task.willSend) { results.skipped.push(task.fingerprint); continue; }

    // Use separate fingerprint prefix for calendar-only to track independently
    const fp = calendarOnly ? `cal:${task.fingerprint}` : task.fingerprint;
    if (state.has(fp)) { results.skipped.push(fp); continue; }

    try {
      // Send to WhatsApp group (unless calendarOnly mode)
      if (!calendarOnly) {
        const msgText = `${task.taskText} ${task.dateLabel}`;
        const sent = await sendWhatsAppMessage(task.whatsappGroup, msgText);
        if (!sent) log(`[Excel] WhatsApp send failed for: ${msgText}`);
      }

      // Create calendar event (skips if already exists in Google Calendar)
      const calId = await getOrCreateCalendar(auth, task.whatsappGroup, calendarIds);
      const created = await createAllDayEvent(auth, calId, task.taskText, task.dateISO);
      state.add(fp);
      if (created) {
        totalEventsCreated++;
        results.created.push({ title: task.taskText, date: task.dateISO, calendar: task.whatsappGroup });
        log(`[Excel] ${calendarOnly ? '📅' : '📤'} "${task.taskText}" on ${task.dateISO} → ${task.whatsappGroup}`);
      } else {
        results.skipped.push(fp);
        log(`[Excel] ⏭ already exists: "${task.taskText}" on ${task.dateISO}`);
      }
    } catch (err) {
      log(`[Excel] Error: ${err.message}`);
      results.errors.push(err.message);
    }
  }

  log(`[Excel] Done. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`);
  broadcast('syncComplete', results);
  res.json(results);
});

// ─── Resend a single Excel task ──────────────────────────────────────────────
app.post('/excel/resend', async (req, res) => {
  const { task } = req.body;
  if (!task || !task.fingerprint) return res.status(400).json({ ok: false, error: 'task missing' });

  // Remove from state so it can be re-sent
  state.remove(task.fingerprint);

  if (!isGoogleAuthenticated()) return res.json({ ok: false, error: 'Google not authenticated' });

  try {
    const auth = await getAuthenticatedClient();
    const calendarIds = await resolveCalendarIds(auth);
    const msgText = `${task.taskText} ${task.dateLabel}`;
    const sent = await sendWhatsAppMessage(task.whatsappGroup, msgText);
    const calId = await getOrCreateCalendar(auth, task.whatsappGroup, calendarIds);
    await createAllDayEvent(auth, calId, task.taskText, task.dateISO);
    state.add(task.fingerprint);
    log(`[Excel] Resent: "${task.taskText}" on ${task.dateISO} → ${task.whatsappGroup} | WhatsApp: ${sent ? '✅' : '❌'}`);
    res.json({ ok: true, whatsappSent: sent });
  } catch (err) {
    log(`[Excel] Resend error: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

// ─── WhatsApp real-time message handler ──────────────────────────────────────

whatsappEvents.on('log', (msg) => broadcast('log', msg));
whatsappEvents.on('ready', () => broadcast('status', { whatsappConnected: true }));
whatsappEvents.on('disconnected', () => broadcast('status', { whatsappConnected: false }));
whatsappEvents.on('qr', () => broadcast('status', { qrAvailable: true }));

whatsappEvents.on('message', async ({ body, groupName }) => {
  if (!isGoogleAuthenticated()) return;
  const events = parseMessage(body, groupName);
  if (!events) return;

  try {
    const auth = await getAuthenticatedClient();
    const calendarIds = await resolveCalendarIds(auth);
    for (const parsed of events) {
      if (state.has(parsed.fingerprint)) continue;
      const calId = await getOrCreateCalendar(auth, groupName, calendarIds);
      await createAllDayEvent(auth, calId, parsed.title, parsed.date);
      state.add(parsed.fingerprint);
      totalEventsCreated++;
      log(`[Realtime] Created: "${parsed.title}" on ${parsed.date} → ${groupName}`);
      broadcast('syncComplete', { created: [{ title: parsed.title, date: parsed.date, calendar: groupName }], skipped: [], errors: [] });
    }
  } catch (err) {
    log(`[Realtime] Error: ${err.message}`);
  }
});

// ─── Google OAuth direct redirect (for WhatsApp links) ───────────────────────
app.get('/auth/google/redirect', (req, res) => {
  try {
    const redirectUri = getBaseUrl(req) + '/auth/google/callback';
    const oAuth2Client = createOAuthClient(redirectUri);
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar'],
      prompt: 'consent',
    });
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send('שגיאה: ' + err.message);
  }
});

// ─── Weather proxy (Open-Meteo, no API key needed) ────────────────────────────
app.get('/weather', async (req, res) => {
  const config = getConfig();
  const lat = config.latitude  || 32.0853;
  const lon = config.longitude || 34.7818;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
      `&timezone=Asia%2FJerusalem&forecast_days=4`;
    const resp = await fetch(url);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Task completion ──────────────────────────────────────────────────────────
app.get('/tasks/completed', (req, res) => {
  res.json({ completed: getCompletedTasks() });
});

app.post('/tasks/toggle', (req, res) => {
  const { fingerprint, completed } = req.body;
  if (!fingerprint) return res.status(400).json({ ok: false, error: 'fingerprint missing' });
  let list = getCompletedTasks();
  if (completed) {
    if (!list.includes(fingerprint)) list.push(fingerprint);
  } else {
    list = list.filter(f => f !== fingerprint);
  }
  saveCompletedTasks(list);
  res.json({ ok: true });
});

// Reset all weekly plan data (preview + completed tasks) — called when uploading a new week's file
app.delete('/excel/reset', (req, res) => {
  try {
    saveCompletedTasks([]);
    saveExcelPreview(null);
    log('[Reset] Weekly plan data cleared');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n[Server] Running at http://localhost:${PORT}\n`);
  initWhatsApp();
  startScheduler(runSync);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[Server] Port ${PORT} busy — killing old process and retrying...\n`);
    try { execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' }); } catch (_) {}
    setTimeout(() => server.listen(PORT), 2000);
  } else {
    throw err;
  }
});
