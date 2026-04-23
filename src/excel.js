import XLSX from 'xlsx';

/**
 * Extracts an ISO date string from a Hebrew column header.
 * Handles formats like "יום א 15.3", "יום ד' 18.3", "יום שישי 20.3", "שבת 21.3"
 */
function extractDateFromHeader(headerText) {
  if (!headerText) return null;
  const match = String(headerText).match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  let year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // If date is more than 60 days in the past, assume next year
  const d = new Date(year, month - 1, day);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (d < now && (now - d) > 60 * 24 * 60 * 60 * 1000) {
    d.setFullYear(d.getFullYear() + 1);
    year = d.getFullYear();
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extracts a short date label (e.g. "15.3") from a header for use in WhatsApp messages.
 */
function extractDateLabel(headerText) {
  if (!headerText) return null;
  const match = String(headerText).match(/(\d{1,2})[./](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}.${match[2]}`;
}

/**
 * Parses an xlsx Buffer into a structured weekly plan.
 *
 * @param {Buffer} buffer - Raw xlsx file bytes
 * @returns {{
 *   weekLabel: string,
 *   columns: Array<{col: number, dateLabel: string, dateISO: string}>,
 *   tasks: Array<{excelGroup: string, taskText: string, dateISO: string, dateLabel: string}>
 * }}
 */
export function parseExcelPlan(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Find header row: the row where column A === 'פעילות'
  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cellA = String(rows[i][0] || '').trim();
    if (cellA === 'פעילות') { headerRowIdx = i; break; }
  }
  if (headerRowIdx === -1) throw new Error('לא נמצאה שורת כותרת עם "פעילות" בעמודה A');

  const headerRow = rows[headerRowIdx];

  // Parse day columns (B onwards = index 1+)
  const columns = [];
  for (let col = 1; col < headerRow.length; col++) {
    const text = String(headerRow[col] || '').trim();
    if (!text) continue;
    const dateISO = extractDateFromHeader(text);
    const dateLabel = extractDateLabel(text);
    if (dateISO && dateLabel) {
      columns.push({ col, dateLabel, dateISO });
    }
  }

  if (columns.length === 0) throw new Error('לא נמצאו עמודות תאריך בשורת הכותרת');

  // Build week label from first and last date
  const weekLabel = `${columns[0].dateLabel} - ${columns[columns.length - 1].dateLabel}`;

  // Scan rows below header, tracking current group via column A.
  // Continuation detection: if column A is empty and the same day-column had content
  // in the IMMEDIATELY preceding row, the cell is a continuation of that task (not a new task).
  const tasks = [];
  let currentGroup = null;
  const lastTaskByCol = {}; // col-index → last task object (for continuation merging)

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const cellA = String(row[0] || '').trim();
    const isGroupChange = cellA !== '';
    if (cellA) currentGroup = cellA;
    if (!currentGroup) continue;

    // A group change means we can no longer continue any previous task
    if (isGroupChange) {
      Object.keys(lastTaskByCol).forEach(k => delete lastTaskByCol[k]);
    }

    const activeColsThisRow = new Set();

    for (const { col, dateISO, dateLabel } of columns) {
      const cellText = String(row[col] || '').trim();
      if (!cellText) continue;

      activeColsThisRow.add(col);

      if (!isGroupChange && lastTaskByCol[col]) {
        // This cell continues the task started in the previous row for the same day-column
        lastTaskByCol[col].taskText += '\n' + cellText;
      } else {
        // New task
        const task = { excelGroup: currentGroup, taskText: cellText, dateISO, dateLabel };
        tasks.push(task);
        lastTaskByCol[col] = task;
      }
    }

    // Columns absent from this row cannot be continued on the next row
    for (const col of Object.keys(lastTaskByCol)) {
      if (!activeColsThisRow.has(Number(col))) {
        delete lastTaskByCol[Number(col)];
      }
    }
  }

  return { weekLabel, columns, tasks };
}
