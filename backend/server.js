import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { nanoid } from 'nanoid';
import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';

import { scrapeGoogleMaps, enrichCSVList, filterLeadsByNiche } from './scraper.js';
import { createJob, getJob, updateJob, setStopFlag, setPauseFlag, deleteJob, loadJobsFromDisk, jobs, readCSVFromDisk, saveJobsToDisk, flushAllBuffers } from './store.js';
import { log } from './utils.js';

const app = express();
const PORT = 3001;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(bodyParser.json());

// Initialize store from disk
loadJobsFromDisk();

// =========================
// CSV PREPROCESSING HELPER
// =========================
// LeadEngine exports CSVs with section headers like "--- WITH EMAIL ---"
// before the actual column header row. This confuses csv-parser, making it
// treat the section marker as the header and returning 0 data rows.
// This function strips those markers and normalises the CSV into a clean
// single-header format before it hits csv-parser.
function preprocessLeadEngineCSV(buffer) {
  // Strip BOM if present
  let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);

  // Known section markers used by this exporter
  const SECTION_MARKERS = ['--- with email ---', '--- without email ---'];

  // Find the FIRST real header line — a line that has recognisable column names
  const HEADER_SIGNALS = ['name', 'company', 'business', 'phone', 'website', 'email'];
  let headerLine = '';
  for (const line of lines) {
    const lower = line.toLowerCase();
    const isMarker = SECTION_MARKERS.some(m => lower.includes(m));
    if (!isMarker && HEADER_SIGNALS.some(s => lower.includes(s))) {
      headerLine = line;
      break;
    }
  }

  if (!headerLine) {
    // Can't detect header — return as-is and let csv-parser try
    return buffer;
  }

  const output = [headerLine];
  const headerLower = headerLine.toLowerCase().trim();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;                                              // skip blank lines
    const lower = trimmed.toLowerCase();
    if (SECTION_MARKERS.some(m => lower.includes(m))) continue;         // skip section markers
    if (lower === headerLower) continue;                                 // skip duplicate headers
    if (trimmed === headerLine) continue;                                // exact duplicate
    if (lower.startsWith('"---') || lower.startsWith('---')) continue;  // catch any other markers
    output.push(line);
  }

  return Buffer.from(output.join('\n'), 'utf8');
}

// Case-insensitive column lookup — handles minor CSV header variations
function col(data, ...keys) {
  // Build a lowercase key map once
  const map = {};
  for (const k of Object.keys(data)) map[k.toLowerCase().trim()] = data[k];
  for (const k of keys) {
    const v = data[k] || map[k.toLowerCase().trim()];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function parseLead(data) {
  return {
    business_name : col(data, 'Name', 'Company Name', 'Business Name', 'Company', 'business_name'),
    phone         : col(data, 'Phone', 'Phone number', 'phone'),
    website       : col(data, 'Website', 'website'),
    primary_email : col(data, 'Primary Email', 'Email', 'email', 'primary_email'),
    rating        : col(data, 'Rating', 'rating'),
    reviews       : col(data, 'Reviews', 'Review', 'reviews'),
    intent        : col(data, 'Intent', 'intent'),
    score         : col(data, 'Lead Score', 'score'),
    city          : col(data, 'City', 'city'),
    address       : col(data, 'Address', 'address'),
    category      : col(data, 'Category', 'category'),
    niche         : col(data, 'Niche', 'niche'),
  };
}

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

  const cleanBuffer = preprocessLeadEngineCSV(req.file.buffer);
  const bufferStream = new stream.PassThrough();
  bufferStream.end(cleanBuffer);

  bufferStream
    .pipe(csvParser())
    .on('data', (data) => {
       const lead = parseLead(data);
       if (lead.business_name) leads.push(lead);
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
// CSV NICHE FILTER
// =========================
app.post('/filter-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.body.niche) return res.status(400).json({ error: 'Niche is required' });

  const niche = req.body.niche.trim();
  const workers = parseInt(req.body.workers) || 3;
  const jobId = nanoid();
  const leads = [];

  const cleanBuffer = preprocessLeadEngineCSV(req.file.buffer);
  const bufferStream = new stream.PassThrough();
  bufferStream.end(cleanBuffer);

  bufferStream
    .pipe(csvParser())
    .on('data', (data) => {
       const lead = parseLead(data);
       if (lead.business_name) leads.push(lead);
    })
    .on('end', () => {
       createJob(jobId, {
         niche,
         location: 'CSV Filter',
         filterType: 'all',
         status: 'running',
         progress: 0,
         leads: [],
         logs: [],
         currentCity: 'Starting filter...',
         createdAt: new Date(),
         stopFlag: false,
         filterMode: true,
         totalInput: leads.length,
       });

       log(`🔍 CSV Filter started: "${niche}" on ${leads.length} leads`, jobId);

       filterLeadsByNiche(leads, niche, jobId, workers, (progressData) => {
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
       }).then(({ passed, rejected }) => {
         const job = getJob(jobId);
         if (!job) return;
         updateJob(jobId, {
           leads: passed,
           status: job.stopFlag ? 'cancelled' : 'completed',
           progress: 100,
           stats: {
             total: passed.length,
             rejected: rejected.length,
             highIntent: passed.filter(l => l.intent === 'HIGH').length,
             mediumIntent: passed.filter(l => l.intent === 'MEDIUM').length,
             lowIntent: passed.filter(l => l.intent === 'LOW').length,
           }
         });
         saveJobsToDisk();
         log(`✅ Filter done: ${passed.length} kept, ${rejected.length} removed`, jobId);
       }).catch(err => {
         log(`❌ Filter error: ${err.message}`, jobId);
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
        saveJobsToDisk(); // Force-save immediately on cancel
        return;
      }

      updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stats
      });

      saveJobsToDisk(); // Force-save immediately on completion
      log(`✅ Completed: ${job.leads.length} leads`, jobId);

    } catch (err) {
      log(`❌ Error: ${err.message}`, jobId);

      const job = getJob(jobId);
      if (job) {
        updateJob(jobId, {
          status: 'failed',
          error: err.message
        });
        saveJobsToDisk(); // Force-save immediately on failure too
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
// CSV EXPORT (BULLETPROOF — never fails if leads exist)
// =========================
app.get('/csv/:id', (req, res) => {
  const job = getJob(req.params.id);

  // --- Path 1: Job is in memory and has leads (normal path) ---
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
    res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id}.csv"`);
    return res.send(csvContent);
  }

  // --- Path 2: Job fell out of memory (server restarted) — serve the disk CSV file ---
  const diskCSV = readCSVFromDisk(req.params.id);
  if (diskCSV) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id}.csv"`);
    return res.send(diskCSV);
  }

  // --- Path 3: Nothing found anywhere ---
  return res.status(404).json({ error: 'No leads found. The job may have been deleted or never produced any data.' });
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
  // Immediately flush any buffered leads so they’re in the CSV before download
  flushAllBuffers();
  saveJobsToDisk();
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