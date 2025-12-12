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
const PDF_TTL_SECONDS = parseInt(process.env.PDF_TTL_SECONDS || '3600');
const TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// --- Setup ---
const app = express();
const upload = multer({ dest: TEMP_DIR });

app.use(cors() as any);
app.use(express.json() as any);
// Serve temp files for download (Secure this in production with signed URLs or auth)
app.use('/download', express.static(TEMP_DIR) as any);

// --- GenAI Client ---
// Initialize GenAI client safely
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });


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
async function scrapeLinkedInJobs(searchUrl: string, maxItems: number, apiToken?: string, actorSlug?: string): Promise<any[]> {
  const token = apiToken || process.env.APIFY_API_TOKEN;
  const actor = actorSlug || process.env.APIFY_ACTOR_SLUG || "curious_coder~linkedin-jobs-scraper";

  if (!token) throw new Error("Missing Apify API Token. Provide it in the UI settings or .env (APIFY_API_TOKEN).");

  console.log(`Starting Apify actor ${actor} for ${searchUrl}`);

  // Start the run
  const startRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: [{ url: searchUrl }],
      maxItems: Math.min(maxItems, 100), // Hard cap at 100
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

  // Poll for completion
  let status = 'RUNNING';
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise(r => setTimeout(r, 5000)); // Poll every 5s
    const pollRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs/${runId}?token=${token}`);
    const pollData = await pollRes.json() as any;
    status = pollData.data.status;
    console.log(`Run status: ${status}`);
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run failed with status: ${status}`);
  }

  // Fetch items
  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${token}&limit=100`);
  const items = await itemsRes.json() as any[];
  return items;
}

// 3. Normalize Data
function normalizeJobData(rawJob: any): any {
  // Mapping config to handle potential field name variations
  return {
    jobId: rawJob.id || rawJob.jobId || uuidv4(),
    companyName: rawJob.companyName || rawJob.company || "Unknown Company",
    companyLogo: rawJob.companyLogo || rawJob.logo || null,
    jobTitle: rawJob.title || rawJob.jobTitle || "Untitled Role",
    jobUrl: rawJob.url || rawJob.jobUrl || "",
    applyUrl: rawJob.applyUrl || rawJob.url || "", // Fallback to job url
    description: rawJob.description || rawJob.text || "",
    scrapedAt: rawJob.postedAt || new Date().toISOString().split('T')[0]
  };
}

// 4. Gemini Analysis
async function analyzeCvAndJobs(cvText: string, jobs: any[], threshold: number) {
  // A. Parse CV
  console.log("Parsing CV with Gemini...");
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

  // B. Score Jobs (Sequential or Batching)
  // For 100 jobs, we process them in chunks to avoid overwhelming the model or hitting potential rate limits on smaller keys
  // Note: Gemini 1.5/2.5 Flash is very fast. We will use Promise.all with a small concurrency.
  
  console.log(`Scoring ${jobs.length} jobs...`);
  
  const scoredJobs = [];
  
  // Create a reusable scoring prompt template
  const createScoringPrompt = (job: any) => `
    You are a recruiter. Compare this candidate's profile to the job description.
    
    CANDIDATE SKILLS: ${JSON.stringify(cvData.skills)}
    CANDIDATE SUMMARY: ${cvData.profileSummary}
    
    JOB TITLE: ${job.jobTitle}
    JOB DESCRIPTION: ${job.description.substring(0, 3000)} // Truncate for token limits if needed

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

  // Simple concurrency limiter
  const chunkArray = (arr: any[], size: number) => 
    arr.length > size ? [arr.slice(0, size), ...chunkArray(arr.slice(size), size)] : [arr];
    
  const chunks = chunkArray(jobs, 5); // Process 5 at a time

  for (const chunk of chunks) {
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

app.post('/api/analyze', upload.single('cvFile') as any, async (req: any, res: any) => {
  const file = req.file;
  const { searchUrl, maxJobs, scoreThreshold, apifyToken, apifyActor } = req.body;

  if (!file) return res.status(400).json({ error: "No CV file uploaded." });

  try {
    // 1. Extract CV Text
    console.log("Extracting text...");
    const cvText = await extractText(file.path, file.mimetype);
    
    // Store CV text in a temporary file for Cover Letter generation later?
    // For this stateless architecture, we'll re-upload or pass context. 
    // To strictly follow "not persist CVs long-term", we rely on memory for the request duration
    // or extracted metadata returned to client.
    
    // 2. Scrape Jobs
    const rawJobs = await scrapeLinkedInJobs(searchUrl, parseInt(maxJobs) || 50, apifyToken, apifyActor);
    const normalizedJobs = rawJobs.map(normalizeJobData);
    
    // 3. Analyze
    const analysisResult = await analyzeCvAndJobs(
      cvText, 
      normalizedJobs, 
      parseInt(scoreThreshold) || 60
    );

    // Cleanup input file
    fs.unlinkSync(file.path);

    res.json(analysisResult);

  } catch (error: any) {
    console.error("Analysis Error:", error);
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/generate-cover', async (req: any, res: any) => {
  const { job, cvContext } = req.body;

  try {
    // Generate Text
    const prompt = `
      Write a professional cover letter for the following job application.
      
      JOB: ${job.jobTitle} at ${job.companyName}
      JOB CONTEXT: ${job.description.substring(0, 1000)}...
      
      APPLICANT SKILLS: ${(cvContext?.skills || []).join(', ')}
      APPLICANT EXPERIENCE: ${(cvContext?.experienceHighlights || []).join('; ')}
      
      Tone: Professional, concise, enthusiastic. Max 300 words.
      Structure:
      1. Hook (why this company).
      2. Relevance (skills match).
      3. Call to Action.
      
      Do not include placeholders like [Your Name] - use "The Applicant".
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
          ${coverLetterText.split('\n').map(p => p.trim() ? `<p>${