import { createObjectCsvWriter } from 'csv-writer';

// =========================
// EXPORT TO CSV (FINAL)
// =========================
export async function exportToCsv(leads, path = 'leads.csv', niche = '') {
  if (!Array.isArray(leads) || leads.length === 0) {
    console.log('⚠️ No leads to export');
    return path;
  }

  // =========================
  // NORMALIZE DATA
  // =========================
  const normalized = leads.map(l => ({
    business_name: l.business_name || '',
    owner_name: l.owner_name || '',
    owner_role: l.owner_role || '',
    primary_email: l.primary_email || '',
    secondary_emails: l.secondary_emails || '',
    phone: cleanPhone(l.phone),
    website: l.website || '',
    city: l.city || '',
    niche: niche || l.niche || '',
    rating: l.rating || '',
    reviews: l.reviews || '',
    intent: l.intent || '',
    score: l.score || '',
    website_quality: l.website_quality || ''
  }));

  // =========================
  // CSV WRITER
  // =========================
  const csvWriter = createObjectCsvWriter({
    path,
    header: [
      { id: 'business_name', title: 'Name' },
      { id: 'owner_name', title: 'Owner Name' },
      { id: 'owner_role', title: 'Owner Role' },
      { id: 'primary_email', title: 'Primary Email' },
      { id: 'secondary_emails', title: 'Secondary Emails' },
      { id: 'phone', title: 'Phone' },
      { id: 'website', title: 'Website' },
      { id: 'city', title: 'City' },
      { id: 'niche', title: 'Niche' },
      { id: 'rating', title: 'Rating' },
      { id: 'reviews', title: 'Reviews' },
      { id: 'intent', title: 'Intent' },
      { id: 'score', title: 'Lead Score' },
      { id: 'website_quality', title: 'Website Quality' }
    ]
  });

  await csvWriter.writeRecords(normalized);

  console.log(`📁 CSV Exported: ${path} (${normalized.length} leads)`);

  return path;
}

// =========================
// HELPERS
// =========================
function cleanPhone(phone) {
  if (!phone) return '';
  return phone.replace(/[^\d+]/g, '');
}