import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, MapPin, Filter, Play, Download, Square, CheckCircle, XCircle, Loader2, Link as LinkIcon, Mail, User, Star, Map, History } from "lucide-react";
import "./index.css";

export default function App() {
  const [page, setPage] = useState("home");
  const [niche, setNiche] = useState("");
  const [location, setLocation] = useState("");
  const [filterType, setFilterType] = useState("all");
  
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  
  const [history, setHistory] = useState([]);

  const filterOptions = [
    { value: "all", label: "All Leads" },
    { value: "with_website", label: "With Website Only" },
    { value: "without_website", label: "Without Website Only" },
  ];

  const startScraping = async () => {
    setLoading(true);
    setJob(null);
    try {
      const res = await fetch("http://localhost:3001/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ niche, location, filterType }),
      });
      const data = await res.json();
      setJobId(data.jobId);
    } catch (err) {
      console.error("Start failed:", err);
      setLoading(false);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch("http://localhost:3001/history");
      const data = await res.json();
      setHistory(data.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
    } catch {}
  };

  useEffect(() => {
    if (page === "history") fetchHistory();
  }, [page]);

  useEffect(() => {
    if (!jobId) return;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:3001/results/${jobId}`);
        const data = await res.json();
        setJob(data);

        if (data.status === "completed" || data.status === "cancelled" || data.status === "failed") {
          clearInterval(poll);
          setLoading(false);
        }
      } catch {}
    }, 1500);
    return () => clearInterval(poll);
  }, [jobId]);

  const stopScraping = async () => {
    if (!jobId) return;
    setStopping(true);
    try {
      await fetch(`http://localhost:3001/stop/${jobId}`, { method: "POST" });
    } catch {} finally {
      setStopping(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-slate-200 font-sans selection:bg-purple-500/30 overflow-hidden relative">
      
      {/* Background Orbs */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-purple-600/20 blur-[120px] rounded-full point-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-blue-600/10 blur-[150px] rounded-full point-events-none" />

      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 glass-panel border-b-0 border-t-0 rounded-none bg-[#0a0a0a]/80">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setPage("home")}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <MapPin className="text-white w-6 h-6" />
            </div>
            <span className="text-2xl font-bold tracking-tight text-white">LeadEngine</span>
          </div>
          <div className="flex bg-white/5 p-1 rounded-full border border-white/10">
            <button
              onClick={() => setPage("home")}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${page === "home" ? "bg-white/10 text-white shadow-sm" : "text-slate-400 hover:text-white"}`}
            >
              Scanner
            </button>
            <button
              onClick={() => setPage("history")}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${page === "history" ? "bg-white/10 text-white shadow-sm" : "text-slate-400 hover:text-white"}`}
            >
              History
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-32 pb-20 px-6 max-w-7xl mx-auto relative z-10 min-h-screen flex flex-col">
        <AnimatePresence mode="wait">
          {page === "home" ? (
            <motion.div
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex-1 flex flex-col gap-10"
            >
              {/* Header */}
              <div className="text-center max-w-2xl mx-auto mt-10">
                <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight text-white mb-6 leading-tight">
                  Discover leads at <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-400 text-glow">hyperscale.</span>
                </h1>
                <p className="text-lg text-slate-400 leading-relaxed">
                  Enter any state or city. Our autonomous AI sequentially sweeps thousands of regions natively without duplication limits.
                </p>
              </div>

              {/* Extractor Form */}
              <div className="glass-panel p-3 rounded-[2rem] max-w-5xl mx-auto w-full relative group">
                <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                
                <div className="flex flex-col md:flex-row gap-3 relative z-10">
                  <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                    <input
                      type="text"
                      placeholder="e.g. Plumbers, Roofers, Clinics..."
                      value={niche}
                      onChange={(e) => setNiche(e.target.value)}
                      disabled={loading}
                      className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl pl-12 pr-4 text-white placeholder:text-slate-500 focus:bg-white/10 focus:border-purple-500/50 outline-none transition-all"
                    />
                  </div>
                  <div className="flex-1 relative">
                    <Map className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                    <input
                      type="text"
                      placeholder="e.g. Texas, Ontario, New York, Toronto..."
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      disabled={loading}
                      className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl pl-12 pr-4 text-white placeholder:text-slate-500 focus:bg-white/10 focus:border-purple-500/50 outline-none transition-all"
                    />
                  </div>
                  <div className="flex-1 relative">
                    <Filter className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                      disabled={loading}
                      className="w-full h-16 bg-white/5 border border-white/10 rounded-2xl pl-12 pr-4 text-white focus:bg-white/10 focus:border-purple-500/50 outline-none transition-all appearance-none"
                    >
                      {filterOptions.map((opt) => (
                        <option key={opt.value} value={opt.value} className="bg-gray-900 text-white">
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  
                  <button
                    onClick={startScraping}
                    disabled={loading || !niche || !location}
                    className="h-16 px-10 rounded-2xl font-bold text-white bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 hover:shadow-[0_0_40px_-10px_rgba(168,85,247,0.5)] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                  >
                    {loading ? <Loader2 className="animate-spin w-5 h-5" /> : <Play className="w-5 h-5 fill-current" />}
                    <span>{loading ? "Scanning" : "Start"}</span>
                  </button>
                </div>
              </div>

              {/* Progress UI */}
              {job && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="glass-panel p-8 rounded-3xl w-full max-w-5xl mx-auto border border-white/10 relative overflow-hidden"
                >
                  {job.status === "running" && (
                    <div className="absolute top-0 left-0 w-full h-1 bg-white/5">
                      <motion.div 
                        className="h-full bg-gradient-to-r from-purple-500 to-blue-500" 
                        initial={{ width: 0 }} 
                        animate={{ width: `${job.progress}%` }} 
                        transition={{ ease: "linear", duration: 0.5 }}
                      />
                    </div>
                  )}

                  <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
                    <div className="flex items-center gap-6">
                      <div className="relative">
                        {job.status === "running" ? (
                          <div className="w-16 h-16 rounded-full border-4 border-white/10 border-t-purple-500 animate-spin" />
                        ) : job.status === "completed" ? (
                          <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shadow-[0_0_30px_-5px_rgba(16,185,129,0.3)] border border-emerald-500/30 font-bold text-xl">
                            <CheckCircle className="w-8 h-8" />
                          </div>
                        ) : (
                          <div className="w-16 h-16 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center shadow-[0_0_30px_-5px_rgba(244,63,94,0.3)] border border-rose-500/30">
                            <XCircle className="w-8 h-8" />
                          </div>
                        )}
                        {job.status === "running" && <div className="absolute inset-0 flex items-center justify-center font-bold text-xs text-white">{job.progress}%</div>}
                      </div>

                      <div>
                        <h3 className="text-2xl font-bold text-white capitalize">{job.status}</h3>
                        <p className="text-slate-400 text-sm mt-1 max-w-xs truncate">
                          {job.status === "running" 
                            ? `Sweeping sector: ${job.currentCity || location}` 
                            : job.cancelled ? "Terminated by user" : "Extraction complete"}
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-10">
                      <div className="flex flex-col">
                        <span className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Leads Extracted</span>
                        <span className="text-4xl font-extrabold text-white text-glow">{job.leads?.length || 0}</span>
                      </div>
                      
                      <div className="flex flex-col gap-3 justify-center">
                        <button
                          onClick={() => window.open(`http://localhost:3001/csv/${jobId}`)}
                          disabled={!job.leads || job.leads.length === 0}
                          className="flex items-center gap-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-xl transition-all font-medium text-sm border border-emerald-500/20 disabled:opacity-50"
                        >
                          <Download className="w-4 h-4" /> Download Live CSV
                        </button>
                        
                        {job.status === "running" && (
                          <button
                            onClick={stopScraping}
                            disabled={stopping}
                            className="flex items-center justify-center gap-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 px-4 py-2 rounded-xl transition-all font-medium text-sm border border-rose-500/20"
                          >
                            <Square className="w-3 h-3 fill-current" /> {stopping ? "Halting..." : "Halt Engine"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Live Data Grid */}
              {job?.leads?.length > 0 && (
                <motion.div initial={{opacity:0}} animate={{opacity:1}} className="max-w-7xl mx-auto w-full">
                  <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Data Stream
                  </h3>
                  
                  <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse whitespace-nowrap">
                        <thead>
                          <tr className="border-b border-white/10 bg-white/[0.02]">
                            <th className="px-6 py-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Business</th>
                            <th className="px-6 py-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Contact</th>
                            <th className="px-6 py-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Digital</th>
                            <th className="px-6 py-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Presence</th>
                            <th className="px-6 py-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Intent</th>
                          </tr>
                        </thead>
                        <tbody>
                          {job.leads.slice().reverse().slice(0, 100).map((l, i) => (
                            <motion.tr 
                              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i*0.05, 0.5) }}
                              key={i} className="border-b border-white/[0.05] hover:bg-white/[0.04] transition-colors group"
                            >
                              <td className="px-6 py-4">
                                <p className="font-bold text-white mb-1 group-hover:text-purple-400 transition-colors">{l.business_name || "-"}</p>
                                <p className="text-xs text-slate-500 flex items-center gap-1"><MapPin className="w-3 h-3" /> {l.city}</p>
                              </td>
                              <td className="px-6 py-4">
                                <p className="text-sm text-slate-300 font-mono mb-1">{l.phone || "-"}</p>
                                <p className="text-xs text-slate-400 flex items-center gap-1"><User className="w-3 h-3"/> {l.owner_name ? <span className="text-emerald-400">{l.owner_name}</span> : "Unknown"}</p>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex flex-col gap-1.5">
                                  {l.website ? <a href={l.website} target="_blank" rel="noreferrer" className="text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300 w-fit"><LinkIcon className="w-3 h-3"/> Website</a> : <span className="text-xs text-slate-600">No Web</span>}
                                  {l.primary_email ? <span className="text-xs flex items-center gap-1 text-slate-300"><Mail className="w-3 h-3"/> {l.primary_email}</span> : <span className="text-xs text-slate-600">No Email</span>}
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-1 text-yellow-400 text-sm font-bold">
                                  <Star className="w-4 h-4 fill-current"/> {l.rating || "-"} <span className="text-slate-500 text-xs font-normal ml-1">({l.reviews || 0})</span>
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${l.intent === "HIGH" ? "bg-purple-500/20 text-purple-400 border border-purple-500/30" : l.intent === "MEDIUM" ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "bg-slate-500/20 text-slate-400 border border-slate-500/30"}`}>
                                  {l.intent || "LOW"}
                                </span>
                              </td>
                            </motion.tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </motion.div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <div className="flex items-center gap-4 mb-10">
                <History className="w-8 h-8 text-purple-400" />
                <h2 className="text-4xl font-extrabold text-white tracking-tight">Mission Archives</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {history.map(j => (
                  <div key={j.id} className="glass-panel p-6 rounded-2xl border border-white/10 hover:border-purple-500/30 transition-all group relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 to-blue-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                    
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-bold text-white text-lg capitalize">{j.niche}</h3>
                        <p className="text-sm text-slate-400 flex items-center gap-1 mt-1"><MapPin className="w-3 h-3"/> {j.location}</p>
                      </div>
                      <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase ${j.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' : j.status === 'running' ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-500/20 text-slate-400'}`}>
                        {j.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-6 mb-6 pb-6 border-b border-white/5">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Total Leads</p>
                        <p className="text-2xl font-bold text-white">{j.total}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">High Intent</p>
                        <p className="text-2xl font-bold text-purple-400">{j.highIntent}</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3"/> {new Date(j.createdAt).toLocaleDateString()}</span>
                      <div className="flex gap-2">
                        <button onClick={() => {setJobId(j.id); setPage("home");}} className="text-xs font-bold bg-white/5 hover:bg-white/10 text-white px-3 py-2 rounded-lg transition-all">
                          View
                        </button>
                        <button onClick={() => window.open(`http://localhost:3001/csv/${j.id}`)} className="text-xs font-bold bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 px-3 py-2 rounded-lg transition-all">
                          CSV
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
