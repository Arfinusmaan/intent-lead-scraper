import { chromium } from "playwright";

(async () => {
    console.log("Starting debug...");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("Going to URL...");
    await page.goto("https://www.google.com/maps/search/plumbers+in+77001");
    
    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
        console.log("Found feed!");
    } catch {
        console.log("No feed found - maybe a single result page?");
    }

    const listings = page.locator('div[role="feed"] a[href*="/place"]');
    const total = await listings.count();
    console.log("Total visible listings:", total);
    
    if (total > 0) {
        console.log("Clicking first listing...");
        const item = listings.nth(0);
        const name = await item.getAttribute("aria-label");
        console.log("Extracted Name directly from item:", name);
        
        await item.scrollIntoViewIfNeeded();
        
        const oldUrl = page.url();
        await item.click({ force: true, timeout: 2000 }).catch(() => item.evaluate(el => el.click()));
        
        console.log("Waiting for url to change as a signal that the SPA transitioned");
        await page.waitForFunction((old) => document.location.href !== old, oldUrl, { timeout: 5000 }).catch(() => console.log("URL didn't change fast enough"));
        
        await page.waitForTimeout(1000); // UI stabilization buffer
        
        console.log("New URL:", page.url());

        // Now extract
        const phone = await page.locator('button[data-item-id*="phone:tel:"], button[data-item-id="phone"], button[aria-label*="Call"], a[href^="tel:"]').first().textContent().catch(() => "none");
        console.log("Phone:", phone);

        let website = "";
        const wElements = await page.locator('a[data-item-id="authority"], a[aria-label*="Website"], a[href^="http"]').all();
        console.log("Total link tags matched:", wElements.length);
        for (let w of wElements) {
            const href = await w.getAttribute("href");
            if (href && href.startsWith("http") && !href.includes("google.com")) {
                website = href;
                break;
            }
        }
        console.log("Extracted Website:", website);
    }
    
    await browser.close();
})();
