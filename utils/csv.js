// utils/csv.js

/**
 * Escape a single CSV cell per RFC 4180.
 * Wraps in quotes and doubles internal quotes if needed.
 */
function escapeCSVCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from headers + rows.
 */
function buildCSV(headers, rows) {
  const headerLine = headers.map(escapeCSVCell).join(",");
  const bodyLines = rows.map((row) => row.map(escapeCSVCell).join(","));
  return [headerLine, ...bodyLines].join("\r\n");
}

module.exports = { escapeCSVCell, buildCSV };