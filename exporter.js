import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';
import { log } from './utils.js';

export async function exportToCsv(leads, outputPath = './leads.csv') {
  const resolvedPath = path.resolve(outputPath);

  const csvWriter = createObjectCsvWriter({
    path: resolvedPath,
    header: [
      { id: 'business_name', title: 'Name' },
      { id: 'owner_name',    title: 'Owner' },
      { id: 'email',         title: 'Email' },
      { id: 'email_status',  title: 'Email Status' },
      { id: 'phone',         title: 'Phone' },
      { id: 'website',       title: 'Website' },
      { id: 'city',          title: 'City' },
      { id: 'state',         title: 'State' },
      { id: 'niche',         title: 'Niche' },
      { id: 'rating',        title: 'Rating' },
      { id: 'reviews',       title: 'Reviews' },
      { id: 'intent_tag',    title: 'Intent' },
      { id: 'score',         title: 'Score' },
    ],
  });

  const sanitizedLeads = leads.map(lead => ({
    business_name: sanitize(lead.business_name),
    owner_name:    sanitize(lead.owner_name),
    email:         sanitize(lead.email),
    email_status:  sanitize(lead.email_status),
    phone:         sanitize(lead.phone),
    website:       sanitize(lead.website),
    city:          sanitize(lead.city),
    state:         sanitize(lead.state),
    niche:         sanitize(lead.niche),
    rating:        lead.rating !== undefined && lead.rating !== '' ? lead.rating : '',
    reviews:       lead.reviews !== undefined ? lead.reviews : 0,
    intent_tag:    sanitize(lead.intent_tag),
    score:         lead.score !== undefined ? lead.score : 0,
  }));

  await csvWriter.writeRecords(sanitizedLeads);
  log(`Export completed: ${sanitizedLeads.length} leads written to ${resolvedPath}`);
  return resolvedPath;
}

function sanitize(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r?\n/g, ' ').trim();
}
