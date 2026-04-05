import { resolveLocation, pickBestQuery } from './locationHandler.js';
import { scrapeGoogleMaps } from './scraper.js';
import { extractEmails } from './emailExtractor.js';
import { verifyEmail } from './verifier.js';
import { scoreLead } from './intentScorer.js';
import { extractDecisionMaker } from './decisionMaker.js';
import { exportToCsv } from './exporter.js';
import { log, normalizeNiche } from './utils.js';

const CONFIG = {
  niche: process.env.NICHE || 'plumbers',
  location: process.env.LOCATION || 'Toronto',
  country: process.env.COUNTRY || 'Canada',
  only_with_website: process.env.ONLY_WITH_WEBSITE === 'true',
  only_without_website: process.env.ONLY_WITHOUT_WEBSITE === 'true',
  max_results_per_city: parseInt(process.env.MAX_RESULTS || '100', 10),
  output_file: process.env.OUTPUT_FILE || './leads.csv',
};

async function main() {
  log('=== More Appointments Lead Engine Starting ===');
  log(`Niche: ${CONFIG.niche}`);
  log(`Location: ${CONFIG.location}`);
  log(`Country: ${CONFIG.country}`);
  if (CONFIG.only_with_website) log(`Filter: businesses WITH website only`);
  if (CONFIG.only_without_website) log(`Filter: businesses WITHOUT website only`);
  log(`Max results per city: ${CONFIG.max_results_per_city}`);

  const niches = normalizeNiche(CONFIG.niche);
  const locationInfo = resolveLocation(CONFIG.location);

  log(`Location type: ${locationInfo.type}`);
  if (locationInfo.type === 'state') {
    log(`Will process ${locationInfo.cities.length} cities in ${locationInfo.name}`);
  }

  const allLeads = [];

  for (const niche of niches) {
    for (const city of locationInfo.cities) {
      log(`--- Processing city: ${city} | Niche: ${niche} ---`);

      const query = pickBestQuery(niche, city);
      log(`Search query: "${query}"`);

      let leads = [];
      try {
        leads = await scrapeGoogleMaps(query, CONFIG.max_results_per_city);
      } catch (err) {
        log(`ERROR scraping "${query}": ${err.message}`);
        continue;
      }

      log(`Scraped ${leads.length} raw listings for "${city}"`);

      if (CONFIG.only_with_website) {
        const before = leads.length;
        leads = leads.filter(l => l.website && l.website.trim());
        log(`Filtered to ${leads.length} leads WITH websites (removed ${before - leads.length})`);
      }

      if (CONFIG.only_without_website) {
        const before = leads.length;
        leads = leads.filter(l => !l.website || !l.website.trim());
        log(`Filtered to ${leads.length} leads WITHOUT websites (removed ${before - leads.length})`);
      }

      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        lead.city = city;
        lead.state = locationInfo.type === 'state' ? locationInfo.name : '';
        lead.niche = niche;

        log(`Processing lead ${i + 1}/${leads.length}: ${lead.business_name}`);

        if (lead.website) {
          log(`Extracting emails from: ${lead.website}`);
          lead.email = await extractEmails(lead.website);

          if (lead.email) {
            log(`Verifying email: ${lead.email}`);
            lead.email_status = await verifyEmail(lead.email);
            log(`Email status: ${lead.email_status}`);
          } else {
            lead.email_status = 'not_found';
          }

          log(`Extracting decision maker...`);
          lead.owner_name = await extractDecisionMaker(lead.website);
          if (lead.owner_name) {
            log(`Found owner: ${lead.owner_name}`);
          }
        } else {
          lead.email_status = 'not_found';
        }

        const { score, intent_tag } = scoreLead(lead);
        lead.score = score;
        lead.intent_tag = intent_tag;

        log(`Lead scored: ${score} (${intent_tag})`);
        allLeads.push(lead);
      }

      log(`Completed city: ${city} | Total leads so far: ${allLeads.length}`);
    }
  }

  log(`\n=== All scraping complete. Total leads: ${allLeads.length} ===`);
  log(`Exporting leads to CSV...`);

  try {
    const outputPath = await exportToCsv(allLeads, CONFIG.output_file);
    log(`Export completed: ${outputPath}`);
  } catch (err) {
    log(`ERROR exporting CSV: ${err.message}`);
  }

  const highIntent = allLeads.filter(l => l.intent_tag === 'HIGH_INTENT').length;
  const medium = allLeads.filter(l => l.intent_tag === 'MEDIUM').length;
  const low = allLeads.filter(l => l.intent_tag === 'LOW').length;
  const withEmail = allLeads.filter(l => l.email).length;
  const verified = allLeads.filter(l => l.email_status === 'verified').length;

  log('\n=== SUMMARY ===');
  log(`Total Leads: ${allLeads.length}`);
  log(`HIGH_INTENT: ${highIntent}`);
  log(`MEDIUM: ${medium}`);
  log(`LOW: ${low}`);
  log(`With Email: ${withEmail}`);
  log(`Verified Emails: ${verified}`);
  log('=== Done ===');
}

main().catch(err => {
  log(`FATAL ERROR: ${err.message}`);
  process.exit(1);
});
