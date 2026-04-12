// ═══════════════════════════════════════════════════════
//  TÍMASKRÁNING — Google Apps Script
//  Límdu þennan kóða í Apps Script editor sem er opnaður
//  í gegnum Extensions → Apps Script í Google Sheets
// ═══════════════════════════════════════════════════════

const SHEET_NAME = "Punches";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action; // "clockIn", "clockOut", "manualClockOut"

    if (action === "clockIn")       return handleClockIn(data);
    if (action === "clockOut")      return handleClockOut(data);
    if (action === "manualClockOut") return handleManualClockOut(data);
    if (action === "checkStatus")   return handleCheckStatus(data);

    return jsonResponse({ success: false, error: "Unknown action" });
  } catch(err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function doGet(e) {
  const action = e.parameter.action || "getRecent";
  if (action === "checkStatus") {
    return handleCheckStatus({ employeeId: e.parameter.employeeId });
  }
  return handleGetRecent();
}

// ── CLOCK IN ──────────────────────────────────────────
function handleClockIn(data) {
  const sheet = getSheet();
  const { employeeId, date, time } = data;

  // Check if already has open punch today
  const existing = findRow(sheet, employeeId, date);
  if (existing) {
    return jsonResponse({ success: false, error: "Already clocked in today" });
  }

  // Add new row: ID, Date, ClockIn, ClockOut(empty), Hours, Minutes, TotalDecimal, Note
  sheet.appendRow([employeeId, date, time, "", "", "", "", ""]);

  return jsonResponse({ success: true, action: "clockIn" });
}

// ── CLOCK OUT ─────────────────────────────────────────
function handleClockOut(data) {
  const sheet = getSheet();
  const { employeeId, date, time } = data;

  const rowIndex = findRow(sheet, employeeId, date);
  if (!rowIndex) {
    return jsonResponse({ success: false, error: "No clock-in found for today" });
  }

  const row = sheet.getRange(rowIndex, 1, 1, 8).getValues()[0];
  const clockInTime = row[2]; // column C

  const diff = calcDiff(clockInTime, time);

  sheet.getRange(rowIndex, 4).setValue(time);           // Clock Out
  sheet.getRange(rowIndex, 5).setValue(diff.hours);     // Hours
  sheet.getRange(rowIndex, 6).setValue(diff.minutes);   // Minutes
  sheet.getRange(rowIndex, 7).setValue(diff.decimal);   // Total decimal (for DK)
  sheet.getRange(rowIndex, 8).setValue(diff.display);   // Display string e.g. "8t 30m"

  return jsonResponse({ success: true, action: "clockOut", duration: diff.display, decimal: diff.decimal });
}

// ── MANUAL CLOCK OUT (missed yesterday) ───────────────
function handleManualClockOut(data) {
  const sheet = getSheet();
  const { employeeId, date, time, note } = data;

  const rowIndex = findRow(sheet, employeeId, date);
  if (!rowIndex) {
    return jsonResponse({ success: false, error: "No clock-in found for that date" });
  }

  const row = sheet.getRange(rowIndex, 1, 1, 8).getValues()[0];
  const clockInTime = row[2];

  const diff = calcDiff(clockInTime, time);

  sheet.getRange(rowIndex, 4).setValue(time);
  sheet.getRange(rowIndex, 5).setValue(diff.hours);
  sheet.getRange(rowIndex, 6).setValue(diff.minutes);
  sheet.getRange(rowIndex, 7).setValue(diff.decimal);
  sheet.getRange(rowIndex, 8).setValue(diff.display);
  if (note) sheet.getRange(rowIndex, 9).setValue(note); // Note column

  return jsonResponse({ success: true, action: "manualClockOut", duration: diff.display });
}

// ── CHECK STATUS ──────────────────────────────────────
// Returns: isClockedIn, lastOpenDate, lastOpenClockIn
function handleCheckStatus(data) {
  const sheet = getSheet();
  const { employeeId } = data;
  const today = formatDate(new Date());

  // Find any open punch (no clock-out) — scan all rows for this employee
  const allRows = sheet.getDataRange().getValues();
  let openRow = null;

  for (let i = allRows.length - 1; i >= 1; i--) {
    const row = allRows[i];
    if (String(row[0]) === String(employeeId)) {
      if (!row[3]) { // Clock Out is empty
        openRow = { date: formatDateValue(row[1]), clockIn: row[2], rowIndex: i + 1 };
        break;
      } else {
        // Last punch is complete — employee is clocked out
        break;
      }
    }
  }

  if (!openRow) {
    return jsonResponse({ success: true, status: "out" });
  }

  if (openRow.date === today) {
    return jsonResponse({ success: true, status: "in", date: openRow.date, clockIn: openRow.clockIn });
  } else {
    return jsonResponse({ success: true, status: "missedOut", date: openRow.date, clockIn: openRow.clockIn });
  }
}

// ── GET RECENT (for log view) ─────────────────────────
function handleGetRecent() {
  const sheet = getSheet();
  const allRows = sheet.getDataRange().getValues();
  const headers = allRows[0];
  const recent = allRows.slice(1).slice(-50).reverse().map(row => ({
    employeeId: row[0],
    date: formatDateValue(row[1]),
    clockIn: row[2],
    clockOut: row[3],
    duration: row[7]
  }));
  return jsonResponse({ success: true, records: recent });
}

// ── HELPERS ───────────────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["Employee ID", "Date", "Clock In", "Clock Out", "Hours", "Minutes", "Total (decimal)", "Duration", "Note"]);
    sheet.setFrozenRows(1);
    // Format columns
    sheet.getRange("B:B").setNumberFormat("yyyy-mm-dd");
    sheet.getRange("C:D").setNumberFormat("HH:mm");
    sheet.getRange("G:G").setNumberFormat("0.00");
  }
  return sheet;
}

// Find row index for employee+date with no clock-out (or any row for that date)
function findRow(sheet, employeeId, date) {
  const allRows = sheet.getDataRange().getValues();
  for (let i = allRows.length - 1; i >= 1; i--) {
    const row = allRows[i];
    const rowDate = formatDateValue(row[1]);
    if (String(row[0]) === String(employeeId) && rowDate === date && !row[3]) {
      return i + 1; // 1-indexed
    }
  }
  return null;
}

function calcDiff(inTime, outTime) {
  // inTime and outTime are "HH:MM" strings
  const [inH, inM] = inTime.split(":").map(Number);
  const [outH, outM] = outTime.split(":").map(Number);
  let totalMin = (outH * 60 + outM) - (inH * 60 + inM);
  if (totalMin < 0) totalMin += 1440; // crosses midnight
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const decimal = Math.round((totalMin / 60) * 100) / 100;
  const display = hours + "t " + String(minutes).padStart(2,"0") + "m";
  return { hours, minutes, decimal, display };
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function formatDateValue(val) {
  if (!val) return "";
  if (typeof val === "string") return val.slice(0, 10);
  if (val instanceof Date) return formatDate(val);
  return String(val).slice(0, 10);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
