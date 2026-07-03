import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { nanoid } from 'nanoid';
import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import fs from 'fs';

import { scrapeGoogleMaps, enrichCSVList } from './scraper.js';
import { createJob, getJob, updateJob, setStopFlag, setPauseFlag, deleteJob, loadJobsFromDisk, jobs, getCSVFilePath } from './store.js';
import { log } from './utils.js';

const app = express();
const PORT = 3001;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(bodyParser.json());

// Initialize store from disk
loadJobsFromDisk();

// =========================
// CSV UPLOAD & ENRICHMENT
// =========================
app.post('/upload-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const mode = req.body.mode || 'hybrid';
  const workers = req.body.workers || 3;
  const negativeKeywords = req.body.negativeKeywords || '';
  const jobId = nanoid();
  const leads = [];

  const bufferStream = new stream.PassThrough();
  bufferStream.end(req.file.buffer);

  bufferStream
    .pipe(csvParser())
    .on('data', (data) => {
       const lead = {
         business_name: data['Company Name'] || data.Company || data.Name || data.business_name || '',
         phone: data['Phone number'] || data.Phone || data.phone || '',
         website: data.website || data.Website || '',
         primary_email: data['Primary Email'] || data.primary_email || '',
         rating: data.Rating || data.rating || '',
         reviews: data.Review || data.Reviews || data.reviews || '',
         intent: data.Intent || data.intent || 'LOW',
         city: data.City || data.city || '',
       };
       leads.push(lead);
    })
    .on('end', () => {
       createJob(jobId, {
         niche: 'CSV Upload',
         location: 'Multiple',
         filterType: 'all',
         negativeKeywords,
         status: 'running',
         progress: 0,
         leads: leads,
         logs: [],
         currentCity: 'Parsing',
         createdAt: new Date(),
         stopFlag: false
       });
       
       log(`🚀 Started: CSV Enrichment for ${leads.length} leads`, jobId);
       
       enrichCSVList(leads, jobId, workers, negativeKeywords, (progressData) => {
          const job = getJob(jobId);
          if (!job || job.stopFlag) return;
          if (typeof progressData === 'number') {
            updateJob(jobId, { progress: progressData });
          } else {
            updateJob(jobId, {
              progress: progressData.progress ?? job.progress,
              currentCity: progressData.city ?? job.currentCity
            });
          }
       }).then(() => {
          const job = getJob(jobId);
          if (!job) return;
          const highIntent = job.leads.filter(l => l.intent === 'HIGH').length;
          const mediumIntent = job.leads.filter(l => l.intent === 'MEDIUM').length;
          const lowIntent = job.leads.filter(l => l.intent === 'LOW').length;
          const stats = { highIntent, mediumIntent, lowIntent, total: job.leads.length };
          updateJob(jobId, { status: job.stopFlag ? 'cancelled' : 'completed', progress: 100, stats });
       }).catch(err => {
          log(`❌ Error: ${err.message}`, jobId);
          updateJob(jobId, { status: 'failed', error: err.message });
       });

       res.json({ jobId });
    });
});

// =========================
// START SCRAPE
// =========================
app.post('/scrape', async (req, res) => {
  const { niche, location, filterType = 'all', mode = 'hybrid', workers = 3, negativeKeywords = '' } = req.body;

  const jobId = nanoid();

  createJob(jobId, {
    niche,
    location,
    filterType,
    negativeKeywords,
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
        negativeKeywords,
        jobId,
        mode,
        workers,
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

      // Compute stats regardless of stop state — needed for CSV download
      const highIntent   = job.leads.filter(l => l.intent === 'HIGH').length;
      const mediumIntent = job.leads.filter(l => l.intent === 'MEDIUM').length;
      const lowIntent    = job.leads.filter(l => l.intent === 'LOW').length;
      const stats = { highIntent, mediumIntent, lowIntent, total: job.leads.length };

      if (job.stopFlag) {
        // Keep status as 'cancelled' — don't overwrite what the /stop endpoint set
        log(`🛑 Cancelled with ${job.leads.length} leads collected`, jobId);
        updateJob(jobId, { stats });
        return;
      }

      updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stats
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
// CSV EXPORT — BULLETPROOF (falls back to disk file if job not in memory)
// =========================
app.get('/csv/:id', (req, res) => {
  const id = req.params.id;
  const job = getJob(id);

  // ✅ PRIMARY PATH: job is in memory and has leads
  if (job && job.leads && job.leads.length > 0) {
    const headers = `"Name","Phone","Website","Primary Email","Rating","Reviews","Intent","Lead Score","Website Quality","City","Niche"\n`;

    const formatRow = (l) => [
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
      job.niche || ''
    ].map(f => `"${String(f).replace(/"/g, '""')}"`).join(',');

    const withEmail = job.leads.filter(l => l.primary_email);
    const withoutEmail = job.leads.filter(l => !l.primary_email);

    let csvContent = "";
    if (withEmail.length > 0) {
        csvContent += `"--- WITH EMAIL ---"\n` + headers + withEmail.map(formatRow).join('\n') + '\n\n';
    }
    if (withoutEmail.length > 0) {
        csvContent += `"--- WITHOUT EMAIL ---"\n` + headers + withoutEmail.map(formatRow).join('\n') + '\n';
    }
    if (!csvContent) csvContent = headers + job.leads.map(formatRow).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${id}.csv"`);
    return res.send(csvContent);
  }

  // ✅ FALLBACK PATH: job not in memory — stream pre-written CSV file from disk
  // This saves the day after server restarts, crashes, or memory eviction.
  const csvFile = getCSVFilePath(id);
  if (fs.existsSync(csvFile)) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${id}.csv"`);
    return res.sendFile(csvFile);
  }

  return res.status(404).json({ error: 'No data found. The job may have expired or never ran.' });
});

// =========================
// CHECK IF CSV FILE EXISTS ON DISK
// (Used by frontend to show a "Saved to disk" badge)
// =========================
app.get('/csv-exists/:id', (req, res) => {
  const csvFile = getCSVFilePath(req.params.id);
  res.json({ exists: fs.existsSync(csvFile) });
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
      pinned: j.pinned || false,
      highIntent: j.stats?.highIntent || 0,
      mediumIntent: j.stats?.mediumIntent || 0,
      lowIntent: j.stats?.lowIntent || 0
    }))
  );
});

// =========================
// STOP
// =========================
// =========================
// STOP
// =========================
app.post('/stop/:id', (req, res) => {
  const jobId = req.params.id;
  setStopFlag(jobId, true);
  updateJob(jobId, { status: 'cancelled', cancelled: true });
  log(`🛑 Stop requested`, jobId);
  res.json({ status: 'stopping' });
});

// =========================
// PAUSE / RESUME
// =========================
app.post('/pause/:id', (req, res) => {
  setPauseFlag(req.params.id, true);
  log(`⏸️ Paused`, req.params.id);
  res.json({ status: 'paused' });
});

app.post('/resume/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  
  setPauseFlag(req.params.id, false);
  updateJob(req.params.id, { status: 'running' });
  log(`▶️ Resumed`, req.params.id);
  
  // Dead Resume: Server restarted and Playwright is gone. Restart it.
  if (job.workerRunning === false && job.niche !== 'CSV Upload') {
     job.workerRunning = true;
     // Re-trigger background async scrape, it will pick up from job.lastCityIndex
     (async () => {
        try {
          await scrapeGoogleMaps(
            job.niche,
            job.location,
            job.filterType,
            job.negativeKeywords || '',
            job.id,
            job.mode || 'hybrid',
            job.workers || 3,
            (progressData) => {
              const currentJob = getJob(job.id);
              if (!currentJob || currentJob.stopFlag) return;
              if (typeof progressData === 'number') {
                updateJob(job.id, { progress: progressData });
              } else {
                updateJob(job.id, {
                  progress: progressData.progress ?? currentJob.progress,
                  currentCity: progressData.city ?? currentJob.currentCity
                });
                if (progressData.leads && Array.isArray(progressData.leads)) {
                  progressData.leads.forEach(lead => updateJob(job.id, { leads: [lead] }));
                }
              }
            }
          );
          
          const finalJob = getJob(job.id);
          if (!finalJob) return;
          const highIntent   = finalJob.leads.filter(l => l.intent === 'HIGH').length;
          const mediumIntent = finalJob.leads.filter(l => l.intent === 'MEDIUM').length;
          const lowIntent    = finalJob.leads.filter(l => l.intent === 'LOW').length;
          const stats = { highIntent, mediumIntent, lowIntent, total: finalJob.leads.length };

          if (finalJob.stopFlag) {
            updateJob(job.id, { stats, workerRunning: false });
            return;
          }
          updateJob(job.id, { status: 'completed', progress: 100, stats, workerRunning: false });
          log(`✅ Completed Resumed Scan`, job.id);
        } catch (err) {
          log(`❌ Error Resuming: ${err.message}`, job.id);
          updateJob(job.id, { status: 'failed', error: err.message, workerRunning: false });
        }
     })();
  }
  
  res.json({ status: 'resumed' });
});

app.delete('/job/:id', (req, res) => {
  const jobId = req.params.id;
  deleteJob(jobId);
  res.json({ success: true });
});

// =========================
// PIN JOB
// =========================
app.post('/pin/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  
  updateJob(req.params.id, { pinned: !job.pinned });
  res.json({ success: true, pinned: !job.pinned });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
});