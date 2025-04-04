// function extractWeeklyTaskCounts() {
//   const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("QA Status Report");
//   const data = sheet.getDataRange().getValues();

//   const output = [];
//   let currentEmail = '';
//   let insideWeekly = false;
//   let headers = [];
//   let colIndexes = {};

//   data.forEach((row, i) => {
//     const firstCell = row[0]?.toString().trim();

//     // Detect user row
//     if (firstCell.startsWith("👤")) {
//       currentEmail = firstCell.replace("👤", "").trim();
//       insideWeekly = false; // reset
//     }

//     // Detect start of weekly section
//     else if (firstCell === '→ Weekly Updates') {
//       insideWeekly = true;
//     }

//     // Detect header row inside weekly section
//     else if (insideWeekly && firstCell === 'Timestamp') {
//       headers = row;
//       colIndexes = {
//         carryover: headers.indexOf("Number Of Carryover Tasks (From Last Week)"),
//         newAssigned: headers.indexOf("Number Of New Tasks Assigned (For This Week)"),
//         completed: headers.indexOf("Number Of Tasks Completed (For This Week)"),
//         blocked: headers.indexOf("Number Of Tasks Blocked (For This Week)")
//       };
//     }

//     // Extract numeric values from the first data row under weekly
//     else if (insideWeekly && firstCell && !isNaN(Date.parse(firstCell))) {
//       const carry = parseInt(row[colIndexes.carryover]) || 0;
//       const assigned = parseInt(row[colIndexes.newAssigned]) || 0;
//       const completed = parseInt(row[colIndexes.completed]) || 0;
//       const blocked = parseInt(row[colIndexes.blocked]) || 0;

//       output.push([
//         currentEmail,
//         carry,
//         assigned,
//         completed,
//         blocked
//       ]);

//       insideWeekly = false; // Stop after first row per person
//     }
//   });

//   // Output to a new sheet
//   const summarySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Weekly Task Summary") ||
//                        SpreadsheetApp.getActiveSpreadsheet().insertSheet("Weekly Task Summary");
//   summarySheet.clearContents();
//   summarySheet.appendRow([
//     "Email",
//     "Carryover Tasks",
//     "New Tasks Assigned",
//     "Tasks Completed",
//     "Tasks Blocked"
//   ]);
//   summarySheet.getRange(2, 1, output.length, output[0].length).setValues(output);
// }



function generateWeeklyCountSummary() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('QA Status Report');
  const data = sheet.getDataRange().getValues();

  const headers = [
    'Number Of Carryover Tasks (From Last Week)',
    'Number Of New Tasks Assigned (For This Week)',
    'Number Of Tasks Completed (For This Week)',
    'Number Of Tasks Blocked (For This Week)'
  ];

  const summary = [['Email', ...headers]];
  let currentEmail = '';
  let insideWeeklySection = false;
  let headerIndexes = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    if (row[0] && row[0].toString().startsWith('👤')) {
      currentEmail = row[0].toString().replace('👤 ', '').trim();
      insideWeeklySection = false;
    }

    if (row[0] === '→ Weekly Updates') {
      insideWeeklySection = true;
      continue;
    }

    if (insideWeeklySection && headerIndexes.length === 0 && row.some(cell => headers.includes(cell))) {
      headerIndexes = headers.map(h => row.indexOf(h));
      continue;
    }

    if (insideWeeklySection && headerIndexes.length > 0 && row[0] && !isNaN(Date.parse(row[0]))) {
      const values = headerIndexes.map(index => {
        const val = row[index];
        return typeof val === 'number' ? val : parseInt(val) || 0;
      });
      summary.push([currentEmail, ...values]);
    }
  }

  // Write to a new sheet
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let outputSheet = ss.getSheetByName('Weekly Counts');
  if (!outputSheet) {
    outputSheet = ss.insertSheet('Weekly Counts');
  } else {
    outputSheet.clearContents();
  }
  outputSheet.getRange(1, 1, summary.length, summary[0].length).setValues(summary);
}



function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('RTZ Tools')
    .addItem('Run Weekly & Daily Check', 'checkWeeklyAndDailySubmissions')
    .addItem('Weekly Counts', 'generateWeeklyCountSummary')
    .addToUi();
}
