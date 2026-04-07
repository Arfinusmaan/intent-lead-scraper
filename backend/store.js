const jobs = new Map();
import fs from 'fs';
import path from 'path';

function appendToCSV(id, newLeads, niche) {
  if (newLeads.length === 0) return;
  const dir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const file = path.join(dir, `leads-${id}.csv`);
  
  if (!fs.existsSync(file)) {
    const headers = `"Name","Phone","Website","Primary Email","Secondary Emails","Owner Name","Owner Role","Rating","Reviews","Intent","Lead Score","Website Quality","City","Niche"\n`;
    fs.writeFileSync(file, headers);
  }
  
  const rows = newLeads.map(l => [
    l.business_name || '',
    l.phone || '',
    l.website || '',
    l.primary_email || '',
    l.secondary_emails || '',
    l.owner_name || '',
    l.owner_role || '',
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
    cancelled: false,

    createdAt: new Date(),

    ...data
  });
}

// =========================
// STOP FLAG
// =========================
export function setStopFlag(id, value = true) {
  const job = jobs.get(id);
  if (job) {
    job.stopFlag = value;
    job.cancelled = value;
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

  // 🚫 STOP UPDATE IF CANCELLED
  if (job.stopFlag && updates.status !== 'cancelled') {
    return job;
  }

  // =========================
  // SAFE PROGRESS
  // =========================
  if (typeof updates.progress === 'number') {
    updates.progress = Math.max(job.progress, updates.progress);
  }

  // =========================
  // SAFE LEADS MERGE
  // =========================
  if (updates.leads && Array.isArray(updates.leads)) {
    const existing = new Set(
      job.leads.map(l =>
        `${l.business_name}|${l.phone}|${l.website}`.toLowerCase()
      )
    );

    const newLeads = updates.leads.filter(l => {
      const key = `${l.business_name}|${l.phone}|${l.website}`.toLowerCase();
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });

    job.leads.push(...newLeads);
    
    // Auto-save immediately efficiently mapping disk
    appendToCSV(id, newLeads, job.niche);
    
    delete updates.leads;
  }

  // =========================
  // APPLY UPDATES
  // =========================
  Object.assign(job, updates);

  return job;
}

// =========================
// AUTO CLEANUP (MEMORY SAFE)
// =========================
setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    const age = now - new Date(job.createdAt).getTime();

    // Remove jobs older than 2 hours
    if (age > 2 * 60 * 60 * 1000) {
      jobs.delete(id);
      console.log(`🧹 Cleaned job ${id}`);
    }
  }
}, 10 * 60 * 1000); // every 10 mins

// =========================
// EXPORT
// =========================
export { jobs };