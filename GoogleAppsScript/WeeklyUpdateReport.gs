// function checkWeeklyAndDailySubmissions() {
//   const weeklySheetName = 'Weekly Update Responses';
//   const dailySheetName = 'Daily Update Responses';

//   const expectedEmails = [
//     "sadia.bristy@allgentech.io",
//     "mufrad.mustavi@allgentech.io",
//     "mysha.parvin@allgentech.io",
//     "effat.jahan@allgentech.io",
//     "shaina.ferdous@allgentech.io",
//     "sarataj.sultan@allgentech.io",
//     "nawsheen.chowdhury@allgentech.io",
//     "israth.nafi@allgentech.io",
//     "mufrad.mustahsin@allgentech.io",
//     "faria.afrin@allgentech.io",
//     "jabin.nessa@allgentech.io",
//     "muhaiminul.islam@allgentech.io",
//     "syed.elahi@allgentech.io"
//   ];

//   // Optional manual override
//   const startDateStr = '';
//   const endDateStr = '';

//   let startDate, endDate;
  
//   if (startDateStr && endDateStr) {
//     startDate = new Date(startDateStr + 'T00:00:00');
//     endDate = new Date(endDateStr + 'T23:59:59');
//   } else {
//     // Get today's date in Bangladesh using Utilities.formatDate
//     const today = new Date();
//     // Format today's date (BD) to a string 'yyyy-MM-dd'
//     const bdTodayStr = Utilities.formatDate(today, 'Asia/Dhaka', 'yyyy-MM-dd');
//     // Create a date representing the end of today in BD time.
//     // (This string will be parsed in your local timezone, but because we use the same format everywhere, the comparison should work.)
//     const bdToday = new Date(bdTodayStr + 'T23:59:59');
    
//     // Get the day index (0=Sunday, 1=Monday,..., 5=Friday, 6=Saturday) for today.
//     // Note: Because bdToday was built from a formatted string, its getDay() is effectively the BD day.
//     const bdDay = bdToday.getDay();
    
//     // Calculate days to subtract to get the most recent Friday.
//     // For example:
//     // - If today is Monday (1), then last Friday is 3 days ago: (1 + 2) = 3.
//     // - If today is Friday (5), then last Friday is today (5 - 5 = 0).
//     // - If today is Sunday (0), then last Friday is 2 days ago: (0 + 2) = 2.
//     let daysToLastFriday = (bdDay < 5) ? (bdDay + 2) : (bdDay - 5);
    
//     const lastFriday = new Date(bdToday);
//     lastFriday.setDate(bdToday.getDate() - daysToLastFriday);
//     lastFriday.setHours(0, 0, 0, 0); // Start of last Friday

//     startDate = lastFriday;
//     endDate = bdToday;
//   }

//   const results = [];

//   results.push(`*** CHECKING WEEKLY UPDATES (${formatDate(startDate)} to ${formatDate(endDate)}) ***`);
//   results.push(...checkWeekly('Weekly Update Responses', expectedEmails, startDate, endDate));

//   results.push(`\n=== CHECKING DAILY UPDATES (${formatDate(startDate)} to ${formatDate(endDate)}) ===`);
//   results.push(...checkDaily('Daily Update Responses', expectedEmails, startDate, endDate));

//   writeToSheet(results);
//   addQAUpdatesSection(expectedEmails, 'Daily Update Responses', 'Weekly Update Responses', startDate, endDate);
// }

// function checkWeekly(sheetName, expectedEmails, startDate, endDate) {
//   const logs = [];
//   const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
//   if (!sheet) return [`❌ Sheet "${sheetName}" not found.`];

//   const data = sheet.getDataRange().getValues();
//   const submittedEmails = new Set();

//   for (let i = 1; i < data.length; i++) {
//     const rawDate = data[i][0];
//     const email = data[i][1];
//     if (!rawDate || !email) continue;
//     // Convert the raw date to a BD time string and then back to a Date object
//     const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//     if (timestamp >= startDate && timestamp <= endDate) {
//       submittedEmails.add(email.trim().toLowerCase());
//     }
//   }

//   const missing = expectedEmails.filter(e => !submittedEmails.has(e.trim().toLowerCase()));
//   logs.push(missing.length
//     ? `❌ Weekly update missing from: ${missing.join(', ')}`
//     : `✅ All expected users submitted their weekly update.`);
//   return logs;
// }

// function checkDaily(sheetName, expectedEmails, startDate, endDate) {
//   const logs = [];
//   const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
//   if (!sheet) return [`❌ Sheet "${sheetName}" not found.`];

//   const data = sheet.getDataRange().getValues();

//   // Loop through each day from last Friday to today
//   for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
//     const currentDate = new Date(d);
//     const dayName = getBangladeshDayName(currentDate);
//     // Skip Saturday and Sunday
//     if (dayName === 'Saturday' || dayName === 'Sunday') continue;
    
//     const currentDateStr = formatDate(currentDate);
//     const submittedEmails = new Set();

//     for (let i = 1; i < data.length; i++) {
//       const rawDate = data[i][0];
//       const email = data[i][1];
//       if (!rawDate || !email) continue;
//       const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//       const submissionDateStr = Utilities.formatDate(timestamp, 'Asia/Dhaka', 'yyyy-MM-dd');
//       if (submissionDateStr === currentDateStr) {
//         submittedEmails.add(email.trim().toLowerCase());
//       }
//     }

//     const missing = expectedEmails.filter(e => !submittedEmails.has(e.trim().toLowerCase()));
//     logs.push(`📅 DAILY UPDATE – ${dayName}, ${currentDateStr}`);
//     logs.push(missing.length
//       ? `❌ Missing from: ${missing.join(', ')}`
//       : `✅ All expected users submitted their daily update.`);
//   }

//   return logs;
// }

// function addQAUpdatesSection(expectedEmails, dailySheetName, weeklySheetName, startDate, endDate) {
//   const ss = SpreadsheetApp.getActiveSpreadsheet();
//   const sheet = ss.getSheetByName('QA Status Report');
//   let row = sheet.getLastRow() + 4;
//   sheet.getRange(row++, 1).setValue('******* QA UPDATES *******');

//   const dailySheet = ss.getSheetByName(dailySheetName);
//   const weeklySheet = ss.getSheetByName(weeklySheetName);
//   const dailyData = dailySheet.getDataRange().getValues();
//   const weeklyData = weeklySheet.getDataRange().getValues();

//   const dailyHeaders = dailyData[0];
//   const weeklyHeaders = weeklyData[0];

//   expectedEmails.forEach(email => {
//     sheet.getRange(row++, 1).setValue(`👤 ${email}`);

//     // === DAILY UPDATES ===
//     sheet.getRange(row++, 1).setValue('→ Daily Updates');
//     const dailyCols = [
//       'Timestamp',
//       'Tasks In Pipeline',
//       'Number of Meetings Attended',
//       'Number of New Tasks Assigned',
//       'Number of Tasks Completed',
//       'Percentage Completed',
//       'Any Issues or Blockers or Confusion',
//       'Blocker Impact',
//       'Any Achievements'
//     ];
//     const dailyColIndexes = dailyCols.map(col => dailyHeaders.indexOf(col));
//     sheet.getRange(row++, 1, 1, dailyCols.length).setValues([dailyCols]);

//     let dailyRowsFound = 0;
//     for (let i = 1; i < dailyData.length; i++) {
//       const rawDate = dailyData[i][0];
//       const rowEmail = dailyData[i][1]?.toLowerCase();
//       if (!rawDate || !rowEmail) continue;
//       const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//       if (rowEmail === email.toLowerCase() && timestamp >= startDate && timestamp <= endDate) {
//         const values = [Utilities.formatDate(timestamp, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss')];
//         values.push(...dailyColIndexes.slice(1).map(index => index !== -1 ? dailyData[i][index] : ''));
//         sheet.getRange(row++, 1, 1, values.length).setValues([values]);
//         dailyRowsFound++;
//       }
//     }
//     if (dailyRowsFound === 0) {
//       sheet.getRange(row++, 1).setValue('No daily updates found in this range.');
//     }
//     row++;

//     // === WEEKLY UPDATES ===
//     sheet.getRange(row++, 1).setValue('→ Weekly Updates');
//     const weeklyCols = [
//       'Timestamp',
//       'Number Of Carryover Tasks (From Last Week)',
//       'Number Of New Tasks Assigned (For This Week)',
//       'Number Of Tasks Completed (For This Week)',
//       'Number Of Tasks Blocked (For This Week)',
//       'Blocker Impact',
//       'Number Of Bug Tickets (For This Week)',
//       'Number Of User Story Tickets Assigned (For This Week)',
//       'Number Of User Story Tickets Completed (This Week)',
//       'Total Story Points Assigned (This Week)',
//       'Total Story Points Completed (This Week)',
//       'Achievements (For This Week)',
//       'List of Blockers (For This Week)'
//     ];
//     const weeklyColIndexes = weeklyCols.map(col => weeklyHeaders.indexOf(col));
//     sheet.getRange(row++, 1, 1, weeklyCols.length).setValues([weeklyCols]);

//     let weeklyRowsFound = 0;
//     for (let i = 1; i < weeklyData.length; i++) {
//       const rawDate = weeklyData[i][0];
//       const rowEmail = weeklyData[i][1]?.toLowerCase();
//       if (!rawDate || !rowEmail) continue;
//       const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//       if (rowEmail === email.toLowerCase() && timestamp >= startDate && timestamp <= endDate) {
//         const values = weeklyColIndexes.map(index => weeklyData[i][index]);
//         sheet.getRange(row++, 1, 1, values.length).setValues([values]);
//         weeklyRowsFound++;
//       }
//     }
//     if (weeklyRowsFound === 0) {
//       sheet.getRange(row++, 1).setValue('No weekly updates found in this range.');
//     }
//     row++;
//   });
// }

// function formatDate(date) {
//   return Utilities.formatDate(date, 'Asia/Dhaka', 'yyyy-MM-dd');
// }

// function getBangladeshDayName(date) {
//   return Utilities.formatDate(date, 'Asia/Dhaka', 'EEEE');
// }

// function writeToSheet(lines) {
//   const sheetName = 'QA Status Report';
//   const ss = SpreadsheetApp.getActiveSpreadsheet();
//   let sheet = ss.getSheetByName(sheetName);
//   if (!sheet) {
//     sheet = ss.insertSheet(sheetName);
//   } else {
//     sheet.clearContents();
//   }
//   lines.forEach((line, i) => {
//     sheet.getRange(i + 1, 1).setValue(line);
//   });
// }

// function onOpen() {
//   const ui = SpreadsheetApp.getUi();
//   ui.createMenu('RTZ Tools')
//     .addItem('Run Weekly & Daily Check', 'checkWeeklyAndDailySubmissions')
//     .addToUi();
// }






//  Working
// function checkWeeklyAndDailySubmissions() {
//   const weeklySheetName = 'Weekly Update Responses';
//   const dailySheetName = 'Daily Update Responses';

//   const expectedEmails = [
//     "sadia.bristy@allgentech.io",
//     "mufrad.mustavi@allgentech.io",
//     "mysha.parvin@allgentech.io",
//     "effat.jahan@allgentech.io",
//     "shaina.ferdous@allgentech.io",
//     "sarataj.sultan@allgentech.io",
//     "nawsheen.chowdhury@allgentech.io",
//     "israth.nafi@allgentech.io",
//     "mufrad.mustahsin@allgentech.io",
//     "faria.afrin@allgentech.io",
//     "jabin.nessa@allgentech.io",
//     "muhaiminul.islam@allgentech.io",
//     "syed.elahi@allgentech.io"
//   ];

//   // Optional manual override
//   const startDateStr = '';
//   const endDateStr = '';

//   let startDate, endDate;

//   if (startDateStr && endDateStr) {
//     startDate = new Date(startDateStr + 'T00:00:00');
//     endDate = new Date(endDateStr + 'T23:59:59');
//   } else {
//     // Get today's date in BD time (as a formatted string)
//     const today = new Date();
//     const bdTodayStr = Utilities.formatDate(today, 'Asia/Dhaka', 'yyyy-MM-dd');
//     // Build a Date object for the end of today in BD
//     const bdToday = new Date(bdTodayStr + 'T23:59:59');
//     const bdDay = bdToday.getDay(); // 0 = Sunday, 1 = Monday, ... , 5 = Friday, 6 = Saturday

//     let daysToLastFriday;
//     if (bdDay === 5) { 
//       // If today is Friday, we want last Friday (i.e. 7 days ago)
//       daysToLastFriday = 7;
//     } else if (bdDay === 6) { 
//       // If today is Saturday, last Friday is yesterday
//       daysToLastFriday = 1;
//     } else {
//       // For Sunday through Thursday, last Friday is (day + 2) days ago.
//       daysToLastFriday = bdDay + 2;
//     }
    
//     const lastFriday = new Date(bdToday);
//     lastFriday.setDate(bdToday.getDate() - daysToLastFriday);
//     lastFriday.setHours(0, 0, 0, 0);
    
//     startDate = lastFriday;
//     endDate = bdToday;
//   }

//   const results = [];

//   results.push(`*** CHECKING WEEKLY UPDATES (${formatDate(startDate)} to ${formatDate(endDate)}) ***`);
//   results.push(...checkWeekly('Weekly Update Responses', expectedEmails, startDate, endDate));

//   results.push(`\n=== CHECKING DAILY UPDATES (${formatDate(startDate)} to ${formatDate(endDate)}) ===`);
//   results.push(...checkDaily('Daily Update Responses', expectedEmails, startDate, endDate));

//   writeToSheet(results);
//   addQAUpdatesSection(expectedEmails, 'Daily Update Responses', 'Weekly Update Responses', startDate, endDate);
// }

// function checkWeekly(sheetName, expectedEmails, startDate, endDate) {
//   const logs = [];
//   const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
//   if (!sheet) return [`❌ Sheet "${sheetName}" not found.`];

//   const data = sheet.getDataRange().getValues();
//   const submittedEmails = new Set();

//   for (let i = 1; i < data.length; i++) {
//     const rawDate = data[i][0];
//     const email = data[i][1];
//     if (!rawDate || !email) continue;
//     // Convert raw date to BD time
//     const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//     if (timestamp >= startDate && timestamp <= endDate) {
//       submittedEmails.add(email.trim().toLowerCase());
//     }
//   }

//   const missing = expectedEmails.filter(e => !submittedEmails.has(e.trim().toLowerCase()));
//   logs.push(missing.length
//     ? `❌ Weekly update missing from: ${missing.join(', ')}`
//     : `✅ All expected users submitted their weekly update.`);
//   return logs;
// }

// function checkDaily(sheetName, expectedEmails, startDate, endDate) {
//   const logs = [];
//   const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
//   if (!sheet) return [`❌ Sheet "${sheetName}" not found.`];

//   const data = sheet.getDataRange().getValues();

//   // Loop from last Friday to today
//   for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
//     const currentDate = new Date(d);
//     const dayName = getBangladeshDayName(currentDate);
//     // Skip Saturday and Sunday
//     if (dayName === 'Saturday' || dayName === 'Sunday') continue;
    
//     const currentDateStr = formatDate(currentDate);
//     const submittedEmails = new Set();

//     for (let i = 1; i < data.length; i++) {
//       const rawDate = data[i][0];
//       const email = data[i][1];
//       if (!rawDate || !email) continue;
//       const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//       const submissionDateStr = Utilities.formatDate(timestamp, 'Asia/Dhaka', 'yyyy-MM-dd');
//       if (submissionDateStr === currentDateStr) {
//         submittedEmails.add(email.trim().toLowerCase());
//       }
//     }

//     const missing = expectedEmails.filter(e => !submittedEmails.has(e.trim().toLowerCase()));
//     logs.push(`📅 DAILY UPDATE – ${dayName}, ${currentDateStr}`);
//     logs.push(missing.length
//       ? `❌ Missing from: ${missing.join(', ')}`
//       : `✅ All expected users submitted their daily update.`);
//   }

//   return logs;
// }

// function addQAUpdatesSection(expectedEmails, dailySheetName, weeklySheetName, startDate, endDate) {
//   const ss = SpreadsheetApp.getActiveSpreadsheet();
//   const sheet = ss.getSheetByName('QA Status Report');
//   let row = sheet.getLastRow() + 4;
//   sheet.getRange(row++, 1).setValue('******* QA UPDATES *******');

//   const dailySheet = ss.getSheetByName(dailySheetName);
//   const weeklySheet = ss.getSheetByName(weeklySheetName);
//   const dailyData = dailySheet.getDataRange().getValues();
//   const weeklyData = weeklySheet.getDataRange().getValues();

//   const dailyHeaders = dailyData[0];
//   const weeklyHeaders = weeklyData[0];

//   expectedEmails.forEach(email => {
//     sheet.getRange(row++, 1).setValue(`👤 ${email}`);

//     // === DAILY UPDATES ===
//     sheet.getRange(row++, 1).setValue('→ Daily Updates');
//     const dailyCols = [
//       'Timestamp',
//       'Tasks In Pipeline',
//       'Number of Meetings Attended',
//       'Number of New Tasks Assigned',
//       'Number of Tasks Completed',
//       'Percentage Completed',
//       'Any Issues or Blockers or Confusion',
//       'Blocker Impact',
//       'Any Achievements'
//     ];
//     const dailyColIndexes = dailyCols.map(col => dailyHeaders.indexOf(col));
//     sheet.getRange(row++, 1, 1, dailyCols.length).setValues([dailyCols]);

//     let dailyRowsFound = 0;
//     for (let i = 1; i < dailyData.length; i++) {
//       const rawDate = dailyData[i][0];
//       const rowEmail = dailyData[i][1]?.toLowerCase();
//       if (!rawDate || !rowEmail) continue;
//       const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//       if (rowEmail === email.toLowerCase() && timestamp >= startDate && timestamp <= endDate) {
//         const values = [Utilities.formatDate(timestamp, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss')];
//         values.push(...dailyColIndexes.slice(1).map(index => index !== -1 ? dailyData[i][index] : ''));
//         sheet.getRange(row++, 1, 1, values.length).setValues([values]);
//         dailyRowsFound++;
//       }
//     }
//     if (dailyRowsFound === 0) {
//       sheet.getRange(row++, 1).setValue('No daily updates found in this range.');
//     }
//     row++;

//     // === WEEKLY UPDATES ===
//     sheet.getRange(row++, 1).setValue('→ Weekly Updates');
//     const weeklyCols = [
//       'Timestamp',
//       'Number Of Carryover Tasks (From Last Week)',
//       'Number Of New Tasks Assigned (For This Week)',
//       'Number Of Tasks Completed (For This Week)',
//       'Number Of Tasks Blocked (For This Week)',
//       'Blocker Impact',
//       'Number Of Bug Tickets (For This Week)',
//       'Number Of User Story Tickets Assigned (For This Week)',
//       'Number Of User Story Tickets Completed (This Week)',
//       'Total Story Points Assigned (This Week)',
//       'Total Story Points Completed (This Week)',
//       'Achievements (For This Week)',
//       'List of Blockers (For This Week)'
//     ];
//     const weeklyColIndexes = weeklyCols.map(col => weeklyHeaders.indexOf(col));
//     sheet.getRange(row++, 1, 1, weeklyCols.length).setValues([weeklyCols]);

//     let weeklyRowsFound = 0;
//     for (let i = 1; i < weeklyData.length; i++) {
//       const rawDate = weeklyData[i][0];
//       const rowEmail = weeklyData[i][1]?.toLowerCase();
//       if (!rawDate || !rowEmail) continue;
//       const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
//       if (rowEmail === email.toLowerCase() && timestamp >= startDate && timestamp <= endDate) {
//         const values = weeklyColIndexes.map(index => weeklyData[i][index]);
//         sheet.getRange(row++, 1, 1, values.length).setValues([values]);
//         weeklyRowsFound++;
//       }
//     }
//     if (weeklyRowsFound === 0) {
//       sheet.getRange(row++, 1).setValue('No weekly updates found in this range.');
//     }
//     row++;
//   });
// }

// function formatDate(date) {
//   return Utilities.formatDate(date, 'Asia/Dhaka', 'yyyy-MM-dd');
// }

// function getBangladeshDayName(date) {
//   return Utilities.formatDate(date, 'Asia/Dhaka', 'EEEE');
// }

// function writeToSheet(lines) {
//   const sheetName = 'QA Status Report';
//   const ss = SpreadsheetApp.getActiveSpreadsheet();
//   let sheet = ss.getSheetByName(sheetName);
//   if (!sheet) {
//     sheet = ss.insertSheet(sheetName);
//   } else {
//     sheet.clearContents();
//   }
//   lines.forEach((line, i) => {
//     sheet.getRange(i + 1, 1).setValue(line);
//   });
// }

// function onOpen() {
//   const ui = SpreadsheetApp.getUi();
//   ui.createMenu('RTZ Tools')
//     .addItem('Run Weekly & Daily Check', 'checkWeeklyAndDailySubmissions')
//     .addToUi();
// }







function checkWeeklyAndDailySubmissions() {
  const weeklySheetName = 'Weekly Update Responses';
  const dailySheetName = 'Daily Update Responses';

  const expectedEmails = [
    "sadia.bristy@allgentech.io",
    "mufrad.mustavi@allgentech.io",
    "mysha.parvin@allgentech.io",
    "effat.jahan@allgentech.io",
    "shaina.ferdous@allgentech.io",
    "sarataj.sultan@allgentech.io",
    "nawsheen.chowdhury@allgentech.io",
    "israth.nafi@allgentech.io",
    "mufrad.mustahsin@allgentech.io",
    "faria.afrin@allgentech.io",
    "jabin.nessa@allgentech.io",
    "muhaiminul.islam@allgentech.io",
    "syed.elahi@allgentech.io"
  ];

  // Optional manual override
  const startDateStr = '';
  const endDateStr = '';

  let startDate, endDate;
  if (startDateStr && endDateStr) {
    startDate = new Date(startDateStr + 'T00:00:00');
    endDate = new Date(endDateStr + 'T23:59:59');
  } else {
    // Get today's date in BD time
    const today = new Date();
    const bdTodayStr = Utilities.formatDate(today, 'Asia/Dhaka', 'yyyy-MM-dd');
    const bdToday = new Date(bdTodayStr + 'T23:59:59');
    const bdDay = bdToday.getDay(); // 0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday

    let daysToLastFriday;
    if (bdDay === 5) {
      // If today is Friday, use last Friday (7 days ago)
      daysToLastFriday = 7;
    } else if (bdDay === 6) {
      // If today is Saturday, last Friday is yesterday
      daysToLastFriday = 1;
    } else {
      // For Sunday through Thursday, last Friday is (bdDay + 2) days ago.
      daysToLastFriday = bdDay + 2;
    }
    const lastFriday = new Date(bdToday);
    lastFriday.setDate(bdToday.getDate() - daysToLastFriday);
    lastFriday.setHours(0, 0, 0, 0);
    startDate = lastFriday;
    endDate = bdToday;
  }

  const results = [];
  results.push(`*** CHECKING WEEKLY UPDATES (${formatDate(startDate)} to ${formatDate(endDate)}) ***`);
  results.push(...checkWeekly('Weekly Update Responses', expectedEmails, startDate, endDate));
  results.push(`\n=== CHECKING DAILY UPDATES (${formatDate(startDate)} to ${formatDate(endDate)}) ===`);
  results.push(...checkDaily('Daily Update Responses', expectedEmails, startDate, endDate));

  writeToSheet(results);
  addQAUpdatesSection(expectedEmails, 'Daily Update Responses', 'Weekly Update Responses', startDate, endDate);
}

function checkWeekly(sheetName, expectedEmails, startDate, endDate) {
  const logs = [];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [`❌ Sheet "${sheetName}" not found.`];
  const data = sheet.getDataRange().getValues();
  const submittedEmails = new Set();

  for (let i = 1; i < data.length; i++) {
    const rawDate = data[i][0];
    const email = data[i][1];
    if (!rawDate || !email) continue;
    const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
    if (timestamp >= startDate && timestamp <= endDate) {
      submittedEmails.add(email.trim().toLowerCase());
    }
  }
  const missing = expectedEmails.filter(e => !submittedEmails.has(e.trim().toLowerCase()));
  logs.push(missing.length
    ? `❌ Weekly update missing from: ${missing.join(', ')}`
    : `✅ All expected users submitted their weekly update.`);
  return logs;
}

function checkDaily(sheetName, expectedEmails, startDate, endDate) {
  const logs = [];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [`❌ Sheet "${sheetName}" not found.`];
  const data = sheet.getDataRange().getValues();

  // Loop through each day from last Friday to today (skip Saturday and Sunday)
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const currentDate = new Date(d);
    const dayName = getBangladeshDayName(currentDate);
    if (dayName === 'Saturday' || dayName === 'Sunday') continue;
    const currentDateStr = formatDate(currentDate);
    const submittedEmails = new Set();

    for (let i = 1; i < data.length; i++) {
      const rawDate = data[i][0];
      const email = data[i][1];
      if (!rawDate || !email) continue;
      const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
      const submissionDateStr = Utilities.formatDate(timestamp, 'Asia/Dhaka', 'yyyy-MM-dd');
      if (submissionDateStr === currentDateStr) {
        submittedEmails.add(email.trim().toLowerCase());
      }
    }
    const missing = expectedEmails.filter(e => !submittedEmails.has(e.trim().toLowerCase()));
    logs.push(`📅 DAILY UPDATE – ${dayName}, ${currentDateStr}`);
    logs.push(missing.length
      ? `❌ Missing from: ${missing.join(', ')}`
      : `✅ All expected users submitted their daily update.`);
  }
  return logs;
}

function addQAUpdatesSection(expectedEmails, dailySheetName, weeklySheetName, startDate, endDate) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('QA Status Report');
  let row = sheet.getLastRow() + 4;
  sheet.getRange(row++, 1).setValue('******* QA UPDATES *******');

  const dailySheet = ss.getSheetByName(dailySheetName);
  const weeklySheet = ss.getSheetByName(weeklySheetName);
  const dailyData = dailySheet.getDataRange().getValues();
  const weeklyData = weeklySheet.getDataRange().getValues();

  // For Daily Updates: perform a header lookup based on the correct mapping.
  // The report columns should exactly be:
  const reportDailyCols = [
    'Timestamp',
    'Tasks In Pipeline',
    'Number of Meetings Attended',
    'Number of New Tasks Assigned',
    'Number of Tasks Completed',
    'Percentage Completed',
    'Any Issues or Blockers or Confusion',
    'Blocker Impact',
    'Any Achievements'
  ];
  // Look up each column index from the daily update sheet header (row 1)
  const dailyHeaders = dailyData[0];
  const dailyColIndexes = reportDailyCols.map(col => {
    return dailyHeaders.findIndex(header => header.toString().trim().toLowerCase() === col.toLowerCase());
  });

  // For Weekly Updates, we'll still use a case‑insensitive lookup.
  const weeklyCols = [
    'Timestamp',
    'Number Of Carryover Tasks (From Last Week)',
    'Number Of New Tasks Assigned (For This Week)',
    'Number Of Tasks Completed (For This Week)',
    'Number Of Tasks Blocked (For This Week)',
    'Blocker Impact',
    'Number Of Bug Tickets (For This Week)',
    'Number Of User Story Tickets Assigned (For This Week)',
    'Number Of User Story Tickets Completed (This Week)',
    'Total Story Points Assigned (This Week)',
    'Total Story Points Completed (This Week)',
    'Achievements (For This Week)',
    'List of Blockers (For This Week)'
  ];
  const weeklyHeaders = weeklyData[0];
  const weeklyColIndexes = weeklyCols.map(col => {
    return weeklyHeaders.findIndex(header => header.toString().trim().toLowerCase() === col.toLowerCase());
  });

  expectedEmails.forEach(email => {
    sheet.getRange(row++, 1).setValue(`👤 ${email}`);

    // === DAILY UPDATES ===
    sheet.getRange(row++, 1).setValue('→ Daily Updates');
    // Output the report header for daily updates
    sheet.getRange(row++, 1, 1, reportDailyCols.length).setValues([reportDailyCols]);

    let dailyRowsFound = 0;
    for (let i = 1; i < dailyData.length; i++) {
      const rawDate = dailyData[i][0];
      const rowEmail = dailyData[i][1] ? dailyData[i][1].toString().toLowerCase() : '';
      if (!rawDate || !rowEmail) continue;
      const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
      if (rowEmail === email.toLowerCase() && timestamp >= startDate && timestamp <= endDate) {
        // For each report column, get the corresponding value from the daily update row.
        const rowValues = dailyColIndexes.map(index => (index !== -1 ? dailyData[i][index] : ''));
        // Ensure Timestamp is formatted properly
        rowValues[0] = Utilities.formatDate(timestamp, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss');
        sheet.getRange(row++, 1, 1, rowValues.length).setValues([rowValues]);
        dailyRowsFound++;
      }
    }
    if (dailyRowsFound === 0) {
      sheet.getRange(row++, 1).setValue('No daily updates found in this range.');
    }
    row++;

    // === WEEKLY UPDATES ===
    sheet.getRange(row++, 1).setValue('→ Weekly Updates');
    sheet.getRange(row++, 1, 1, weeklyCols.length).setValues([weeklyCols]);

    let weeklyRowsFound = 0;
    for (let i = 1; i < weeklyData.length; i++) {
      const rawDate = weeklyData[i][0];
      const rowEmail = weeklyData[i][1] ? weeklyData[i][1].toString().toLowerCase() : '';
      if (!rawDate || !rowEmail) continue;
      const timestamp = new Date(Utilities.formatDate(rawDate, 'Asia/Dhaka', 'yyyy-MM-dd HH:mm:ss'));
      if (rowEmail === email.toLowerCase() && timestamp >= startDate && timestamp <= endDate) {
        const values = weeklyColIndexes.map(index => (index !== -1 ? weeklyData[i][index] : ''));
        sheet.getRange(row++, 1, 1, values.length).setValues([values]);
        weeklyRowsFound++;
      }
    }
    if (weeklyRowsFound === 0) {
      sheet.getRange(row++, 1).setValue('No weekly updates found in this range.');
    }
    row++;
  });
}

function formatDate(date) {
  return Utilities.formatDate(date, 'Asia/Dhaka', 'yyyy-MM-dd');
}

function getBangladeshDayName(date) {
  return Utilities.formatDate(date, 'Asia/Dhaka', 'EEEE');
}

function writeToSheet(lines) {
  const sheetName = 'QA Status Report';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  } else {
    sheet.clearContents();
  }
  lines.forEach((line, i) => {
    sheet.getRange(i + 1, 1).setValue(line);
  });
}

// function onOpen() {
//   const ui = SpreadsheetApp.getUi();
//   ui.createMenu('RTZ Tools')
//     .addItem('Run Weekly & Daily Check', 'checkWeeklyAndDailySubmissions')
//     .addToUi();
// }



function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('RTZ Tools')
    .addItem('Run Weekly & Daily Check', 'checkWeeklyAndDailySubmissions')
    .addItem('Weekly Counts', 'generateWeeklyCountSummary')
    .addItem('Daily Counts', 'generateDailyCountSummary')
    .addToUi();
}
