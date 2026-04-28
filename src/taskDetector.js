import Anthropic from '@anthropic-ai/sdk';
import { whatsappEvents } from './whatsapp.js';

// ── Lazy Anthropic client ────────────────────────────────────────────────────
let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function log(msg) {
  const line = `[TaskDetector] ${msg}`;
  console.log(line);
  whatsappEvents.emit('log', line);
}

// ── Pre-filter (cheap, no API call) ─────────────────────────────────────────
const TIME_WORDS = [
  'מחר', 'היום', 'יום א', 'יום ב', 'יום ג', 'יום ד', 'יום ה', 'יום ו', 'יום ש',
  'שבוע הבא', 'בוקר', 'צהריים', 'ערב', 'לילה',
  'ריסוס', 'ריסס', 'להשקות', 'השקיה', 'להשקיה',
  'דישון', 'לדשן', 'קטיף', 'לקטוף', 'גיזום', 'לגזום',
  'תוספת', 'הוסיפו', 'להוסיף', 'נוסף', 'עבודה', 'לעבוד',
];

export function mightBeTask(text) {
  if (!text || text.trim().length < 6) return false;
  const matched = TIME_WORDS.find(w => text.includes(w));
  if (!matched) log(`Pre-filter: no trigger word found in "${text.slice(0,60)}"`);
  return !!matched;
}

// ── Claude classification ────────────────────────────────────────────────────
export async function classifyTask(text, groupName) {
  const today = new Date().toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const prompt = `אתה מסווג הודעות WhatsApp מקבוצות ניהול עבודה חקלאית בישראל.
היום: ${today}
קבוצה: "${groupName}"
הודעה: "${text}"

האם ההודעה מתארת משימה/עבודה לביצוע בשדה? (ריסוס, השקיה, דישון, קטיף, גיזום, עבודה כלשהי וכד')

חוקי תאריך — החזר date=null אם:
- התאריך לא ודאי ("יום ג׳ או ד'", "אולי מחר", "בערך", "תלוי מזג אוויר")
- לא מוזכר תאריך כלל
- יש ספק כלשהו לגבי מתי בדיוק

ענה ב-JSON בלבד, ללא טקסט נוסף:
{"isTask":boolean,"confidence":number,"date":"YYYY-MM-DD או null","description":"תיאור קצר בעברית או null"}`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content[0].text.trim();
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    log(`"${text.slice(0,40)}..." → isTask=${json.isTask}, confidence=${json.confidence}, date=${json.date}`);
    return json;
  } catch (err) {
    log(`Classification error: ${err.message}`);
    return { isTask: false, confidence: 0, date: null, description: null };
  }
}

// ── Pending queue (debounce per group) ───────────────────────────────────────
// { groupName → { timer, tasks: [{description, date, rawText}] } }
const _pending = new Map();

export function enqueuePendingTask(groupName, taskInfo, delayMs, onFlush) {
  let entry = _pending.get(groupName);
  if (!entry) {
    entry = { timer: null, tasks: [] };
    _pending.set(groupName, entry);
  }
  entry.tasks.push(taskInfo);

  // Start timer only on first task in window
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      const e = _pending.get(groupName);
      _pending.delete(groupName);
      if (e?.tasks.length) onFlush(groupName, e.tasks);
    }, delayMs);
    log(`Queued task for "${groupName}", flush in ${delayMs / 60000} min`);
  } else {
    log(`Added task to existing queue for "${groupName}" (${entry.tasks.length} total)`);
  }
}

// ── Format follow-up message ─────────────────────────────────────────────────
export function formatFollowUp(groupName, tasks, addedToCalendar = false) {
  const header = `📋 *עדכון משימות — ${groupName}*\n`;
  const divider = '─'.repeat(20) + '\n';

  const lines = tasks.map(t => {
    const datePart = t.date ? ` — ${formatDate(t.date)}` : '';
    return `• ${t.description}${datePart}`;
  }).join('\n');

  const taskWord = tasks.length === 1 ? 'משימה חדשה זוהתה' : `${tasks.length} משימות חדשות זוהו`;
  const calNote  = addedToCalendar ? '\n📅 נוסף ליומן Google' : '';

  return `${header}${divider}${taskWord}:\n${lines}${calNote}`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
  } catch { return iso; }
}

// ── Uncertain-task replacement helper ────────────────────────────────────────
/**
 * Returns true if newText is a refinement/completion of an uncertain oldText.
 * Only matches when oldText contains '??'.
 * Strips '??', normalises both sides, then checks:
 *  1. cleaned-old is a substring of new, OR
 *  2. word-overlap ratio ≥ 0.6
 */
export function isRefinementOf(oldText, newText) {
  if (!oldText.includes('??')) return false;
  const norm = s => s
    .replace(/\?\?+/g, '')
    .replace(/[^\u05D0-\u05EA\u05F0-\u05F4a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const o = norm(oldText);
  const n = norm(newText);
  if (!o) return false;
  if (n.includes(o)) return true;
  const ow = o.split(' ').filter(Boolean);
  const nw = n.split(' ').filter(Boolean);
  return ow.filter(w => nw.includes(w)).length / ow.length >= 0.6;
}
