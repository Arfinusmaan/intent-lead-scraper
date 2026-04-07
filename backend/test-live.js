import { scrapeGoogleMaps } from './scraper.js';
import { createJob } from './store.js';

createJob("test1", { stopFlag: false, leads: [], progress: 0 });

console.log("Starting scrape run...");
scrapeGoogleMaps("plumbers", "77001", "all", "test1", (progress) => {
    // console.log("Progress:", progress);
}).then(res => {
   console.log("FINAL RESULT:", res);
   process.exit();
}).catch(console.error);
