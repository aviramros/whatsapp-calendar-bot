import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { EventEmitter } from 'events';
import { unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { getConfig } from './config.js';
import 'dotenv/config';

export const whatsappEvents = new EventEmitter();

let client = null;
let isReady = false;
let currentQr = null;
let botEnabled = true; // controlled by UI on/off toggle
let groupIdCache = {}; // { groupName: chatId._serialized }

export function isBotEnabled() { return botEnabled; }

function log(msg) {
  const line = `[WhatsApp] ${msg}`;
  console.log(line);
  whatsappEvents.emit('log', line);
}

export function getStatus() {
  return { connected: isReady, qrAvailable: !isReady && currentQr !== null };
}

export function getCurrentQr() {
  return currentQr;
}

export function getClient() {
  return client;
}

export function initWhatsApp() {
  // Remove ALL stale Chromium lock files recursively (handles any session-* subdir)
  const authPath = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';
  try {
    execSync(`find "${authPath}" \\( -name "SingletonLock" -o -name "SingletonCookie" -o -name "SingletonSocket" \\) -delete 2>/dev/null || true`, { stdio: 'ignore' });
  } catch (_) {}

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth' }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
        || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-accelerated-2d-canvas',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-default-apps',
        '--mute-audio',
        '--renderer-process-limit=1',
        '--js-flags=--max_old_space_size=256',
      ],
    },
  });

  client.on('qr', (qr) => {
    currentQr = qr;
    log('QR code ready — open http://localhost:' + (process.env.PORT || 3000) + ' to scan');
    whatsappEvents.emit('qr', qr);
  });

  client.on('ready', () => {
    isReady = true;
    currentQr = null;
    log('Connected and ready');
    whatsappEvents.emit('ready');
    // Build group ID cache in background (one-time getChats)
    buildGroupCache();
  });

  client.on('authenticated', () => log('Authenticated'));

  client.on('auth_failure', (msg) => {
    isReady = false;
    log('Auth failure: ' + msg);
    whatsappEvents.emit('error', 'Auth failure: ' + msg);
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    whatsappEvents.emit('disconnected');
    if (botEnabled) {
      log('Disconnected: ' + reason + '. Reconnecting in 10s...');
      setTimeout(() => {
        if (botEnabled) client.initialize().catch(err => log('Reconnect failed: ' + err.message));
      }, 10000);
    } else {
      log('Disconnected: ' + reason + ' (bot is off — not reconnecting)');
    }
  });

  client.on('message', async (message) => {
    try {
      const chat = await message.getChat();
      if (!chat.isGroup) return;
      const groupName = chat.name.trim();
      const { groups } = getConfig();
      if (!groups.includes(groupName)) return;
      whatsappEvents.emit('message', { body: message.body, groupName, timestamp: message.timestamp });
    } catch (err) {
      log('Error handling message: ' + err.message);
    }
  });

  client.initialize().catch(err => {
    log('Init failed: ' + err.message);
    if (botEnabled) {
      log('Retrying in 15s...');
      setTimeout(() => { if (botEnabled) initWhatsApp(); }, 15000);
    }
  });
  log('Initializing...');
}

export async function stopWhatsApp() {
  botEnabled = false;
  isReady = false;
  currentQr = null;
  if (client) {
    try { await client.destroy(); } catch {}
  }
  log('Bot stopped by user');
  whatsappEvents.emit('disconnected');
}

export function startWhatsApp() {
  botEnabled = true;
  if (client) {
    try { client.destroy().catch(() => {}); } catch {}
    client = null;
  }
  isReady = false;
  currentQr = null;
  initWhatsApp();
  log('Bot started by user');
}

/**
 * Build a cache of { groupName → chatId } using getChats() once on startup.
 */
async function buildGroupCache() {
  try {
    log('Building group cache (one-time)...');
    const chats = await Promise.race([
      client.getChats(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 120000))
    ]);
    groupIdCache = {};
    for (const chat of chats) {
      if (chat.isGroup) groupIdCache[chat.name.trim()] = chat.id._serialized;
    }
    log(`Group cache ready: ${Object.keys(groupIdCache).length} groups indexed`);
  } catch (err) {
    log('Group cache build failed: ' + err.message + ' — will retry on next sync');
  }
}

/**
 * Fetches messages from the last `hours` hours from all configured target groups.
 */
export async function fetchRecentMessages(hours) {
  if (!isReady || !client) {
    log('Cannot fetch messages — not connected');
    return [];
  }

  const { groups } = getConfig();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const results = [];

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms/1000}s`)), ms))
    ]);

  // If cache is empty, rebuild it first
  if (Object.keys(groupIdCache).length === 0) {
    log('Cache empty — rebuilding...');
    await buildGroupCache();
  }

  const found = groups.filter(g => groupIdCache[g]);
  log(`Found ${found.length}/${groups.length} target groups in cache`);

  for (const groupName of found) {
    const chatId = groupIdCache[groupName];
    log(`Fetching messages from "${groupName}"...`);
    try {
      const chat = await withTimeout(client.getChatById(chatId), 15000, `getChatById(${groupName})`);
      const messages = await withTimeout(chat.fetchMessages({ limit: 20 }), 30000, `fetchMessages(${groupName})`);
      const recent = messages.filter(m => m.timestamp * 1000 >= cutoff);
      log(`Group "${groupName}": fetched ${messages.length} messages, ${recent.length} within ${hours}h`);
      for (const msg of recent) {
        results.push({ body: msg.body, groupName, timestamp: msg.timestamp });
      }
    } catch (err) {
      log(`Group "${groupName}" skipped: ${err.message}`);
      // If chat not found, invalidate cache entry so it rebuilds next time
      if (err.message.includes('not found') || err.message.includes('timed out')) {
        delete groupIdCache[groupName];
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

/**
 * Sends a WhatsApp message to a phone number or group name.
 * @param {string} recipient - phone number (e.g. "972501234567") or exact group name
 * @param {string} text
 */
export async function sendWhatsAppMessage(recipient, text) {
  if (!isReady || !client) {
    log('Cannot send message — not connected');
    return false;
  }
  try {
    // Try as group name using cache first
    const cachedId = groupIdCache[recipient.trim()];
    if (cachedId) {
      await client.sendMessage(cachedId, text);
      return true;
    }
    // Otherwise treat as phone number
    const numberId = await client.getNumberId(recipient.replace(/^\+/, ''));
    if (!numberId) { log(`Recipient not found: ${recipient}`); return false; }
    await client.sendMessage(numberId._serialized, text);
    return true;
  } catch (err) {
    log('Error sending message: ' + err.message);
    return false;
  }
}
