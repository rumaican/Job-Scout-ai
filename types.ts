export interface Job {
  jobId: string;
  companyName: string;
  companyLogo?: string;
  jobTitle: string;
  jobUrl: string;
  applyUrl?: string;
  description: string;
  scrapedAt: string;
  score?: number;
  verdict?: string;
}

export interface AnalyzedResponse {
  skills: string[];
  profileSummary: string;
  experienceHighlights: string[];
  jobs: Job[];
  coverLetterUrl?: string | null;
  coverLetterText?: string | null;
}

export interface ApiError {
  error: string;
  details?: string;
}

export interface AnalysisRequest {
  searchUrl: string;
  maxJobs: number;
  scoreThreshold: number;
}
