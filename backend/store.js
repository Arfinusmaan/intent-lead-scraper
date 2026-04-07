const jobs = new Map();

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