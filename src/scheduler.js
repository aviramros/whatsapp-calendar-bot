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
