import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { nanoid } from 'nanoid';

import { scrapeGoogleMaps } from './scraper.js';
import { createJob, getJob, updateJob, setStopFlag, jobs } from './store.js';
import { log } from './utils.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(bodyParser.json());

// =========================
// START SCRAPE
// =========================
app.post('/scrape', async (req, res) => {
  const { niche, location, filterType = 'all' } = req.body;

  const jobId = nanoid();

  createJob(jobId, {
    niche,
    location,
    filterType,
    status: 'running',
    progress: 0,
    leads: [],
    logs: [],
    currentCity: '',
    createdAt: new Date(),
    stopFlag: false
  });

  log(`🚀 Started: ${niche} in ${location}`, jobId);

  // ASYNC WORKER
  (async () => {
    try {
      const leads = await scrapeGoogleMaps(
        niche,
        location,
        filterType,
        jobId,
        (progressData) => {
          const job = getJob(jobId);
          if (!job || job.stopFlag) return;

          // =========================
          // PROGRESS + CITY
          // =========================
          if (typeof progressData === 'number') {
            updateJob(jobId, { progress: progressData });
          } else {
            updateJob(jobId, {
              progress: progressData.progress ?? job.progress,
              currentCity: progressData.city ?? job.currentCity
            });

            // =========================
            // 🔥 FIX: PUSH LEADS PROPERLY
            // =========================
            if (progressData.leads && Array.isArray(progressData.leads)) {
              progressData.leads.forEach(lead => {
                updateJob(jobId, { leads: [lead] });
              });
            }
          }
        }
      );

      const job = getJob(jobId);
      if (!job) return;

      // =========================
      // IF STOPPED → STILL FINALIZE
      // =========================
      if (job.stopFlag) {
        log(`🛑 Cancelled`, jobId);

        updateJob(jobId, {
          status: 'completed', // 🔥 important for download
          progress: job.progress || 100
        });

        return;
      }

      // =========================
      // STATS
      // =========================
      const highIntent = job.leads.filter(l => l.intent === 'HIGH').length;
      const mediumIntent = job.leads.filter(l => l.intent === 'MEDIUM').length;
      const lowIntent = job.leads.filter(l => l.intent === 'LOW').length;

      updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stats: {
          highIntent,
          mediumIntent,
          lowIntent,
          total: job.leads.length
        }
      });

      log(`✅ Completed: ${job.leads.length} leads`, jobId);

    } catch (err) {
      log(`❌ Error: ${err.message}`, jobId);

      const job = getJob(jobId);
      if (job) {
        updateJob(jobId, {
          status: 'failed',
          error: err.message
        });
      }
    }
  })();

  res.json({ jobId });
});

// =========================
// RESULTS
// =========================
app.get('/results/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  res.json(job);
});

// =========================
// CSV EXPORT (WORKS ALWAYS)
// =========================
app.get('/csv/:id', (req, res) => {
  const job = getJob(req.params.id);

  if (!job || !job.leads.length) {
    return res.status(400).json({ error: 'No data available' });
  }

  const headers = `"Name","Phone","Website","Primary Email","Secondary Emails","Owner Name","Owner Role","Rating","Reviews","Intent","Lead Score","Website Quality","City","Niche"\n`;

  const rows = job.leads.map(l => [
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
    job.niche || ''
  ].map(f => `"${String(f).replace(/"/g, '""')}"`).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id}.csv"`);
  res.send(headers + rows);
});

// =========================
// HISTORY
// =========================
app.get('/history', (req, res) => {
  res.json(
    Array.from(jobs.values()).map(j => ({
      id: j.id,
      niche: j.niche,
      location: j.location,
      total: j.leads.length,
      createdAt: j.createdAt,
      status: j.status,
      highIntent: j.stats?.highIntent || 0,
      mediumIntent: j.stats?.mediumIntent || 0,
      lowIntent: j.stats?.lowIntent || 0
    }))
  );
});

// =========================
// STOP
// =========================
app.post('/stop/:id', (req, res) => {
  const jobId = req.params.id;

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  setStopFlag(jobId, true);

  updateJob(jobId, {
    status: 'cancelled',
    cancelled: true
  });

  log(`🛑 Stop requested`, jobId);

  res.json({ status: 'stopping' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
});