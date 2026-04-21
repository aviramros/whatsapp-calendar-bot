import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const CONFIG_PATH = './data/config.json';
const GROUP_MAP_PATH = './data/excel-group-map.json';
const WEEKLY_PLAN_PATH = './data/weekly-plan.json';
const COMPLETED_TASKS_PATH = './data/completed-tasks.json';
const EXCEL_PREVIEW_PATH   = './data/excel-preview.json';

const DEFAULTS = {
  groups: ['השקיה', 'עבודות בית', 'ריסוסים'],
  syncWindowHours: 24,
  summaryRecipient: '',
  summaryHour: 7,
  summaryMinute: 0,
  themeColor: '#3DBDB4',
  logoData: null,
  logoOrientation: 'landscape',
  latitude: 32.0853,   // default: Tel Aviv area
  longitude: 34.7818,
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

export function getWeeklyPlan() {
  if (!existsSync(WEEKLY_PLAN_PATH)) return null;
  try { return JSON.parse(readFileSync(WEEKLY_PLAN_PATH, 'utf8')); }
  catch { return null; }
}

export function saveWeeklyPlan(plan) {
  mkdirSync(dirname(WEEKLY_PLAN_PATH), { recursive: true });
  writeFileSync(WEEKLY_PLAN_PATH, JSON.stringify(plan, null, 2));
}

export function getCompletedTasks() {
  if (!existsSync(COMPLETED_TASKS_PATH)) return [];
  try { return JSON.parse(readFileSync(COMPLETED_TASKS_PATH, 'utf8')); }
  catch { return []; }
}

export function saveCompletedTasks(arr) {
  mkdirSync(dirname(COMPLETED_TASKS_PATH), { recursive: true });
  writeFileSync(COMPLETED_TASKS_PATH, JSON.stringify(arr, null, 2));
}

export function getExcelPreview() {
  if (!existsSync(EXCEL_PREVIEW_PATH)) return null;
  try { return JSON.parse(readFileSync(EXCEL_PREVIEW_PATH, 'utf8')); }
  catch { return null; }
}

export function saveExcelPreview(data) {
  mkdirSync(dirname(EXCEL_PREVIEW_PATH), { recursive: true });
  writeFileSync(EXCEL_PREVIEW_PATH, JSON.stringify(data, null, 2));
}
