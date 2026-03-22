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
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

dotenv.config();

// --- Configuration ---
const PORT = 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp');
const CV_CHAR_LIMIT = 50000; // ~10× the old limit; warn if exceeded

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
  cvText?: string; // retained for cover letter generation
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

// 2. Apify Interaction — wall-clock timeout via MAX_POLLS (5 min @ 5s/poll)
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
  emitProgress(jobId, { type: 'progress', message: `Scraper started. Waiting for results...`, percent: 20 });

  // Poll — percent climbs 20 → 42 over MAX_POLLS; throws on timeout
  let status = 'RUNNING';
  let pollCount = 0;
  const MAX_POLLS = 60; // 5-minute wall-clock cap (60 × 5s)

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
  // A. Parse CV — warn if truncated
  const truncated = cvText.length > CV_CHAR_LIMIT;
  const cvTextForAnalysis = truncated ? cvText.substring(0, CV_CHAR_LIMIT) : cvText;

  if (truncated) {
    emitProgress(jobId, {
      type: 'progress',
      message: `Note: CV is large (${cvText.length.toLocaleString()} chars). Analysing the first 50,000 characters.`,
      percent: 47
    });
  }

  console.log("Parsing CV with Gemini...");
  emitProgress(jobId, { type: 'progress', message: 'Analysing your CV with AI...', percent: truncated ? 49 : 47 });

  const cvPrompt = `
    Extract the following from this CV text:
    1. A list of top technical/professional skills (array of strings).
    2. A brief profile summary (string).
    3. Three key experience highlights (array of strings).

    CV TEXT:
    ${cvTextForAnalysis}
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

  // B. Batch score jobs — 10 per Gemini call (vs. 1 per call before)
  // 100 jobs = 10 API calls instead of 100
  console.log(`Scoring ${jobs.length} jobs in batches of 10...`);

  const scoredJobs: any[] = [];
  const BATCH_SIZE = 10;
  const totalBatches = Math.ceil(jobs.length / BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batch = jobs.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
    const jobsProcessed = batchIndex * BATCH_SIZE;

    // Scoring progress: 55% → 92%
    const scorePercent = Math.round(55 + (batchIndex / totalBatches) * 37);
    emitProgress(jobId, {
      type: 'progress',
      message: `Scoring jobs ${jobsProcessed + 1}–${Math.min(jobsProcessed + BATCH_SIZE, jobs.length)} of ${jobs.length}...`,
      percent: scorePercent
    });

    const batchPrompt = `
      You are a recruiter scoring job listings against a candidate profile.

      CANDIDATE SKILLS: ${JSON.stringify(cvData.skills)}
      CANDIDATE SUMMARY: ${cvData.profileSummary}

      Score each of the following ${batch.length} jobs. Return a JSON array with one entry per job,
      in the same order as the input.

      Rubric:
      - 90-100: Perfect match (skills, seniority, industry).
      - 70-89: Good match (missing minor skills).
      - 50-69: Potential match (transferable skills).
      - <50: Poor match.

      JOBS:
      ${JSON.stringify(batch.map(j => ({
        jobId: j.jobId,
        jobTitle: j.jobTitle,
        description: j.description.substring(0, 1500)
      })))}
    `;

    try {
      const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: batchPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                jobId: { type: Type.STRING },
                score: { type: Type.NUMBER },
                verdict: { type: Type.STRING }
              }
            }
          }
        }
      });

      const results: Array<{ jobId: string; score: number; verdict: string }> = JSON.parse(resp.text);

      for (const result of results) {
        const original = batch.find(j => j.jobId === result.jobId);
        if (original && result.score >= threshold) {
          scoredJobs.push({ ...original, score: result.score, verdict: result.verdict });
        }
      }
    } catch (e) {
      console.error(`Failed to score batch ${batchIndex + 1}`, e);
      // Skip failed batch rather than aborting the whole run
    }
  }

  return {
    ...cvData,
    jobs: scoredJobs.sort((a, b) => b.score - a.score)
  };
}

// 5. PDF Generation using pdfkit (replaces puppeteer / headless Chromium)
function generateCoverLetterPDF(
  coverLetterText: string,
  jobTitle: string,
  companyName: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#111').text(`Application for ${jobTitle}`);
    doc.fontSize(11).font('Helvetica').fillColor('#555').text(companyName);
    doc.moveDown(0.4);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#dddddd').stroke();
    doc.moveDown(1.5);

    // Body
    doc.fillColor('#333');
    for (const line of coverLetterText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        doc.fontSize(11).font('Helvetica').text(trimmed, { align: 'justify', lineGap: 3 });
        doc.moveDown(0.6);
      }
    }

    doc.end();
  });
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
      // Step 1: Extract CV text and cache it for cover letter generation
      emitProgress(jobId, { type: 'progress', message: 'Extracting text from your CV...', percent: 5 });
      const cvText = await extractText(file.path, file.mimetype);
      fs.unlinkSync(file.path);

      // Store full CV text in the job state so /generate-cover can use it
      const state = jobStore.get(jobId);
      if (state) state.cvText = cvText;

      emitProgress(jobId, { type: 'progress', message: 'CV text extracted successfully.', percent: 10 });

      // Step 2: Scrape jobs
      const rawJobs = await scrapeLinkedInJobs(searchUrl, parseInt(maxJobs) || 50, jobId);
      const normalizedJobs = rawJobs.map(normalizeJobData);
      emitProgress(jobId, { type: 'progress', message: `Found ${normalizedJobs.length} jobs. Starting AI analysis...`, percent: 45 });

      // Step 3: Analyse
      const analysisResult = await analyzeCvAndJobs(
        cvText,
        normalizedJobs,
        parseInt(scoreThreshold) || 60,
        jobId
      );

      emitProgress(jobId, { type: 'progress', message: `Done! Found ${analysisResult.jobs.length} matching jobs.`, percent: 100 });
      emitProgress(jobId, { type: 'result', data: analysisResult });

    } catch (error: any) {
      console.error("Analysis Error:", error);
      if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      emitProgress(jobId, { type: 'error', message: error.message });
    }
  })();
});

// Cover letter endpoint — retrieves cached CV text via jobId for a richer prompt
app.post('/api/generate-cover', async (req: any, res: any) => {
  const { job, cvContext, applicantName, jobId } = req.body;
  const name = (applicantName || 'The Applicant').trim();

  // Pull full CV text from the session store if still available
  const state = jobId ? jobStore.get(jobId) : null;
  const fullCvText = state?.cvText ? state.cvText.substring(0, 8000) : '';

  try {
    const prompt = `
      Write a professional cover letter for the following job application.

      JOB: ${job.jobTitle} at ${job.companyName}
      JOB DESCRIPTION: ${job.description.substring(0, 1500)}

      APPLICANT NAME: ${name}
      APPLICANT SKILLS: ${(cvContext?.skills || []).join(', ')}
      APPLICANT EXPERIENCE HIGHLIGHTS: ${(cvContext?.experienceHighlights || []).join('; ')}
      ${fullCvText ? `\n      FULL CV CONTEXT:\n      ${fullCvText}` : ''}

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
    const pdfBuffer = await generateCoverLetterPDF(coverLetterText, job.jobTitle, job.companyName);

    const safeCompany = job.companyName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cover-letter-${safeCompany}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error("Cover letter generation failed:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`JobScout AI server running on http://localhost:${PORT}`);
});
