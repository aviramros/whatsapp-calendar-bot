import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

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
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import QRCode from 'qrcode';

import { initWhatsApp, whatsappEvents, getStatus, getCurrentQr, fetchRecentMessages, sendWhatsAppMessage, stopWhatsApp, startWhatsApp, isBotEnabled } from './whatsapp.js';
import { parseMessage } from './parser.js';
import { EventState } from './state.js';
import { getConfig, saveConfig, getGroupMap, saveGroupMap } from './config.js';
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
} from './calendar.js';
import { startScheduler, scheduleAt, getCurrentScheduledHour, getCurrentScheduledMinute } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Kill any process already using our port before starting
try {
  execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
} catch (_) {}

// Clean up WhatsApp session lock if leftover
try {
  execSync(`rm -f .wwebjs_auth/session/SingletonLock .wwebjs_auth/session/SingletonCookie`, { stdio: 'ignore' });
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

  // Send weekly summary if configured
  if (config.summaryRecipient && config.summaryEnabled !== false) {
    try {
      const weekEvents = await fetchWeekEvents(auth, config.groups);
      let msg;
      if (weekEvents.length > 0) {
        const lines = weekEvents.map(e => `✅ ${e.title}`);
        msg = `📋 סיכום שבועי:\n${lines.join('\n')}`;
      } else {
        msg = `📋 סיכום שבועי:\nאין משימות השבוע.`;
      }
      const sent = await sendWhatsAppMessage(config.summaryRecipient, msg);
      log(`[Sync] Summary ${sent ? 'sent ✅' : 'failed ❌'} to ${config.summaryRecipient}`);
    } catch (err) {
      log(`[Sync] Summary error: ${err.message}`);
    }
  }

  return results;
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

app.get('/status', (req, res) => {
  const wa = getStatus();
  res.json({
    whatsappConnected: wa.connected,
    qrAvailable: wa.qrAvailable,
    googleAuthenticated: isGoogleAuthenticated(),
    botEnabled: isBotEnabled(),
    lastRun,
    totalEventsCreated,
    lastSyncResults,
  });
});

// ── Google Calendar OAuth via UI ───────────────────────────────────────────────
app.get('/auth/google/start', (req, res) => {
  try {
    const authUrl = startGoogleAuthFlow(() => {
      broadcast('google-auth', { authenticated: true });
      log('[Auth] Google Calendar connected successfully ✅');
    });
    res.json({ authUrl });
  } catch (err) {
    res.json({ error: err.message });
  }
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
  const sent = await sendWhatsAppMessage(summaryRecipient, '✅ הודעת בדיקה מהבוט — הכל עובד!');
  log(`[Test] Message ${sent ? 'sent ✅' : 'failed ❌'} to ${summaryRecipient}`);
  res.json({ ok: sent, recipient: summaryRecipient });
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
  const { tasks } = req.body;
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
    if (state.has(task.fingerprint)) { results.skipped.push(task.fingerprint); continue; }

    try {
      // Send to WhatsApp group (best-effort)
      const msgText = `${task.taskText} ${task.dateLabel}`;
      const sent = await sendWhatsAppMessage(task.whatsappGroup, msgText);
      if (!sent) log(`[Excel] WhatsApp send failed for: ${msgText}`);

      // Create calendar event directly
      const calId = await getOrCreateCalendar(auth, task.whatsappGroup, calendarIds);
      await createAllDayEvent(auth, calId, task.taskText, task.dateISO);
      state.add(task.fingerprint);
      totalEventsCreated++;
      results.created.push({ title: task.taskText, date: task.dateISO, calendar: task.whatsappGroup });
      log(`[Excel] Created: "${task.taskText}" on ${task.dateISO} → ${task.whatsappGroup}`);
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
