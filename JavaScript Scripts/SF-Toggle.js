function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function togglePathTabs() {
  const delayMs = 1000; // change delay if needed

  while (true) {
    const inProgressTab = document.querySelector(
      'a.tabHeader[data-tab-name="In Progress"][title="In Progress"]'
    );

    const newTab = document.querySelector(
      'a.tabHeader[data-tab-name="New"][title="New"]'
    );

    if (!inProgressTab || !newTab) {
      console.error("Could not find one or both tabs.");
      break;
    }

    console.log("Clicking In Progress");
    inProgressTab.click();
    await sleep(delayMs);

    console.log("Clicking New");
    newTab.click();
    await sleep(delayMs);
  }
}

togglePathTabs();
