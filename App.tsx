import React, { useState, useRef } from 'react';
import { Upload, Search, FileText, Briefcase, CheckCircle, AlertCircle, Loader2, Download, ExternalLink, RefreshCw, Settings } from 'lucide-react';
import { AnalyzedResponse, Job } from './types';

// API Base URL - assumes the Node server is running on port 3000
const API_BASE_URL = 'http://localhost:3000/api';

const App: React.FC = () => {
  // Form State
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [searchUrl, setSearchUrl] = useState<string>('');
  const [maxJobs, setMaxJobs] = useState<number>(50);
  const [scoreThreshold, setScoreThreshold] = useState<number>(60);
  
  // Scraper Settings (Apify)
  // Changed default to true so users see where to paste keys immediately
  const [showScraperSettings, setShowScraperSettings] = useState<boolean>(true);
  const [apifyToken, setApifyToken] = useState<string>('');
  const [apifyActor, setApifyActor] = useState<string>('curious_coder~linkedin-jobs-scraper');

  // App Status State
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'success' | 'error'>('idle');
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  // Data State
  const [data, setData] = useState<AnalyzedResponse | null>(null);
  
  // Cover Letter Generation State
  const [generatingCoverId, setGeneratingCoverId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setCvFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cvFile) {
      setErrorMessage("Please upload a CV.");
      return;
    }
    if (!searchUrl.includes('linkedin.com/jobs/search')) {
      setErrorMessage("Please enter a valid LinkedIn search URL.");
      return;
    }

    setStatus('analyzing');
    setLoadingMessage("Uploading CV and initiating scraper...");
    setErrorMessage('');

    const formData = new FormData();
    formData.append('cvFile', cvFile);
    formData.append('searchUrl', searchUrl);
    formData.append('maxJobs', maxJobs.toString());
    formData.append('scoreThreshold', scoreThreshold.toString());
    
    // Pass optional scraper settings
    formData.append('apifyToken', apifyToken);
    formData.append('apifyActor', apifyActor);

    try {
      // Step 1: Analyze
      const response = await fetch(`${API_BASE_URL}/analyze`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to analyze jobs');
      }

      const result: AnalyzedResponse = await response.json();
      setData(result);
      setStatus('success');
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || "An unexpected error occurred. Ensure the server is running on port 3000.");
      setStatus('error');
    }
  };

  const handleGenerateCoverLetter = async (job: Job) => {
    if (generatingCoverId) return; // Prevent multiple clicks
    setGeneratingCoverId(job.jobId);

    try {
      const response = await fetch(`${API_BASE_URL}/generate-cover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          job,
          cvContext: {
            skills: data?.skills,
            experienceHighlights: data?.experienceHighlights
          }
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate cover letter");
      }

      const result = await response.json();
      
      // Trigger download
      if (result.coverLetterUrl) {
        window.open(result.coverLetterUrl, '_blank');
      }
    } catch (err) {
      alert("Failed to generate cover letter. Please try again.");
    } finally {
      setGeneratingCoverId(null);
    }
  };

  const reset = () => {
    setStatus('idle');
    setData(null);
    setErrorMessage('');
    setLoadingMessage('');
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex items-center justify-between pb-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-blue-600 rounded-lg shadow-lg">
              <Briefcase className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">JobScout AI</h1>
              <p className="text-sm text-gray-500">Smart scraping, scoring, and application assistant</p>
            </div>
          </div>
          {status === 'success' && (
             <button onClick={reset} className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-blue-600 transition-colors">
               <RefreshCw className="w-4 h-4" /> Run Again
             </button>
          )}
        </header>

        {/* Input Form */}
        {status === 'idle' || status === 'analyzing' || status === 'error' ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 md:p-8">
            <h2 className="text-lg font-semibold mb-6 flex items-center gap-2">
              <Search className="w-5 h-5 text-blue-500" />
              Configuration
            </h2>
            
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* File Upload */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Upload CV (PDF, DOCX)</label>
                  <div 
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-gray-300 rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors"
                  >
                    <Upload className="w-8 h-8 text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600 font-medium">
                      {cvFile ? cvFile.name : "Click to upload your CV"}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">Max 5MB</p>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleFileChange} 
                      accept=".pdf,.doc,.docx" 
                      className="hidden" 
                    />
                  </div>
                </div>

                {/* Settings */}
                <div className="space-y-4">
                   <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">LinkedIn Search URL</label>
                    <input 
                      type="url" 
                      value={searchUrl}
                      onChange={(e) => setSearchUrl(e.target.value)}
                      placeholder="https://www.linkedin.com/jobs/search?keywords=..."
                      className="w-full rounded-lg border-gray-300 border p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-gray-900"
                      required
                    />
                    <p className="text-xs text-gray-400 mt-1">Paste the full URL from your browser address bar after searching.</p>
                   </div>

                   <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Max Jobs</label>
                        <input 
                          type="number" 
                          value={maxJobs}
                          onChange={(e) => setMaxJobs(Number(e.target.value))}
                          min={1}
                          max={100}
                          className="w-full rounded-lg border-gray-300 border p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white text-gray-900"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Score Threshold ({scoreThreshold})</label>
                        <input 
                          type="range" 
                          value={scoreThreshold}
                          onChange={(e) => setScoreThreshold(Number(e.target.value))}
                          min={0}
                          max={100}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 mt-3"
                        />
                      </div>
                   </div>
                </div>
              </div>

              {/* Scraper Settings Section */}
              <div className="border-t border-gray-100 pt-4">
                 <button 
                   type="button"
                   onClick={() => setShowScraperSettings(!showScraperSettings)}
                   className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-blue-600 transition-colors mb-4"
                 >
                   <Settings className="w-4 h-4" />
                   {showScraperSettings ? 'Hide Scraper Settings' : 'Scraper Settings (Apify)'}
                 </button>
                 
                 {showScraperSettings && (
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg border border-gray-200 animate-fade-in">
                     <div>
                       <label className="block text-sm font-medium text-gray-700 mb-1">Apify API Token</label>
                       <input 
                         type="password"
                         value={apifyToken}
                         onChange={(e) => setApifyToken(e.target.value)}
                         placeholder="Paste your Apify API Token here"
                         className="w-full rounded-lg border-gray-300 border p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white text-gray-900"
                       />
                       <p className="text-xs text-gray-400 mt-1">Leave blank if using .env file</p>
                     </div>
                     <div>
                       <label className="block text-sm font-medium text-gray-700 mb-1">Actor Slug</label>
                       <input 
                         type="text"
                         value={apifyActor}
                         onChange={(e) => setApifyActor(e.target.value)}
                         placeholder="curious_coder~linkedin-jobs-scraper"
                         className="w-full rounded-lg border-gray-300 border p-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white text-gray-900"
                       />
                     </div>
                   </div>
                 )}
              </div>

              {/* Action */}
              <div className="pt-4 border-t border-gray-100 flex flex-col items-center">
                 {status === 'error' && (
                   <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg flex items-center gap-2 text-sm">
                     <AlertCircle className="w-4 h-4" />
                     {errorMessage}
                   </div>
                 )}
                 
                 <button 
                  type="submit" 
                  disabled={status === 'analyzing'}
                  className={`
                    w-full md:w-auto px-8 py-3 rounded-lg font-semibold text-white shadow-md transition-all
                    ${status === 'analyzing' ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg'}
                  `}
                 >
                   {status === 'analyzing' ? (
                     <span className="flex items-center gap-2">
                       <Loader2 className="w-5 h-5 animate-spin" />
                       {loadingMessage || 'Processing...'}
                     </span>
                   ) : "Scrape & Analyze Jobs"}
                 </button>
                 <p className="mt-4 text-xs text-gray-400">
                   Privacy Notice: Files are processed temporarily for analysis and are not permanently stored.
                 </p>
              </div>
            </form>
          </div>
        ) : null}

        {/* Results Dashboard */}
        {status === 'success' && data && (
          <div className="space-y-8 animate-fade-in">
            
            {/* CV Summary Card */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <FileText className="w-5 h-5 text-indigo-500" />
                CV Analysis
              </h3>
              <div className="grid md:grid-cols-3 gap-6">
                <div className="md:col-span-2 space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-2">Profile Summary</h4>
                    <p className="text-gray-700 leading-relaxed">{data.profileSummary}</p>
                  </div>
                  <div>
                     <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-2">Highlights</h4>
                     <ul className="list-disc list-inside space-y-1 text-gray-700">
                       {data.experienceHighlights.map((h, i) => (
                         <li key={i}>{h}</li>
                       ))}
                     </ul>
                  </div>
                </div>
                <div className="bg-indigo-50 rounded-lg p-5">
                  <h4 className="text-sm font-medium text-indigo-800 uppercase tracking-wider mb-3">Detected Skills</h4>
                  <div className="flex flex-wrap gap-2">
                    {data.skills.map((skill, i) => (
                      <span key={i} className="px-3 py-1 bg-white text-indigo-600 text-xs font-medium rounded-full border border-indigo-100 shadow-sm">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Jobs Grid */}
            <div>
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-gray-900">
                  Matched Jobs <span className="text-gray-400 font-normal ml-2">({data.jobs.length})</span>
                </h3>
                <div className="text-sm text-gray-500">
                  Showing jobs with score &ge; {scoreThreshold}
                </div>
              </div>

              {data.jobs.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-xl border border-dashed border-gray-300">
                  <p className="text-gray-500">No jobs met your threshold criteria.</p>
                  <button onClick={reset} className="mt-4 text-blue-600 hover:underline">Try different settings</button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-6">
                  {data.jobs.map((job) => (
                    <div key={job.jobId} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow">
                      <div className="p-6">
                        <div className="flex flex-col md:flex-row gap-6">
                          
                          {/* Left: Score & Logo */}
                          <div className="flex-shrink-0 flex flex-row md:flex-col items-center gap-4 md:w-24">
                            {job.companyLogo ? (
                              <img src={job.companyLogo} alt={job.companyName} className="w-16 h-16 object-contain rounded-md bg-white border border-gray-100" />
                            ) : (
                              <div className="w-16 h-16 bg-gray-100 rounded-md flex items-center justify-center text-gray-400 text-xl font-bold">
                                {job.companyName.charAt(0)}
                              </div>
                            )}
                            <div className={`
                              flex items-center justify-center w-12 h-12 rounded-full font-bold text-sm border-4
                              ${(job.score || 0) >= 80 ? 'border-green-100 text-green-700 bg-green-50' : 
                                (job.score || 0) >= 60 ? 'border-yellow-100 text-yellow-700 bg-yellow-50' : 'border-red-100 text-red-700 bg-red-50'}
                            `}>
                              {job.score}
                            </div>
                          </div>

                          {/* Middle: Content */}
                          <div className="flex-grow space-y-3">
                            <div>
                              <h4 className="text-lg font-bold text-gray-900 hover:text-blue-600">
                                <a href={job.jobUrl} target="_blank" rel="noreferrer">{job.jobTitle}</a>
                              </h4>
                              <p className="text-sm font-medium text-gray-600">{job.companyName}</p>
                            </div>
                            
                            <div className="bg-blue-50/50 p-4 rounded-lg border border-blue-100">
                              <p className="text-sm text-gray-800 leading-relaxed">
                                <span className="font-semibold text-blue-800">AI Verdict: </span>
                                {job.verdict}
                              </p>
                            </div>
                            
                            <div className="flex items-center gap-4 text-xs text-gray-400 pt-2">
                              <span>Scraped: {job.scrapedAt}</span>
                              {job.jobId && <span>ID: {job.jobId}</span>}
                            </div>
                          </div>

                          {/* Right: Actions */}
                          <div className="flex flex-col gap-3 justify-center min-w-[180px]">
                             <a 
                               href={job.jobUrl} 
                               target="_blank" 
                               rel="noreferrer"
                               className="flex items-center justify-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                             >
                               View Job <ExternalLink className="w-4 h-4" />
                             </a>
                             {job.applyUrl && (
                               <a 
                                 href={job.applyUrl} 
                                 target="_blank" 
                                 rel="noreferrer"
                                 className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 border border-transparent rounded-lg text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                               >
                                 Apply Now <ExternalLink className="w-4 h-4" />
                               </a>
                             )}
                             <div className="h-px bg-gray-100 my-1"></div>
                             <button
                               onClick={() => handleGenerateCoverLetter(job)}
                               disabled={generatingCoverId === job.jobId}
                               className="flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-100 transition-colors disabled:opacity-70"
                             >
                               {generatingCoverId === job.jobId ? (
                                 <Loader2 className="w-4 h-4 animate-spin" />
                               ) : (
                                 <FileText className="w-4 h-4" />
                               )}
                               {generatingCoverId === job.jobId ? 'Generating...' : 'Cover Letter'}
                             </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;