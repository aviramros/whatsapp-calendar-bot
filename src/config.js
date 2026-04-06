import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const CONFIG_PATH = './data/config.json';
const GROUP_MAP_PATH = './data/excel-group-map.json';

const DEFAULTS = {
  groups: ['השקיה', 'עבודות בית', 'ריסוסים'],
  syncWindowHours: 24,
  summaryRecipient: '',
  summaryHour: 7,
  summaryMinute: 0,
  themeColor: '#3DBDB4',
  logoData: null,
  logoOrientation: 'landscape',
};

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getGroupMap() {
  if (!existsSync(GROUP_MAP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(GROUP_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveGroupMap(map) {
  mkdirSync(dirname(GROUP_MAP_PATH), { recursive: true });
  writeFileSync(GROUP_MAP_PATH, JSON.stringify(map, null, 2));
}
