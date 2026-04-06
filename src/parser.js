// Step 1: message must end with a date or date range
//   Single: 22/3  22.3  22/3/25
//   Range:  22/3-25/3  22-25/3  22.3-25.3
const DATE_SUFFIX = /\s+(\d{1,2}[\/\.]?\d{0,2}[\/\.]\d{1,2}(?:[\/\.]\d{2,4})?(?:\s*[-–]\s*\d{1,2}[\/\.]\d{1,2}(?:[\/\.]\d{2,4})?)?)$/;

// Step 2: strip optional "יום <word>" from the end of the prefix
const DAY_PART = /\s+יום\s+\S+$/;

/**
 * Parses a raw message string into one or more structured event objects (for date ranges).
 * @param {string} text
 * @param {string} groupName
 * @returns {Array<{ title, date, calendarName, fingerprint }> | null}
 */
export function parseMessage(text, groupName) {
  const trimmed = text.trim();

  const dateMatch = trimmed.match(DATE_SUFFIX);
  if (!dateMatch) return null;

  // Everything before the date
  let title = trimmed.slice(0, trimmed.length - dateMatch[0].length);
  title = title.replace(DAY_PART, '').trim();
  if (!title) return null;

  const dates = parseDateOrRange(dateMatch[1].trim());
  if (!dates || dates.length === 0) return null;

  return dates.map(date => ({
    title,
    date,
    calendarName: groupName,
    fingerprint: `${groupName}|${title}|${date}`,
  }));
}

/**
 * Parses a date string (single or range) into an array of ISO date strings.
 * Supports: "22/3", "22.3", "22/3-25/3", "22-25/3", "22/3/25"
 */
function parseDateOrRange(str) {
  // Check for range (separator is - or –)
  const rangeSep = str.match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (rangeSep) {
    const start = parseSingleDate(rangeSep[1].trim());
    let end = parseSingleDate(rangeSep[2].trim());

    // Handle shorthand like "22-25/3" where end has the month but start doesn't
    if (!end && rangeSep[2].match(/^\d{1,2}$/)) {
      // end is just a day number, borrow month from start string
      const monthMatch = str.match(/[\/\.](\d{1,2})(?:[\/\.]|$)/);
      if (monthMatch) {
        end = parseSingleDate(`${rangeSep[2].trim()}/${monthMatch[1]}`);
      }
    }

    if (!start || !end) return null;
    return dateRange(start, end);
  }

  const single = parseSingleDate(str);
  return single ? [single] : null;
}

function parseSingleDate(str) {
  const parts = str.split(/[\/\.]/);
  if (parts.length < 2) return null;

  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  let year = parts[2] ? parseInt(parts[2], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;

  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const candidate = new Date(year, month - 1, day);
  if (candidate.getMonth() !== month - 1) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);
  if (candidate < thirtyDaysAgo) candidate.setFullYear(candidate.getFullYear() + 1);

  return toISO(candidate);
}

function dateRange(startISO, endISO) {
  const dates = [];
  const cur = new Date(startISO);
  const end = new Date(endISO);
  // Safety: max 31 days in a range
  while (cur <= end && dates.length <= 31) {
    dates.push(toISO(new Date(cur)));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function toISO(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
