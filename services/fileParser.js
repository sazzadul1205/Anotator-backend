const XLSX = require("xlsx");

/**
 * Parse an Excel/CSV file and extract comment texts.
 */
const parseFileForComments = (filePath) => {
  const workbook = XLSX.readFile(filePath);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(firstSheet);

  if (data.length === 0) {
    throw new Error("File is empty");
  }

  const headers = Object.keys(data[0]);
  const commentColumn = headers.find(
    (h) =>
      h.toLowerCase().includes("comment") ||
      h.toLowerCase().includes("text") ||
      h.toLowerCase() === "comment_text"
  );

  if (!commentColumn) {
    throw new Error(
      "No comment column found. Expected column with 'comment' or 'text' in name"
    );
  }

  const comments = data
    .map((row, index) => ({
      externalId: row.id || row.externalId || `row_${index + 1}`,
      text: String(row[commentColumn] || "").trim(),
    }))
    .filter((c) => c.text.length > 0);

  if (comments.length === 0) {
    throw new Error("No valid comments found in the file");
  }

  return comments;
};

module.exports = { parseFileForComments };