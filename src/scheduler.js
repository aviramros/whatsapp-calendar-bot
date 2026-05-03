import cron from 'node-cron';
import { getConfig } from './config.js';

// ── Daily sync scheduler ───────────────────────────────────────────────────────
let currentTask = null;
let currentHour = null;
let currentMinute = null;

export function startScheduler(callback) {
  const { summaryHour, summaryMinute } = getConfig();
  scheduleAt(summaryHour, summaryMinute ?? 0, callback);
}

export function scheduleAt(hour, minute, callback) {
  if (currentTask) { currentTask.stop(); currentTask = null; }
  const h = Number(hour);
  const m = Number(minute ?? 0);
  currentHour = h;
  currentMinute = m;

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');

  currentTask = cron.schedule(`${m} ${h} * * *`, async () => {
    console.log(`[Scheduler] ${hh}:${mm} trigger fired — starting sync`);
    try { await callback(); } catch (err) { console.error('[Scheduler] Error during sync:', err.message); }
  }, { timezone: 'Asia/Jerusalem' });

  console.log(`[Scheduler] Daily sync scheduled at ${hh}:${mm} Asia/Jerusalem`);
}

export function getCurrentScheduledHour()   { return currentHour;   }
export function getCurrentScheduledMinute() { return currentMinute; }

// ── Weekly dispatch scheduler ─────────────────────────────────────────────────
const HE_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

let weeklyTask = null;
let weeklyDay = null;
let weeklyHour = null;
let weeklyMinute = null;

export function scheduleWeeklyDispatch(day, hour, minute, callback) {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  const d = Number(day  ?? 6);
  const h = Number(hour ?? 17);
  const m = Number(minute ?? 0);
  weeklyDay    = d;
  weeklyHour   = h;
  weeklyMinute = m;

  weeklyTask = cron.schedule(`${m} ${h} * * ${d}`, async () => {
    console.log(`[Scheduler] Weekly dispatch trigger fired`);
    try { await callback(); } catch (e) { console.error('[Scheduler] Weekly dispatch error:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });

  const dayName = HE_DAYS[d] || d;
  console.log(`[Scheduler] Weekly dispatch scheduled: ${dayName} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} Asia/Jerusalem`);
}

export function stopWeeklyDispatch() {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  weeklyDay = weeklyHour = weeklyMinute = null;
}

export function getWeeklyDispatchInfo() {
  if (weeklyDay === null) return null;
  return { day: weeklyDay, hour: weeklyHour, minute: weeklyMinute, dayName: HE_DAYS[weeklyDay] || weeklyDay };
}

// ── Group reminders scheduler ──────────────────────────────────────────────────
let groupRemindersTask = null;

export function scheduleGroupReminders(hour, minute, callback) {
  if (groupRemindersTask) { groupRemindersTask.stop(); groupRemindersTask = null; }
  const h = Number(hour ?? 7);
  const m = Number(minute ?? 0);
  groupRemindersTask = cron.schedule(`${m} ${h} * * *`, async () => {
    console.log(`[Scheduler] Group reminders trigger fired at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    try { await callback(); } catch (e) { console.error('[Scheduler] Group reminders error:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });
  console.log(`[Scheduler] Group reminders scheduled at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} Asia/Jerusalem`);
}

export function stopGroupReminders() {
  if (groupRemindersTask) { groupRemindersTask.stop(); groupRemindersTask = null; }
}

// ── Manager approval pre-send scheduler ───────────────────────────────────────
let managerApprovalTask = null;

/**
 * Schedules the manager-approval pre-send job to fire `leadMinutes` before
 * the group-reminders time (reminderHour:reminderMinute).
 */
export function scheduleManagerApprovalPreSend(reminderHour, reminderMinute, leadMinutes, callback) {
  if (managerApprovalTask) { managerApprovalTask.stop(); managerApprovalTask = null; }
  const totalMin = reminderHour * 60 + reminderMinute - Number(leadMinutes);
  // Wrap negative times (e.g. reminder at 00:30, lead 60 → 23:30 prev day)
  const wrapped = ((totalMin % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  managerApprovalTask = cron.schedule(`${m} ${h} * * *`, async () => {
    console.log(`[Scheduler] Manager approval pre-send firing at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    try { await callback(); } catch (e) { console.error('[Scheduler] Manager approval error:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });
  console.log(`[Scheduler] Manager approval pre-send at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} Asia/Jerusalem (${leadMinutes}min before reminders)`);
}

export function stopManagerApprovalPreSend() {
  if (managerApprovalTask) { managerApprovalTask.stop(); managerApprovalTask = null; }
}

// ── Today reminders scheduler ──────────────────────────────────────────────────
let todayRemindersTask = null;

export function scheduleTodayReminders(hour, minute, callback) {
  if (todayRemindersTask) { todayRemindersTask.stop(); todayRemindersTask = null; }
  const h = Number(hour ?? 7);
  const m = Number(minute ?? 0);
  todayRemindersTask = cron.schedule(`${m} ${h} * * *`, async () => {
    console.log(`[Scheduler] Today reminders trigger fired at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    try { await callback(); } catch (e) { console.error('[Scheduler] Today reminders error:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });
  console.log(`[Scheduler] Today reminders scheduled at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} Asia/Jerusalem`);
}

export function stopTodayReminders() {
  if (todayRemindersTask) { todayRemindersTask.stop(); todayRemindersTask = null; }
}
