// function generateDailyCountSummary() {
//   const ss = SpreadsheetApp.getActiveSpreadsheet();
//   const sourceSheet = ss.getSheetByName("QA Status Report");
//   const summarySheetName = "Daily Counts";

//   // Create or clear summary sheet
//   let summarySheet = ss.getSheetByName(summarySheetName);
//   if (!summarySheet) {
//     summarySheet = ss.insertSheet(summarySheetName);
//   } else {
//     summarySheet.clearContents();
//   }

//   summarySheet.appendRow([
//     "Date",
//     "Email",
//     "Number of Meetings Attended",
//     "Number of New Tasks Assigned",
//     "Number of Tasks Completed",
//     "Percentage Completed"
//   ]);

//   const data = sourceSheet.getDataRange().getValues();

//   let currentEmail = "";
//   let collectingDaily = false;

//   for (let i = 0; i < data.length; i++) {
//     const row = data[i];

//     // Detect new user email
//     if (String(row[0]).startsWith("👤")) {
//       currentEmail = String(row[0]).replace("👤", "").trim();
//       continue;
//     }

//     // Detect daily updates block
//     if (String(row[0]).includes("→ Daily Updates")) {
//       collectingDaily = true;
//       continue;
//     }

//     // Stop collecting if another section starts
//     if (String(row[0]).includes("→ Weekly Updates") || String(row[0]).includes("*******")) {
//       collectingDaily = false;
//       continue;
//     }

//     // Extract numeric daily data
//     if (collectingDaily && row[0] instanceof Date) {
//       const [
//         timestamp,
//         , // skip "Tasks In Pipeline"
//         meetings,
//         newTasks,
//         completedTasks,
//         percent
//       ] = row;

//       summarySheet.appendRow([
//         new Date(timestamp),
//         currentEmail,
//         Number(meetings) || 0,
//         Number(newTasks) || 0,
//         Number(completedTasks) || 0,
//         parseFloat(percent) || 0
//       ]);
//     }
//   }


//     // Format the "Percentage Completed" column as percentage
//   const lastRow = summarySheet.getLastRow();
//   if (lastRow > 1) {
//     summarySheet.getRange(`F2:F${lastRow}`).setNumberFormat("0.00%");
//   }


//   SpreadsheetApp.flush();
// }



// function onOpen() {
//   const ui = SpreadsheetApp.getUi();
//   ui.createMenu('RTZ Tools')
//     .addItem('Run Weekly & Daily Check', 'checkWeeklyAndDailySubmissions')
//     .addItem('Weekly Counts', 'generateWeeklyCountSummary')
//     .addItem('Daily Counts', 'generateDailyCountSummary')
//     .addToUi();
// }




function generateDailyCountSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName("QA Status Report");
  const summarySheetName = "Daily Counts";

  // Create or clear summary sheet
  let summarySheet = ss.getSheetByName(summarySheetName);
  if (!summarySheet) {
    summarySheet = ss.insertSheet(summarySheetName);
  } else {
    summarySheet.clearContents();
  }

  summarySheet.appendRow([
    "Date",
    "Email",
    "Number of Meetings Attended",
    "Number of New Tasks Assigned",
    "Number of Tasks Completed",
    "Percentage Completed"
  ]);

  const data = sourceSheet.getDataRange().getValues();
  let rowsToAppend = [];

  let currentEmail = "";
  let collectingDaily = false;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    if (String(row[0]).startsWith("👤")) {
      currentEmail = String(row[0]).replace("👤", "").trim();
      continue;
    }

    if (String(row[0]).includes("→ Daily Updates")) {
      collectingDaily = true;
      continue;
    }

    if (String(row[0]).includes("→ Weekly Updates") || String(row[0]).includes("*******")) {
      collectingDaily = false;
      continue;
    }

    if (collectingDaily && row[0] instanceof Date) {
      const [
        timestamp,
        , // skip
        meetings,
        newTasks,
        completedTasks,
        percent
      ] = row;

      rowsToAppend.push([
        new Date(timestamp),
        currentEmail,
        Number(meetings) || 0,
        Number(newTasks) || 0,
        Number(completedTasks) || 0,
        parseFloat(percent) || 0 // leave as-is since it's already in decimal
      ]);
    }
  }



  

  if (rowsToAppend.length > 0) {
    summarySheet.getRange(2, 1, rowsToAppend.length, 6).setValues(rowsToAppend);
    summarySheet.getRange(2, 6, rowsToAppend.length, 1).setNumberFormat("0.00%");
  }

  SpreadsheetApp.flush();
}
