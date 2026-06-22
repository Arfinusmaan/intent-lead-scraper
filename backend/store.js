import fs from 'fs';
import path from 'path';

const jobs = new Map();

// Debounce timers for CSV rewrites — prevents disk hammering when many
// enrichments fire back-to-back (one rewrite after 500ms idle)
const csvDebounceTimers = new Map();

function debouncedRewriteCSV(id, leads, niche) {
  if (csvDebounceTimers.has(id)) {
    clearTimeout(csvDebounceTimers.get(id));
  }
  const timer = setTimeout(() => {
    rewriteCSV(id, leads, niche);
    csvDebounceTimers.delete(id);
  }, 500);
  csvDebounceTimers.set(id, timer);
}

const appendBuffers = new Map();

function appendToCSV(id, newLeads, niche) {
  if (newLeads.length === 0) return;
  
  if (!appendBuffers.has(id)) {
      appendBuffers.set(id, { leads: [], timer: null });
  }
  
  const buffer = appendBuffers.get(id);
  buffer.leads.push(...newLeads);
  
  // Flush if buffer is large, or set a timer to flush when idle
  if (buffer.leads.length >= 50) {
      flushAppendBuffer(id, niche);
  } else if (!buffer.timer) {
      buffer.timer = setTimeout(() => flushAppendBuffer(id, niche), 1000);
  }
}

function flushAppendBuffer(id, niche) {
  const buffer = appendBuffers.get(id);
  if (!buffer || buffer.leads.length === 0) return;
  
  if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
  }
  
  const leadsToFlush = [...buffer.leads];
  buffer.leads = [];
  
  const dir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const file = path.join(dir, `leads-${id}.csv`);
  
  if (!fs.existsSync(file)) {
    const headers = `"Name","Phone","Website","Primary Email","Rating","Reviews","Intent","Lead Score","Website Quality","City","Niche"\n`;
    fs.writeFileSync(file, headers);
  }
  
  const rows = leadsToFlush.map(l => [
    l.business_name || '',
    l.phone || '',
    l.website || '',
    l.primary_email || '',
    l.rating || '',
    l.reviews || '',
    l.intent || '',
    l.score || '',
    l.website_quality || '',
    l.city || '',
    niche || ''
  ].map(f => `"${String(f).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  
  fs.appendFileSync(file, rows);
}

// =========================
// REWRITE FULL CSV (for enrichment updates)
// Called when a background worker updates an existing lead
// =========================
function rewriteCSV(id, leads, niche) {
  if (!leads || leads.length === 0) return;
  const dir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `leads-${id}.csv`);
  const headers = `"Name","Phone","Website","Primary Email","Rating","Reviews","Intent","Lead Score","Website Quality","City","Niche"\n`;

  const rows = leads.map(l => [
    l.business_name || '',
    l.phone || '',
    l.website || '',
    l.primary_email || '',
    l.rating || '',
    l.reviews || '',
    l.intent || '',
    l.score || '',
    l.website_quality || '',
    l.city || '',
    niche || ''
  ].map(f => `"${String(f).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';

  try {
    fs.writeFileSync(file, headers + rows);
  } catch (e) {
    console.log(`⚠️ CSV rewrite failed: ${e.message}`);
  }
}

// =========================
// CREATE JOB
// =========================
export function createJob(id, data = {}) {
  jobs.set(id, {
    id,

    niche: '',
    location: '',
    filterType: 'all',

    status: 'running',
    progress: 0,
    currentCity: '',

    leads: [],
    stats: {},

    logs: [],

    stopFlag: false,
    pauseFlag: false,
    cancelled: false,

    createdAt: new Date(),

    ...data
  });
}

// =========================
// CONTROL FLAGS
// =========================
export function setStopFlag(id, value = true) {
  const job = jobs.get(id);
  if (job) {
    job.stopFlag = value;
    job.cancelled = value;
  }
  return job;
}

export function setPauseFlag(id, value = true) {
  const job = jobs.get(id);
  if (job) {
    job.pauseFlag = value;
  }
  return job;
}

// =========================
// GET JOB
// =========================
export function getJob(id) {
  return jobs.get(id);
}

// =========================
// UPDATE JOB (SAFE)
// =========================
export function updateJob(id, updates = {}) {
  const job = jobs.get(id);
  if (!job) return null;

  // =========================
  // SAFE PROGRESS
  // =========================
  if (typeof updates.progress === 'number') {
    updates.progress = Math.max(job.progress, updates.progress);
  }

  // =========================
  // SAFE LEADS MERGE
  // Block new leads if stopped — but still allow enrichment and log updates
  // =========================
  if (job.stopFlag && updates.leads) {
    delete updates.leads; // Drop new leads silently when stopped
  }

  if (updates.leads && Array.isArray(updates.leads)) {
    const existingNames = new Set(
      job.leads.map(l => l.business_name.trim().toLowerCase())
    );
    const existingPhones = new Set(
      job.leads.map(l => l.phone ? l.phone.replace(/[^\d]/g, '') : '').filter(Boolean)
    );
    const existingWebsites = new Set(
      job.leads.map(l => {
        try {
          if (!l.website) return '';
          const host = new URL(l.website).hostname.toLowerCase();
          return host.replace('www.', '');
        } catch {
          return l.website.trim().toLowerCase().replace('www.', '');
        }
      }).filter(Boolean)
    );

    const isSharedPlatform = (domain) => {
      const shared = [
        'facebook.com', 'instagram.com', 'yelp.com', 'google.com', 'twitter.com', 
        'linkedin.com', 'youtube.com', 'manta.com', 'yellowpages.com', 'foursquare.com',
        'mapquest.com', 'tripadvisor.com', 'groupon.com', 'angis.com', 'homeadvisor.com'
      ];
      return shared.some(s => domain.includes(s));
    };

    const newLeads = updates.leads.filter(l => {
      const nameKey = l.business_name.trim().toLowerCase();
      if (existingNames.has(nameKey)) return false;

      const phoneClean = l.phone ? l.phone.replace(/[^\d]/g, '') : '';
      if (phoneClean && existingPhones.has(phoneClean)) return false;

      let websiteClean = '';
      if (l.website) {
        try {
          websiteClean = new URL(l.website).hostname.toLowerCase().replace('www.', '');
        } catch {
          websiteClean = l.website.trim().toLowerCase().replace('www.', '');
        }
      }
      if (websiteClean && existingWebsites.has(websiteClean) && !isSharedPlatform(websiteClean)) return false;

      existingNames.add(nameKey);
      if (phoneClean) existingPhones.add(phoneClean);
      if (websiteClean) websiteClean && existingWebsites.add(websiteClean);
      return true;
    });

    job.leads.push(...newLeads);
    
    // Auto-save immediately to disk
    appendToCSV(id, newLeads, job.niche);
    
    delete updates.leads;
  }

  // =========================
  // ENRICH EXISTING LEAD (from background worker)
  // Background workers call updateJob(id, { enrichLead: {...} })
  // We find the lead by business_name and merge new fields in.
  // =========================
  if (updates.enrichLead) {
    const enriched = updates.enrichLead;
    const key = enriched.business_name.trim().toLowerCase();
    const idx = job.leads.findIndex(l =>
      l.business_name.trim().toLowerCase() === key
    );
    if (idx !== -1) {
      if (enriched.isRejected) {
        job.leads.splice(idx, 1);
        debouncedRewriteCSV(id, job.leads, job.niche);
      } else {
        if (enriched.primary_email)    job.leads[idx].primary_email    = enriched.primary_email;
        if (enriched.intent)           job.leads[idx].intent           = enriched.intent;
        if (enriched.score !== undefined) job.leads[idx].score         = enriched.score;

        // Debounced rewrite — waits 500ms after last enrichment before hitting disk
        debouncedRewriteCSV(id, job.leads, job.niche);
      }
    }
    delete updates.enrichLead;
  }

  // =========================
  // APPLY UPDATES
  // =========================
  Object.assign(job, updates);

  return job;
}

// =========================
// PERSISTENCE LOGIC
// =========================
const DB_FILE = path.join(process.cwd(), 'exports', 'jobs_db.json');

export function loadJobsFromDisk() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      for (const [id, job] of Object.entries(data)) {
        // Mark as not running on fresh boot
        if (job.status === 'running' || job.pauseFlag) {
           job.status = 'stopped';
           job.pauseFlag = false;
           job.workerRunning = false;
        }
        jobs.set(id, job);
      }
      console.log(`💾 Loaded ${jobs.size} jobs from disk.`);
    } catch (err) {
      console.error(`⚠️ Failed to load jobs DB:`, err.message);
    }
  }
}

export function saveJobsToDisk() {
  const dir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    const dataToSave = {};
    for (const [id, job] of jobs.entries()) {
      if (job.pinned) dataToSave[id] = job;
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (err) {
    // silently fail to not spam logs
  }
}

// Auto-save every 10 seconds
setInterval(() => {
  if (jobs.size > 0) saveJobsToDisk();
}, 10000);

// Auto-cleanup unpinned memory after 4 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    // Keep pinned jobs or currently running jobs
    if (job.pinned || job.status === 'running' || job.pauseFlag) continue;
    
    // Delete jobs older than 4 hours
    const age = now - new Date(job.createdAt).getTime();
    if (age > 4 * 60 * 60 * 1000) {
      jobs.delete(id);
      // optionally delete the CSV to save space, but maybe let them keep the file if they know the ID, 
      // or we can auto-delete the unpinned CSV, user requested "not to save all the leads" meaning don't keep them forever securely
      const file = path.join(process.cwd(), 'exports', `leads-${id}.csv`);
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (e) {}
      }
      console.log(`🧹 Cleaned unpinned old job ${id}`);
    }
  }
}, 10 * 60 * 1000);

// =========================
// DELETE JOB
// =========================
export function deleteJob(id) {
  jobs.delete(id);
  const file = path.join(process.cwd(), 'exports', `leads-${id}.csv`);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (e) {}
  }
  saveJobsToDisk();
}

// =========================
// EXPORT
// =========================
export { jobs };