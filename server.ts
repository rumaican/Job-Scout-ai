import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from "@google/genai";
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

dotenv.config();

// --- Configuration ---
const PORT = 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// --- Setup ---
const app = express();
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type "${file.mimetype}". Please upload a PDF or DOCX.`));
    }
  },
});

app.use(cors({ origin: ALLOWED_ORIGIN }) as any);
app.use(express.json() as any);

// --- GenAI Client ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- SSE Job Store ---
type ProgressEvent = {
  type: 'progress' | 'result' | 'error';
  message?: string;
  percent?: number;
  data?: any;
};

type JobState = {
  listeners: Array<(event: ProgressEvent) => void>;
  done: boolean;
};

const jobStore = new Map<string, JobState>();

function createJob(): string {
  const jobId = uuidv4();
  jobStore.set(jobId, { listeners: [], done: false });
  // Clean up after 30 minutes
  setTimeout(() => jobStore.delete(jobId), 30 * 60 * 1000);
  return jobId;
}

function emitProgress(jobId: string, event: ProgressEvent): void {
  const job = jobStore.get(jobId);
  if (!job) return;
  for (const listener of job.listeners) {
    listener(event);
  }
  if (event.type === 'result' || event.type === 'error') {
    job.done = true;
  }
}

// --- Helpers ---

// 1. Text Extraction
async function extractText(filePath: string, mimeType: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  try {
    if (mimeType === 'application/pdf') {
      const data = await (pdfParse as any)(buffer);
      return data.text;
    } else if (mimeType.includes('word') || mimeType.includes('officedocument')) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    return buffer.toString('utf-8');
  } catch (error) {
    console.error("Text extraction failed:", error);
    throw new Error("Failed to parse CV file.");
  }
}

// 2. Apify Interaction
async function scrapeLinkedInJobs(
  searchUrl: string,
  maxItems: number,
  jobId: string
): Promise<any[]> {
  const token = process.env.APIFY_API_TOKEN;
  const actor = process.env.APIFY_ACTOR_SLUG || "curious_coder~linkedin-jobs-scraper";

  if (!token) throw new Error("Missing Apify API Token. Set APIFY_API_TOKEN in your .env file.");

  console.log(`Starting Apify actor ${actor} for ${searchUrl}`);
  emitProgress(jobId, { type: 'progress', message: 'Starting LinkedIn job scraper...', percent: 15 });

  // Start the run
  const startRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: [{ url: searchUrl }],
      maxItems: Math.min(maxItems, 100),
      limit: Math.min(maxItems, 100)
    })
  });

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Apify start failed: ${err}`);
  }

  const runData = await startRes.json() as any;
  const runId = runData.data.id;
  const defaultDatasetId = runData.data.defaultDatasetId;

  console.log(`Apify run started: ${runId}, polling for completion...`);
  emitProgress(jobId, { type: 'progress', message: `Scraper started (run ${runId}). Waiting for results...`, percent: 20 });

  // Poll for completion — percent climbs from 20 → 42 during polling
  let status = 'RUNNING';
  let pollCount = 0;
  const MAX_POLLS = 60; // 5 minutes max (60 × 5s)

  while ((status === 'RUNNING' || status === 'READY') && pollCount < MAX_POLLS) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs/${runId}?token=${token}`);
    const pollData = await pollRes.json() as any;
    status = pollData.data.status;
    pollCount++;

    const pollPercent = Math.min(20 + Math.floor(pollCount * (22 / MAX_POLLS)), 42);
    const elapsed = pollCount * 5;
    console.log(`Run status: ${status} (${elapsed}s elapsed)`);
    emitProgress(jobId, {
      type: 'progress',
      message: `Scraper running... ${elapsed}s elapsed (status: ${status})`,
      percent: pollPercent
    });
  }

  if (pollCount >= MAX_POLLS && status !== 'SUCCEEDED') {
    throw new Error('Scraper timed out after 5 minutes.');
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run failed with status: ${status}`);
  }

  emitProgress(jobId, { type: 'progress', message: 'Scraping complete. Fetching results...', percent: 43 });

  // Fetch items
  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${token}&limit=100`);
  const items = await itemsRes.json() as any[];
  return items;
}

// 3. Normalize Data
function normalizeJobData(rawJob: any): any {
  return {
    jobId: rawJob.id || rawJob.jobId || uuidv4(),
    companyName: rawJob.companyName || rawJob.company || "Unknown Company",
    companyLogo: rawJob.companyLogo || rawJob.logo || null,
    jobTitle: rawJob.title || rawJob.jobTitle || "Untitled Role",
    jobUrl: rawJob.url || rawJob.jobUrl || "",
    applyUrl: rawJob.applyUrl || rawJob.url || "",
    description: rawJob.description || rawJob.text || "",
    scrapedAt: rawJob.postedAt || new Date().toISOString().split('T')[0]
  };
}

// 4. Gemini Analysis
async function analyzeCvAndJobs(cvText: string, jobs: any[], threshold: number, jobId: string) {
  // A. Parse CV
  console.log("Parsing CV with Gemini...");
  emitProgress(jobId, { type: 'progress', message: 'Analysing your CV with AI...', percent: 47 });

  const cvPrompt = `
    Extract the following from this CV text:
    1. A list of top technical/professional skills (array of strings).
    2. A brief profile summary (string).
    3. Three key experience highlights (array of strings).

    CV TEXT:
    ${cvText.substring(0, 10000)}
  `;

  const cvResponse = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: cvPrompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          skills: { type: Type.ARRAY, items: { type: Type.STRING } },
          profileSummary: { type: Type.STRING },
          experienceHighlights: { type: Type.ARRAY, items: { type: Type.STRING } }
        }
      }
    }
  });

  const cvData = JSON.parse(cvResponse.text);
  emitProgress(jobId, { type: 'progress', message: `CV analysed. Found ${cvData.skills.length} skills. Now scoring ${jobs.length} jobs...`, percent: 55 });

  // B. Score Jobs in chunks of 5 with concurrency
  console.log(`Scoring ${jobs.length} jobs...`);

  const scoredJobs: any[] = [];
  const chunkSize = 5;
  const totalChunks = Math.ceil(jobs.length / chunkSize);

  const createScoringPrompt = (job: any) => `
    You are a recruiter. Compare this candidate's profile to the job description.

    CANDIDATE SKILLS: ${JSON.stringify(cvData.skills)}
    CANDIDATE SUMMARY: ${cvData.profileSummary}

    JOB TITLE: ${job.jobTitle}
    JOB DESCRIPTION: ${job.description.substring(0, 3000)}

    Rubric:
    - 90-100: Perfect match (skills, seniority, industry).
    - 70-89: Good match (missing minor skills).
    - 50-69: Potential match (transferable skills).
    - <50: Poor match.

    Return JSON:
    {
      "score": number (0-100),
      "verdict": string (2-4 sentences explaining the score)
    }
  `;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const chunk = jobs.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
    const jobsProcessed = chunkIndex * chunkSize;
    const jobsRemaining = jobs.length - jobsProcessed;

    // Scoring progress: 55% → 92%
    const scorePercent = Math.round(55 + ((chunkIndex / totalChunks) * 37));
    emitProgress(jobId, {
      type: 'progress',
      message: `Scoring jobs ${jobsProcessed + 1}–${Math.min(jobsProcessed + chunkSize, jobs.length)} of ${jobs.length}...`,
      percent: scorePercent
    });

    const promises = chunk.map(async (job: any) => {
      try {
        const resp = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: createScoringPrompt(job),
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                score: { type: Type.NUMBER },
                verdict: { type: Type.STRING }
              }
            }
          }
        });
        const result = JSON.parse(resp.text);
        if (result.score >= threshold) {
          return { ...job, ...result };
        }
        return null;
      } catch (e) {
        console.error(`Failed to score job ${job.jobId}`, e);
        return null;
      }
    });

    const results = await Promise.all(promises);
    scoredJobs.push(...results.filter(r => r !== null));
  }

  return {
    ...cvData,
    jobs: scoredJobs.sort((a, b) => b.score - a.score)
  };
}

// --- Endpoints ---

// SSE progress stream
app.get('/api/progress/:jobId', (req: any, res: any) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // If already done (client reconnected after completion), nothing to stream
  if (job.done) {
    res.end();
    return;
  }

  const sendEvent = (event: ProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'result' || event.type === 'error') {
      res.end();
    }
  };

  job.listeners.push(sendEvent);

  req.on('close', () => {
    const idx = job.listeners.indexOf(sendEvent);
    if (idx !== -1) job.listeners.splice(idx, 1);
  });
});

// Analyze endpoint — returns jobId immediately, processes in background
app.post('/api/analyze', upload.single('cvFile') as any, async (req: any, res: any) => {
  const file = req.file;
  const { searchUrl, maxJobs, scoreThreshold } = req.body;

  if (!file) return res.status(400).json({ error: "No CV file uploaded." });

  const jobId = createJob();
  res.json({ jobId });

  // Background processing
  (async () => {
    try {
      // Step 1: Extract CV text
      emitProgress(jobId, { type: 'progress', message: 'Extracting text from your CV...', percent: 5 });
      const cvText = await extractText(file.path, file.mimetype);
      emitProgress(jobId, { type: 'progress', message: 'CV text extracted successfully.', percent: 10 });

      // Step 2: Scrape jobs
      const rawJobs = await scrapeLinkedInJobs(
        searchUrl,
        parseInt(maxJobs) || 50,
        jobId
      );
      const normalizedJobs = rawJobs.map(normalizeJobData);
      emitProgress(jobId, { type: 'progress', message: `Found ${normalizedJobs.length} jobs. Starting AI analysis...`, percent: 45 });

      // Step 3: Analyse
      const analysisResult = await analyzeCvAndJobs(
        cvText,
        normalizedJobs,
        parseInt(scoreThreshold) || 60,
        jobId
      );

      // Cleanup input file
      fs.unlinkSync(file.path);

      emitProgress(jobId, { type: 'progress', message: `Done! Found ${analysisResult.jobs.length} matching jobs.`, percent: 100 });
      emitProgress(jobId, { type: 'result', data: analysisResult });

    } catch (error: any) {
      console.error("Analysis Error:", error);
      if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      emitProgress(jobId, { type: 'error', message: error.message });
    }
  })();
});

app.post('/api/generate-cover', async (req: any, res: any) => {
  const { job, cvContext, applicantName } = req.body;
  const name = (applicantName || 'The Applicant').trim();

  try {
    const prompt = `
      Write a professional cover letter for the following job application.

      JOB: ${job.jobTitle} at ${job.companyName}
      JOB CONTEXT: ${job.description.substring(0, 1000)}

      APPLICANT NAME: ${name}
      APPLICANT SKILLS: ${(cvContext?.skills || []).join(', ')}
      APPLICANT EXPERIENCE: ${(cvContext?.experienceHighlights || []).join('; ')}

      Tone: Professional, concise, enthusiastic. Max 300 words.
      Structure:
      1. Hook (why this company).
      2. Relevance (skills match).
      3. Call to Action.

      Sign the letter with the applicant's name: ${name}.
      Do not use placeholder brackets like [Your Name].
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const coverLetterText = response.text;

    // Generate PDF
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    const htmlContent = `
      <html>
        <head>
          <style>
            body { font-family: Helvetica, Arial, sans-serif; line-height: 1.6; padding: 40px; color: #333; }
            h1 { font-size: 18px; margin-bottom: 20px; }
            p { margin-bottom: 15px; }
            .header { margin-bottom: 40px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="header">
            <strong>Application for ${job.jobTitle}</strong><br/>
            ${job.companyName}
          </div>
          ${coverLetterText.split('\n').map((p: string) => p.trim() ? `<p>${p}</p>` : '').join('')}
        </body>
      </html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({ format: 'A4', margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
    await browser.close();

    const safeCompany = job.companyName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cover-letter-${safeCompany}.pdf"`);
    res.send(Buffer.from(pdfBuffer));

  } catch (error: any) {
    console.error("Cover letter generation failed:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`JobScout AI server running on http://localhost:${PORT}`);
});
