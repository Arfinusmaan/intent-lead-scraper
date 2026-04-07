import { chromium } from "playwright";
import { randomDelay, log } from "./utils.js";
import { getSubLocations } from "./cityService.js";
import { getJob } from "./store.js";
import { scoreLead } from "./intentScorer.js";
import { extractDecisionMaker } from "./decisionMaker.js";
import { safeGoto, retry } from "./utils.js";

// =========================
// SAFE CLICK (PREVENT FREEZE)
// =========================
async function safeClick(element) {
  try {
    await element.click({ force: true, timeout: 2000 });
  } catch {
    try {
      await element.evaluate((el) => el.click());
    } catch {}
  }
}

export async function scrapeGoogleMaps(
  niche,
  location,
  filterType,
  jobId,
  onProgress = () => {},
) {
  if (!getJob(jobId)) return [];

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  let allLeads = [];

  // =========================
  // JUNK FILTERS
  // =========================
  const JUNK_DOMAINS = [
    'sentry.io', 'wix.com', 'wordpress.com', 'squarespace.com', 
    'github.com', 'google.com', 'yahoo.com', 'hotmail.com',
    'example.com', 'domain.com', 'namecheap.com'
  ];
  
  const JUNK_PREFIXES = [
    'tracking', 'no-reply', 'noreply', 'mailer', 'daemon',
    'postmaster', 'abuse', 'webmaster', 'automated'
  ];

  function isValidEmail(email) {
    if (!email) return false;
    const parts = email.split('@');
    if (parts.length !== 2) return false;
    const [prefix, domain] = parts;
    if (JUNK_DOMAINS.some(d => domain.includes(d))) return false;
    if (JUNK_PREFIXES.some(p => prefix.includes(p))) return false;
    if (email.endsWith('.png') || email.endsWith('.jpg') || email.endsWith('.jpeg') || email.endsWith('.gif') || email.endsWith('.css') || email.endsWith('.webp')) return false;
    return true;
  }

  // =========================
  // INDEPENDENT WEBSITE DATA EXTRACTION
  // =========================
  async function extractWebsiteData(ctx, website) {
    if (!website) return { primary: "", secondary: [], owner: "" };
    
    let page;
    let emails = [];
    let owner = "";

    try {
      page = await ctx.newPage();
      
      const cleanWeb = website.replace(/\/$/, '');
      const urls = [
        cleanWeb, 
        cleanWeb + "/contact", 
        cleanWeb + "/about",
        cleanWeb + "/about-us",
        cleanWeb + "/team"
      ];

      for (const u of urls) {
        try {
          await page.goto(u, {
            timeout: 5000,
            waitUntil: "domcontentloaded",
          });

          const html = await page.content();
          
          const found = [
            ...html.matchAll(
              /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g,
            ),
          ].map((m) => m[0].toLowerCase()).filter(isValidEmail);
          
          emails.push(...found);

          if (!owner) {
             const text = await page.evaluate(() => document.body.innerText || "");
             const match = text.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})\s*(?:-|,|is the|:)?\s*(CEO|Owner|Founder|Director|President|Co-founder|Principal)/i) || 
                           text.match(/(CEO|Owner|Founder|Director|President|Co-founder|Principal)\s*(?:-|,|:)?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/i);
             if (match) {
                 const extracted = match[1].length > match[2].length ? match[1] : match[2];
                 owner = extracted.trim().replace(/^CEO$|^Owner$|^Founder$|^Director$|^President$|^Co-founder$|^Principal$/i, '').trim();
             }
          }

        } catch {}
      }

      emails = [...new Set(emails)];

      let primary = "";
      const priority = ["contact@", "info@", "hello@", "admin@", "support@", "sales@"];

      for (const e of emails) {
        if (!primary && priority.some((p) => e.startsWith(p))) {
          primary = e;
        }
      }

      if (!primary && emails.length > 0) {
        primary = emails[0];
      }

      return {
        primary: primary,
        secondary: emails.filter((e) => e !== primary),
        owner: owner
      };
    } catch {
      return { primary: "", secondary: [], owner: "" };
    } finally {
      if (page) await page.close();
    }
  }

  // =========================
  // SCRAPE SUB-LOCATION
  // =========================
  async function scrapeSubLocation(subLocation, index, totalLocations) {
    let leads = [];
    let processedLeads = new Set();

    const queries = [
      `${niche} in ${subLocation}`
    ];

    for (const query of queries) {
      if (getJob(jobId)?.stopFlag) break;

      const page = await context.newPage();

      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "media", "font"].includes(type)) route.abort();
        else route.continue();
      });

      const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
      log(`🚀 ${subLocation} → ${query}`);

      // =========================
      // MAP LOAD (RETRY + COOKIE FIX)
      // =========================
      let loaded = false;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await safeGoto(page, url, 15000);

          const rejectBtn = page.locator('button:has-text("Reject")');
          if (await rejectBtn.count()) {
            await rejectBtn.click().catch(() => {});
          }

          await page.waitForSelector('div[role="feed"]', { timeout: 15000 });

          loaded = true;
          break;
        } catch {
          await page.waitForTimeout(2000);
        }
      }

      if (!loaded) {
        await page.close();
        continue;
      }

      const selector = 'div[role="feed"] a[href*="/place"]';

      // =========================
      // FULL SCROLL
      // =========================
      let last = 0;
      let noNew = 0;

      while (noNew < 4) {
        if (getJob(jobId)?.stopFlag) break;

        const count = await page.locator(selector).count();

        if (count === last) noNew++;
        else {
          last = count;
          noNew = 0;
        }

        await page.locator('div[role="feed"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });

        await randomDelay(500, 900);
      }

      const listings = page.locator(selector);
      const total = await listings.count();

      log(`📦 ${subLocation}: ${total}`);

      for (let i = 0; i < total; i++) {
        if (getJob(jobId)?.stopFlag) break;

        try {
          const item = listings.nth(i);
          const itemText = await item.textContent().catch(() => "");
          if (itemText.toLowerCase().includes("temporarily closed") || itemText.toLowerCase().includes("permanently closed")) {
            continue;
          }

          const name = await item.getAttribute("aria-label");
          log(`📊 Extracted: ${name || "Unknown"}`);
          if (!name || !name.trim()) continue;

          const href = await item.getAttribute("href");

          await item.scrollIntoViewIfNeeded();

          const oldUrl = page.url();
          try {
            await safeClick(item);
            log("👉 Opening listing");
            await page.waitForFunction((old) => document.location.href !== old, oldUrl, { timeout: 5000 }).catch(() => null);
            await page.waitForTimeout(1000); // UI stabilization
          } catch {
            if (href) {
              await page.goto(href, { waitUntil: "domcontentloaded" });
              await page.waitForTimeout(1500);
            } else continue;
          }

          // =========================
          // EXTRACT DATA (STABLE & SCOPED)
          // =========================
          
          let scope = page;
          try {
             // Find the detail pane for the newly opened business
             const pane = page.locator(`[role="main"][aria-label="${name}"]`).first();
             await pane.waitFor({ state: 'attached', timeout: 5000 });
             if ((await pane.count()) > 0) {
                scope = pane;
                log("👉 Successfully scoped to detail pane");
             }
          } catch {
             log("⚠️ Detail pane did not emerge, using full page scope");
          }

          // PHONE
          const phone = await scope
            .locator(
              'button[data-item-id*="phone:tel:"], button[data-item-id="phone"], button[aria-label*="Call"], a[href^="tel:"]',
            )
            .first()
            .textContent({ timeout: 1500 })
            .catch(() => "");

          // WEBSITE (ensure independent extraction without reuse)
          let website = "";
          const wElements = await scope.locator('a[data-item-id="authority"], a[aria-label*="Website"]').all();
          for (let w of wElements) {
              const wHref = await w.getAttribute("href");
              if (wHref && wHref.startsWith("http") && !wHref.includes("google.com")) {
                  website = wHref;
                  break;
              }
          }

          // RATING
          const ratingText = await scope
            .locator('[aria-label*="stars"]')
            .first()
            .getAttribute("aria-label", { timeout: 1500 })
            .catch(() => "");

          // REVIEWS
          const reviewsText = await scope
            .locator('[aria-label*="reviews"]')
            .first()
            .getAttribute("aria-label", { timeout: 1500 })
            .catch(() => "");

          // =========================
          // CLEAN PARSE (ROBUST)
          // =========================

          const rating = ratingText ? ratingText.match(/(\d+\.?\d*)/)?.[1] || "" : "";
          const reviews = reviewsText ? reviewsText.match(/(\d{1,3}(?:,\d{3})*)/)?.[1]?.replace(/,/g, "") || "" : "";

          const key = `${name}|${phone}|${website}`.toLowerCase();
          if (processedLeads.has(key)) continue;
          processedLeads.add(key);

          if (
            leads.some(
              (l) =>
                `${l.business_name}|${l.phone}|${l.website}`.toLowerCase() ===
                key,
            )
          )
            continue;

          log(`Processing: ${name}`);
          log(`Website: ${website || "none"}`);

          // =========================
          // WEBSITE-SPECIFIC EXTRACTIONS (Emails + Owner)
          // =========================
          let primary_email = "";
          let secondary_emails = [];
          let owner_name = "";

          if (website) {
              const siteData = await extractWebsiteData(context, website);
              primary_email = siteData.primary;
              secondary_emails = siteData.secondary;
              owner_name = siteData.owner;
              log(`Emails found: ${siteData.primary ? 1 + siteData.secondary.length : 0}`);
          }

          const intentData = scoreLead({
            rating: rating,
            reviews: reviews,
            website: !!website,
            email: !!primary_email,
          });

          leads.push({
            business_name: name.trim(),
            phone: phone || "",
            website: website || "",
            primary_email: primary_email,
            secondary_emails: secondary_emails.join("; "),
            rating: rating,
            reviews: reviews,
            owner_name: owner_name || "",
            owner_role: owner_name ? "Owner" : "",
            city: subLocation.toString(),
            intent: intentData.intent_tag,
            score: intentData.score,
            website_quality: website ? (primary_email ? "good" : "basic") : "none"
          });

          const progress = (index / totalLocations) * 100 + (i / total) * (100 / totalLocations);

          onProgress({
            progress: Math.min(99, Math.floor(progress)),
            city: subLocation.toString(),
            leads,
          });

        } catch (err) {
          log(`❌ ${err.message}`);
        }

        await randomDelay(200, 400);
      }

      await page.close();
    }

    return leads;
  }

  // =========================
  // LOCATION
  // =========================
  let subLocations = await getSubLocations(location);

  log(`🌍 Total Sub-Locations (ZIPs/Cities): ${subLocations.length}`);

  for (let i = 0; i < subLocations.length; i++) {
    if (getJob(jobId)?.stopFlag) break;

    const locLeads = await scrapeSubLocation(subLocations[i], i, subLocations.length);
    allLeads = allLeads.concat(locLeads);
  }

  // FILTER
  const filtered = allLeads.filter((l) => {
    if (filterType === "with_website") return !!l.website;
    if (filterType === "without_website") return !l.website;
    return true;
  });

  // GLOBAL DEDUP
  const seen = new Set();
  const finalLeads = filtered.filter((l) => {
    const key = `${l.business_name}|${l.phone}|${l.website}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!finalLeads.length) {
    log("⚠️ No leads found — possible Google block");
  }

  log(`🎯 FINAL: ${finalLeads.length}`);

  onProgress(100);

  await browser.close();
  return finalLeads;
}
