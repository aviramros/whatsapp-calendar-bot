import 'dotenv/config';
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'fs';

// Decode Google credentials from env vars (for cloud deployments)
{
  const credDir = new URL('../credentials', import.meta.url).pathname;
  mkdirSync(credDir, { recursive: true });
  // Service Account JSON (primary — replaces OAuth2)
  if (process.env.GOOGLE_SA_BASE64) {
    const p = process.env.GOOGLE_SA_PATH || './credentials/google-service-account.json';
    if (!existsSync(p)) {
      writeFileSync(p, Buffer.from(process.env.GOOGLE_SA_BASE64, 'base64').toString('utf8'));
      console.log('[Server] Google Service Account credentials written from env var');
    }
  }
  // Legacy OAuth2 bootstrap (kept for backward-compat, not used when SA is configured)
  if (process.env.GOOGLE_OAUTH_BASE64) {
    const p = process.env.GOOGLE_CREDENTIALS_PATH || './credentials/google-oauth.json';
    if (!existsSync(p)) {
      writeFileSync(p, Buffer.from(process.env.GOOGLE_OAUTH_BASE64, 'base64').toString('utf8'));
      console.log('[Server] Google OAuth credentials written from env var');
    }
  }
}

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import QRCode from 'qrcode';

import { initWhatsApp, whatsappEvents, getStatus, getCurrentQr, fetchRecentMessages, sendWhatsAppMessage, stopWhatsApp, startWhatsApp, isBotEnabled, getBotPhoneNumber, getAvailableGroups, getGroupsWithDetails, getRecentMessagesFromHistory } from './whatsapp.js';
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
} from './calendar.js';
import { mightBeTask, classifyTask, enqueuePendingTask, formatFollowUp } from './taskDetector.js';
import { startScheduler, scheduleAt, getCurrentScheduledHour, getCurrentScheduledMinute,
         scheduleWeeklyDispatch, stopWeeklyDispatch, getWeeklyDispatchInfo,
         scheduleGroupReminders, stopGroupReminders } from './scheduler.js';

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

/**
 * Send an important bot event to the admin's personal WhatsApp number.
 * Fire-and-forget — never blocks the main flow.
 */
function notifyAdmin(msg) {
  const { adminPhone } = getConfig();
  if (!adminPhone) return;
  // Normalize: strip '+' and non-digits for phone numbers (groups have '@')
  const phone = adminPhone.trim();
  const now = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  sendWhatsAppMessage(phone, `🤖 [${now}] ${msg}`).catch(err => {
    console.error('[AdminNotify] Failed:', err.message);
  });
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

export async function runSync() {
  log('[Sync] Starting...');
  lastRun = new Date().toISOString();
  const config = getConfig();

  // Always send tomorrow's tasks reminder — independent of Google auth
  await sendTomorrowTasks();

  if (!isGoogleAuthenticated()) {
    const err = 'Google Calendar not configured. Set GOOGLE_SA_BASE64 env var.';
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
        if (!calId) { results.skipped.push(parsed.fingerprint); continue; }
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
  if (results.created.length > 0) {
    notifyAdmin(`📅 סנכרון יומי: נוצרו ${results.created.length} אירועים בלוח השנה${results.errors.length ? ` ⚠️ ${results.errors.length} שגיאות` : ''}`);
  } else if (results.errors.length > 0) {
    notifyAdmin(`⚠️ סנכרון יומי: ${results.errors.length} שגיאות, לא נוצרו אירועים חדשים`);
  }
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

function getTodayISO() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

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

// ─── Weekly auto-dispatch ─────────────────────────────────────────────────────

export async function autoDispatchWeeklyPlan() {
  const config = getConfig();
  if (!config.weeklyDispatchEnabled) { log('[AutoDispatch] Disabled — skipping'); return; }

  // Use preview (has fingerprints + willSend) or fall back to raw plan
  const preview = getExcelPreview();
  const plan    = getWeeklyPlan();

  let tasks = [];
  if (preview?.allTasks?.length) {
    tasks = preview.allTasks.filter(t => t.whatsappGroup && t.willSend !== false);
  } else if (plan?.tasks?.length) {
    tasks = plan.tasks.filter(t => t.whatsappGroup).map(t => ({
      ...t,
      fingerprint: `${t.whatsappGroup}|${t.taskText}|${t.dateISO}`,
    }));
  }

  if (!tasks.length) { log('[AutoDispatch] No tasks to dispatch'); return; }

  let sent = 0, skipped = 0;
  for (const task of tasks) {
    const fp = task.fingerprint;
    if (!fp || state.has(fp)) { skipped++; continue; }
    const msgText = `${task.taskText} ${task.dateLabel}`;
    const target = task.whatsappGroupId || task.whatsappGroup;
    const ok = await sendWhatsAppMessage(target, msgText);
    if (ok) { state.add(fp); sent++; }
    else log(`[AutoDispatch] ❌ failed: "${task.taskText}" → ${task.whatsappGroup}`);
  }

  log(`[AutoDispatch] ✅ Done — sent: ${sent}, skipped: ${skipped}`);
  notifyAdmin(`📤 שליחה אוטומטית הושלמה — נשלחו ${sent} משימות${skipped ? `, דולגו ${skipped}` : ''}`);
  broadcast('syncComplete', { created: [], skipped: [], errors: [], autoDispatch: true });
}

// ─── Daily tomorrow-tasks reminder per WhatsApp group ────────────────────────

async function sendTomorrowTasksToGroups() {
  const config = getConfig();
  if (!config.groupRemindersEnabled) return;

  const plan = getWeeklyPlan();
  if (!plan?.tasks?.length) return;

  const tomorrow = getTomorrowISO();
  const tasks = plan.tasks.filter(t => t.dateISO === tomorrow && t.whatsappGroup);
  if (!tasks.length) { log('[TomorrowGroups] No group tasks for tomorrow'); return; }

  // Bucket tasks by WhatsApp group — key is ID when available, else name
  const byGroup = {};
  for (const t of tasks) {
    const key = t.whatsappGroupId || t.whatsappGroup;
    (byGroup[key] = byGroup[key] || { sendKey: key, displayName: t.whatsappGroup, tasks: [] }).tasks.push(t);
  }

  const weather  = await fetchWeatherForDate(tomorrow);
  const dayName  = getHebrewDayName(tomorrow);

  let remindersSent = 0, remindersFailed = 0;
  for (const { sendKey, displayName, tasks: groupTasks } of Object.values(byGroup)) {
    let msg = `📋 משימות מחר — ${dayName} ${groupTasks[0].dateLabel}:\n\n`;
    groupTasks.forEach(t => { msg += `• ${t.taskText}\n`; });
    if (weather) {
      msg += `\n${weatherEmoji(weather.code)} ${weather.maxTemp}°/${weather.minTemp}° • גשם: ${weather.precipitation}%`;
    }
    const ok = await sendWhatsAppMessage(sendKey, msg.trim(), { pin: config.pinMessages === true });
    log(`[TomorrowGroups] Reminder ${ok ? '✅' : '❌'}${config.pinMessages ? ' 📌' : ''} → "${displayName}" (${groupTasks.length} tasks)`);
    if (ok) remindersSent++; else remindersFailed++;
  }
  const groupCount = Object.keys(byGroup).length;
  notifyAdmin(`⏰ תזכורות מחר (${dayName}) — ${remindersSent}/${groupCount} קבוצות קיבלו${remindersFailed ? ` ❌ ${remindersFailed} נכשלו` : ' ✅'}`);
}

/**
 * Sends the full tomorrow-tasks reminder for a single group.
 * Used when a task is detected AFTER the scheduled reminder already went out.
 */
async function sendTomorrowReminderForGroup(groupName) {
  const config = getConfig();
  const plan = getWeeklyPlan();
  if (!plan?.tasks?.length) return false;

  const tomorrow = getTomorrowISO();
  const tasks = plan.tasks.filter(t =>
    t.dateISO === tomorrow &&
    (t.whatsappGroup === groupName || t.whatsappGroupId === groupName)
  );
  if (!tasks.length) return false;

  const sendKey = tasks[0].whatsappGroupId || groupName;
  const dayName = getHebrewDayName(tomorrow);
  const weather = await fetchWeatherForDate(tomorrow);

  let msg = `📋 *עדכון משימות מחר — ${dayName} ${tasks[0].dateLabel}:*\n\n`;
  tasks.forEach(t => { msg += `• ${t.taskText}${t.isAIDetected ? ' ✨' : ''}\n`; });
  if (weather) {
    msg += `\n${weatherEmoji(weather.code)} ${weather.maxTemp}°/${weather.minTemp}° • גשם: ${weather.precipitation}%`;
  }

  const ok = await sendWhatsAppMessage(sendKey, msg.trim(), { pin: config.pinMessages === true });
  log(`[TaskDetection] Full reminder re-sent to "${groupName}" (${tasks.length} tasks) ${ok ? '✅' : '❌'}`);
  return ok;
}

function reminderAlreadySentToday() {
  const cfg = getConfig();
  if (!cfg.groupRemindersEnabled) return false;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const h = cfg.groupRemindersHour ?? 7;
  const m = cfg.groupRemindersMinute ?? 0;
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
}

// ─── Weekly summary ───────────────────────────────────────────────────────────

export async function sendWeeklySummary() {
  const config = getConfig();
  if (!config.summaryRecipient) { log('[WeeklySummary] No recipient configured — skipping'); return; }

  const plan = getWeeklyPlan();
  if (!plan?.tasks?.length) { log('[WeeklySummary] No weekly plan — skipping'); return; }

  const completedList = getCompletedTasks();
  const tasks = plan.tasks;
  const total     = tasks.length;
  const completed = tasks.filter(t => t.fingerprint && completedList.includes(t.fingerprint)).length;
  const sent      = tasks.filter(t => t.fingerprint && state.has(t.fingerprint)).length;
  const pending   = total - completed;

  // Per-day breakdown
  const byDate = {};
  for (const t of tasks) {
    if (!byDate[t.dateISO]) byDate[t.dateISO] = { label: t.dateLabel, total: 0, done: 0 };
    byDate[t.dateISO].total++;
    if (t.fingerprint && completedList.includes(t.fingerprint)) byDate[t.dateISO].done++;
  }

  let msg = `📊 *סיכום שבועי — ${plan.weekLabel || ''}*\n\n`;
  msg += `✅ בוצעו: ${completed}/${total}\n`;
  msg += `📤 נשלחו: ${sent}/${total}\n`;
  if (pending > 0) msg += `⏳ ממתינות: ${pending}\n`;
  msg += '\n';

  for (const date of Object.keys(byDate).sort()) {
    const { label, total: dt, done } = byDate[date];
    const icon = done === dt ? '✅' : done > 0 ? '◑' : '○';
    msg += `${icon} ${getHebrewDayName(date)} ${label}: ${done}/${dt}\n`;
  }
  msg = msg.trim();

  const recipients = config.summaryRecipient.split(/[,;]/).map(r => r.trim()).filter(Boolean);
  for (const recipient of recipients) {
    const sent = await sendWhatsAppMessage(recipient, msg);
    log(`[WeeklySummary] ${sent ? '✅' : '❌'} → ${recipient}`);
  }
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

// ─── Google Service Account — no OAuth endpoints needed ──────────────────────
// Authentication is handled via Service Account JSON set at deploy time.
// These stubs keep any old UI calls from crashing.
app.get('/auth/google/start',    (req, res) => res.json({ error: 'OAuth not used — Service Account configured' }));
app.get('/auth/google/callback', (req, res) => res.redirect('/'));
app.get('/auth/google/redirect', (req, res) => res.redirect('/'));

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
    weeklyDispatch: getWeeklyDispatchInfo(),
  });
});

// ── Bot On/Off ─────────────────────────────────────────────────────────────────
app.get('/whatsapp/groups', (req, res) => {
  // Returns detailed list [{name, id, label}] — duplicate names get a short ID suffix in label
  const detail = getGroupsWithDetails();
  res.json({ groups: detail.length ? detail : getAvailableGroups().map(n => ({ name: n, id: n, label: n })) });
});

// Admin test notification
app.post('/admin/test-notify', async (req, res) => {
  const { adminPhone } = getConfig();
  if (!adminPhone) return res.json({ ok: false, error: 'לא הוגדר מספר מנהל — שמור הגדרות קודם' });
  const ok = await sendWhatsAppMessage(adminPhone, '🤖 בדיקת חיבור — מערכת הלוגים פעילה ✅');
  res.json({ ok, error: ok ? null : 'שליחה נכשלה — ודא שהבוט מחובר ומספר הטלפון נכון' });
});

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

// Retrospective task detection — runs recent messages through the AI detection pipeline
app.post('/trigger/task-detection', async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 1, 24);
  const cfg = getConfig();
  if (!cfg.taskDetectionEnabled) return res.json({ ok: false, error: 'Task detection is disabled' });
  try {
    log(`[TaskDetection] Manual backfill: scanning last ${hours}h from message history...`);
    const messages = getRecentMessagesFromHistory(hours);
    log(`[TaskDetection] Backfill: ${messages.length} messages in history`);
    const results = [];
    for (const { body, groupName, senderPhone } of messages) {
      const trimmed = (body || '').trim();
      const admins = cfg.taskDetectionAdmins || [];
      const senderAllowed = admins.length === 0 ||
        (senderPhone && admins.some(a => a.replace(/\D/g,'') === senderPhone.replace(/\D/g,'')));
      if (!senderAllowed) { results.push({ body: trimmed.slice(0,60), groupName, senderPhone, result: 'sender_blocked' }); continue; }
      if (!mightBeTask(trimmed)) { results.push({ body: trimmed.slice(0,60), groupName, senderPhone, result: 'pre_filter_failed' }); continue; }
      const classification = await classifyTask(trimmed, groupName);
      results.push({ body: trimmed.slice(0,60), groupName, senderPhone, result: classification.isTask ? 'task_detected' : 'not_a_task', confidence: classification.confidence, description: classification.description, date: classification.date });
      if (classification.isTask && classification.confidence >= (cfg.taskDetectionMinConfidence ?? 0.75)) {
        log(`[TaskDetection] Backfill: task detected in "${groupName}": ${classification.description}`);
        // emit through normal pipeline (with 0 delay for backfill)
        whatsappEvents.emit('message', { body, groupName, senderPhone });
      }
    }
    res.json({ ok: true, hours, total: messages.length, results });
  } catch (err) {
    log(`[TaskDetection] Backfill error: ${err.message}`);
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
    // Weekly auto-dispatch
    weeklyDispatchEnabled: req.body.weeklyDispatchEnabled !== undefined ? Boolean(req.body.weeklyDispatchEnabled) : (current.weeklyDispatchEnabled ?? false),
    weeklyDispatchDay:    req.body.weeklyDispatchDay    !== undefined ? Number(req.body.weeklyDispatchDay)    : (current.weeklyDispatchDay    ?? 6),
    weeklyDispatchHour:   req.body.weeklyDispatchHour   !== undefined ? Number(req.body.weeklyDispatchHour)   : (current.weeklyDispatchHour   ?? 17),
    weeklyDispatchMinute: req.body.weeklyDispatchMinute !== undefined ? Number(req.body.weeklyDispatchMinute) : (current.weeklyDispatchMinute ?? 0),
    // Per-group daily reminders
    groupRemindersEnabled: req.body.groupRemindersEnabled !== undefined ? Boolean(req.body.groupRemindersEnabled) : (current.groupRemindersEnabled ?? false),
    groupRemindersHour:   req.body.groupRemindersHour   !== undefined ? Number(req.body.groupRemindersHour)   : (current.groupRemindersHour   ?? 7),
    groupRemindersMinute: req.body.groupRemindersMinute !== undefined ? Number(req.body.groupRemindersMinute) : (current.groupRemindersMinute ?? 0),
    pinMessages: req.body.pinMessages !== undefined ? Boolean(req.body.pinMessages) : (current.pinMessages ?? false),
    // Admin phone for bot-event notifications
    adminPhone: req.body.adminPhone !== undefined ? String(req.body.adminPhone).trim() : (current.adminPhone ?? ''),
    // UI layout & colors (sent individually from frontend)
    cardLayouts:    req.body.cardLayouts    !== undefined ? req.body.cardLayouts    : (current.cardLayouts    ?? {}),
    calendarColors: req.body.calendarColors !== undefined ? req.body.calendarColors : (current.calendarColors ?? {}),
    calendarMap:    req.body.calendarMap    !== undefined ? req.body.calendarMap    : (current.calendarMap    ?? {}),
    // AI task detection
    taskDetectionEnabled:       req.body.taskDetectionEnabled       !== undefined ? Boolean(req.body.taskDetectionEnabled)          : (current.taskDetectionEnabled       ?? false),
    taskDetectionDelay:         req.body.taskDetectionDelay         !== undefined ? Number(req.body.taskDetectionDelay)             : (current.taskDetectionDelay         ?? 5),
    taskDetectionMinConfidence: req.body.taskDetectionMinConfidence !== undefined ? Number(req.body.taskDetectionMinConfidence)      : (current.taskDetectionMinConfidence  ?? 0.75),
    taskDetectionAdmins:        Array.isArray(req.body.taskDetectionAdmins)       ? req.body.taskDetectionAdmins                    : (current.taskDetectionAdmins        ?? []),
  };
  saveConfig(updated);

  // Reschedule daily sync if time changed
  if (updated.summaryHour !== getCurrentScheduledHour() || updated.summaryMinute !== getCurrentScheduledMinute()) {
    scheduleAt(updated.summaryHour, updated.summaryMinute, runSync);
  }

  // Reschedule (or stop) weekly dispatch
  if (updated.weeklyDispatchEnabled) {
    scheduleWeeklyDispatch(updated.weeklyDispatchDay, updated.weeklyDispatchHour, updated.weeklyDispatchMinute, autoDispatchWeeklyPlan);
  } else {
    stopWeeklyDispatch();
  }

  // Reschedule (or stop) group reminders
  if (updated.groupRemindersEnabled) {
    scheduleGroupReminders(updated.groupRemindersHour, updated.groupRemindersMinute, sendTomorrowTasksToGroups);
  } else {
    stopGroupReminders();
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
      if (!calId) { results.skipped.push(fp); continue; }
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
    if (calId) await createAllDayEvent(auth, calId, task.taskText, task.dateISO);
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
whatsappEvents.on('ready', () => {
  broadcast('status', { whatsappConnected: true });
  // Delay so WhatsApp is fully ready before sending
  setTimeout(() => notifyAdmin('✅ הבוט מחובר ופועל'), 8000);
});
whatsappEvents.on('disconnected', () => broadcast('status', { whatsappConnected: false }));
whatsappEvents.on('qr', () => broadcast('status', { qrAvailable: true }));

whatsappEvents.on('message', async ({ body, groupName, senderPhone }) => {
  const trimmed = (body || '').trim();

  // ── Feature 5: Query commands ────────────────────────────────────────────────
  if (groupName) {
    const asksToday    = /מה\s*היום|משימות\s*היום|מה\s*לעשות\s*היום/i.test(trimmed);
    const asksTomorrow = /מה\s*מחר|משימות\s*מחר|מה\s*לעשות\s*מחר/i.test(trimmed);

    if (asksToday || asksTomorrow) {
      const targetDate = asksToday ? getTodayISO() : getTomorrowISO();
      const plan = getWeeklyPlan();
      const tasks = (plan?.tasks || []).filter(t =>
        t.dateISO === targetDate && (t.whatsappGroup === groupName || !t.whatsappGroup)
      );
      if (tasks.length > 0) {
        const dayName = getHebrewDayName(targetDate);
        let msg = `📋 משימות ${asksToday ? 'היום' : 'מחר'} — ${dayName} ${tasks[0].dateLabel}:\n\n`;
        tasks.forEach(t => { msg += `• ${t.taskText}\n`; });
        await sendWhatsAppMessage(groupName, msg.trim());
      } else {
        await sendWhatsAppMessage(groupName, `📋 אין משימות רשומות ${asksToday ? 'להיום' : 'למחר'}`);
      }
      return;
    }
  }

  // ── Feature 6: "בוצע" — mark today's group tasks as done ────────────────────
  if (groupName && /^בוצע[!.]*$|^✓$|^✅$/.test(trimmed)) {
    const today = getTodayISO();
    const preview = getExcelPreview();
    const plan    = getWeeklyPlan();
    const allTasks = preview?.allTasks || plan?.tasks || [];
    const todayTasks = allTasks.filter(t =>
      t.dateISO === today &&
      (t.whatsappGroup === groupName || t.excelGroup === groupName)
    );
    if (todayTasks.length > 0) {
      const list = getCompletedTasks();
      let added = 0;
      for (const task of todayTasks) {
        if (task.fingerprint && !list.includes(task.fingerprint)) {
          list.push(task.fingerprint);
          added++;
        }
      }
      saveCompletedTasks(list);
      broadcast('tasksUpdated', { completed: list }); // UI refresh
      if (added > 0) {
        await sendWhatsAppMessage(groupName, `✅ ${added} משימות סומנו כבוצעו`);
        log(`[WhatsApp] Marked ${added} tasks done for "${groupName}"`);
      }
    }
    return;
  }

  // ── AI Task Detection ────────────────────────────────────────────────────────
  {
    const cfg = getConfig();
    if (cfg.taskDetectionEnabled && groupName && trimmed.length >= 6) {
      const admins = cfg.taskDetectionAdmins || [];
      const senderAllowed = admins.length === 0 ||
        (senderPhone && admins.some(a => a.replace(/\D/g,'') === senderPhone.replace(/\D/g,'')));
      if (!senderAllowed) {
        log(`[TaskDetection] Sender ${senderPhone} not in authorized list [${admins.join(', ')}] — skipped`);
      }
      if (senderAllowed && mightBeTask(trimmed)) {
        (async () => {
          try {
            const result = await classifyTask(trimmed, groupName);
            if (result.isTask && result.confidence >= (cfg.taskDetectionMinConfidence ?? 0.75)) {
              const delayMs = (cfg.taskDetectionDelay ?? 5) * 60 * 1000;
              enqueuePendingTask(
                groupName,
                { description: result.description || trimmed, date: result.date, rawText: trimmed },
                delayMs,
                async (grp, tasks) => {
                  // 1. Add tasks to weekly plan
                  let calendarAdded = 0;
                  const plan = getWeeklyPlan() || { weekLabel: '', tasks: [] };
                  for (const task of tasks) {
                    const dateISO = task.date || getTomorrowISO();
                    const [, mm, dd] = dateISO.split('-');
                    const dateLabel = `${parseInt(dd)}.${parseInt(mm)}`;
                    const fingerprint = `${grp}|${task.description}|${dateISO}|ai`;
                    if (!plan.tasks.find(t => t.fingerprint === fingerprint)) {
                      plan.tasks.push({
                        excelGroup:   grp,
                        taskText:     task.description,
                        dateISO,
                        dateLabel,
                        whatsappGroup: grp,
                        fingerprint,
                        willSend:     false,
                        alreadySent:  true,
                        isAIDetected: true,
                      });
                    }
                    // 2. Create Google Calendar event
                    try {
                      if (isGoogleAuthenticated()) {
                        const auth = await getAuthenticatedClient();
                        const calIds = await resolveCalendarIds(auth);
                        const calId = await getOrCreateCalendar(auth, grp, calIds);
                        if (calId) {
                          await createAllDayEvent(auth, calId, task.description, dateISO);
                          calendarAdded++;
                          log(`[TaskDetection] Calendar event created: "${task.description}" on ${dateISO}`);
                        }
                      }
                    } catch (calErr) {
                      log(`[TaskDetection] Calendar error: ${calErr.message}`);
                    }
                  }
                  saveWeeklyPlan(plan);
                  broadcast('weeklyPlanUpdated', {});

                  // 3. Send WhatsApp message
                  const hasTomorrowTask = tasks.some(t => (t.date || getTomorrowISO()) === getTomorrowISO());
                  if (hasTomorrowTask && reminderAlreadySentToday()) {
                    // Reminder already went out today — re-send full updated list
                    log(`[TaskDetection] Reminder already sent today, re-sending full list to "${grp}"`);
                    await sendTomorrowReminderForGroup(grp);
                  } else {
                    // Reminder hasn't gone out yet — follow-up is enough, task will be included
                    const msg = formatFollowUp(grp, tasks, calendarAdded > 0);
                    log(`[TaskDetection] Sending follow-up to "${grp}" (${tasks.length} tasks, ${calendarAdded} to calendar)`);
                    await sendWhatsAppMessage(grp, msg);
                  }
                }
              );
            }
          } catch (err) {
            log(`[TaskDetection] Error: ${err.message}`);
          }
        })();
      }
    }
  }

  // ── Existing: Google Calendar real-time sync ─────────────────────────────────
  if (!isGoogleAuthenticated()) return;
  const events = parseMessage(body, groupName);
  if (!events) return;

  try {
    const auth = await getAuthenticatedClient();
    const calendarIds = await resolveCalendarIds(auth);
    for (const parsed of events) {
      if (state.has(parsed.fingerprint)) continue;
      const calId = await getOrCreateCalendar(auth, groupName, calendarIds);
      if (!calId) continue;
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

// Clear calendar fingerprints so events can be re-imported after manual deletion from Google Calendar
// Clears only cal: prefixed entries (calendar-only dispatches) by default,
// or specific fingerprints if provided in body.
app.delete('/state/calendar', (req, res) => {
  try {
    const { fingerprints } = req.body || {};
    if (Array.isArray(fingerprints) && fingerprints.length > 0) {
      // Remove specific fingerprints (both raw and cal: variants)
      for (const fp of fingerprints) {
        state.remove(fp);
        state.remove(`cal:${fp}`);
      }
      log(`[State] Removed ${fingerprints.length * 2} fingerprints (calendar reset)`);
    } else {
      // Remove ALL cal: prefixed fingerprints
      let count = 0;
      for (const fp of [...state.processed]) {
        if (fp.startsWith('cal:')) { state.remove(fp); count++; }
      }
      log(`[State] Cleared ${count} calendar fingerprints`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Send tomorrow's tasks for a single group (test button in group-map UI)
app.post('/excel/send-tomorrow-group', async (req, res) => {
  const { whatsappGroup, whatsappGroupId } = req.body;
  // whatsappGroupId = chat ID (e.g. "120363...@g.us")  — preferred
  // whatsappGroup   = group name or legacy fallback
  const sendTarget = whatsappGroupId || whatsappGroup;
  if (!sendTarget) return res.status(400).json({ ok: false, error: 'whatsappGroup missing' });

  const plan = getWeeklyPlan();
  const tomorrow = getTomorrowISO();

  // Match by ID first, then by name (backward compat for tasks saved before ID support)
  const tasks = (plan?.tasks || []).filter(t =>
    t.dateISO === tomorrow && (
      (whatsappGroupId && t.whatsappGroupId === whatsappGroupId) ||
      (t.whatsappGroup && t.whatsappGroup === whatsappGroup)
    )
  );

  if (!tasks.length) {
    return res.json({ ok: false, error: `אין משימות למחר עבור "${whatsappGroup || whatsappGroupId}"` });
  }

  const dayName  = getHebrewDayName(tomorrow);
  const weather  = await fetchWeatherForDate(tomorrow);
  let msg = `📋 משימות מחר — ${dayName} ${tasks[0].dateLabel}:\n\n`;
  tasks.forEach(t => { msg += `• ${t.taskText}\n`; });
  if (weather) {
    msg += `\n${weatherEmoji(weather.code)} ${weather.maxTemp}°/${weather.minTemp}° • גשם: ${weather.precipitation}%`;
  }

  // sendTarget is a chat ID (@g.us) — sendWhatsAppMessage will use it directly
  const sent = await sendWhatsAppMessage(sendTarget, msg.trim());
  log(`[TestSend] Tomorrow tasks ${sent ? '✅' : '❌'} → "${whatsappGroup}" (${tasks.length} tasks)`);
  res.json({ ok: sent, tasks: tasks.length, error: sent ? null : 'שליחה נכשלה — ודא שהבוט מחובר' });
});

// Manual trigger for weekly summary (from dashboard)
app.post('/excel/weekly-summary', async (req, res) => {
  try {
    await sendWeeklySummary();
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

  // Weekly auto-dispatch + group reminders (if enabled in config)
  const cfg = getConfig();
  if (cfg.weeklyDispatchEnabled) {
    scheduleWeeklyDispatch(cfg.weeklyDispatchDay, cfg.weeklyDispatchHour, cfg.weeklyDispatchMinute, autoDispatchWeeklyPlan);
  }
  if (cfg.groupRemindersEnabled) {
    scheduleGroupReminders(cfg.groupRemindersHour ?? 7, cfg.groupRemindersMinute ?? 0, sendTomorrowTasksToGroups);
  }

  // Weekly summary: every Friday at 20:00 Israel time
  cron.schedule('0 20 * * 5', async () => {
    log('[WeeklySummary] Friday 20:00 — sending weekly summary');
    try { await sendWeeklySummary(); } catch (e) { log('[WeeklySummary] Error: ' + e.message); }
  }, { timezone: 'Asia/Jerusalem' });
  console.log('[Scheduler] Weekly summary scheduled: Fridays 20:00 Asia/Jerusalem');
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
