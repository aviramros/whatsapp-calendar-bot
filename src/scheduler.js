import cron from 'node-cron';
import { getConfig } from './config.js';

let currentTask = null;
let currentHour = null;
let currentMinute = null;

export function startScheduler(callback) {
  const { summaryHour, summaryMinute } = getConfig();
  scheduleAt(summaryHour, summaryMinute ?? 0, callback);
}

export function scheduleAt(hour, minute, callback) {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
  const h = Number(hour);
  const m = Number(minute ?? 0);
  currentHour = h;
  currentMinute = m;

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');

  currentTask = cron.schedule(`${m} ${h} * * *`, async () => {
    console.log(`[Scheduler] ${hh}:${mm} trigger fired — starting sync`);
    try {
      await callback();
    } catch (err) {
      console.error('[Scheduler] Error during sync:', err.message);
    }
  }, { timezone: 'Asia/Jerusalem' });

  console.log(`[Scheduler] Daily sync scheduled at ${hh}:${mm} Asia/Jerusalem`);
}

export function getCurrentScheduledHour() { return currentHour; }
export function getCurrentScheduledMinute() { return currentMinute; }
