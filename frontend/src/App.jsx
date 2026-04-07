import { useState, useEffect } from "react";
import "./index.css";

function App() {
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
    { value: "with_website", label: "With Website" },
    { value: "without_website", label: "Without Website" },
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
      setHistory(data);
    } catch (err) {
      console.error("History fetch failed:", err);
    }
  };

  const viewJob = (id) => {
    setJobId(id);
    setPage("home");
  };

  const downloadJobCSV = (id) => {
    window.open(`http://localhost:3001/csv/${id}`);
  };

  useEffect(() => {
    if (page === "history") {
      fetchHistory();
    }
  }, [page]);

  useEffect(() => {
    if (!jobId) return;

    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:3001/results/${jobId}`);
        const data = await res.json();
        setJob(data);

        if (data.status === "completed" || data.status === "cancelled") {
          clearInterval(poll);
          setLoading(false);
        }
      } catch (err) {
        console.error("Poll failed:", err);
      }
    }, 1500); // PHASE 24: 3s polling

    return () => clearInterval(poll);
  }, [jobId]);

  const downloadCSV = () => {
    window.open(`http://localhost:3001/csv/${jobId}`);
  };

  const stopScraping = async () => {
    if (!jobId) return;
    setStopping(true);
    try {
      await fetch(`http://localhost:3001/stop/${jobId}`, { method: "POST" });
      console.log("Stop requested");
    } catch (err) {
      console.error("Stop failed:", err);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-950 to-black text-white">
      {/* NAVBAR */}
      <nav className="bg-gray-900/80 backdrop-blur border-b border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Lead Engine
            </h1>
            <div className="space-x-6">
              <button
                onClick={() => setPage("home")}
                className={`hover:text-blue-400 transition-colors ${page === "home" ? "text-blue-400" : "text-gray-300"}`}
              >
                Home
              </button>
              <button
                onClick={() => setPage("history")}
                className={`hover:text-blue-400 transition-colors ${page === "history" ? "text-blue-400" : "text-gray-300"}`}
              >
                History
              </button>
            </div>
          </div>
        </div>
      </nav>

      {page === "home" ? (
        <>
          {/* HERO */}
          <div className="text-center py-16 px-6">
            <h1 className="text-5xl font-extrabold mb-4 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Lead Generation Engine
            </h1>
            <p className="text-gray-400 text-lg">
              Find high-quality business leads instantly 🚀
            </p>
          </div>

          <div className="max-w-6xl mx-auto px-6">
            {/* FORM CARD */}
            <div className="bg-gray-800/60 backdrop-blur p-8 rounded-2xl shadow-xl mb-10 border border-gray-700">
              <div className="grid md:grid-cols-3 gap-6 mb-6">
                <input
                  type="text"
                  placeholder="Niche (plumbers, dentists...)"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  className="bg-gray-900 p-4 rounded-xl border border-gray-700 focus:border-blue-500 outline-none"
                  disabled={loading}
                />

                <input
                  type="text"
                  placeholder="Location (Toronto, California...)"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="bg-gray-900 p-4 rounded-xl border border-gray-700 focus:border-blue-500 outline-none"
                  disabled={loading}
                />

                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="bg-gray-900 p-4 rounded-xl border border-gray-700 focus:border-blue-500 outline-none"
                  disabled={loading}
                >
                  {filterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <button
                onClick={startScraping}
                disabled={loading || !niche || !location}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:scale-[1.02] transition-all p-4 rounded-xl font-bold text-lg disabled:opacity-50"
              >
                {loading ? "Scraping in Progress..." : "Start Scraping"}
              </button>
            </div>

            {/* PROGRESS */}
            {job && (
              <div className="bg-gray-800/60 p-8 rounded-2xl shadow-xl mb-10 border border-gray-700">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-2xl font-bold">Live Progress</h2>
                  <span className="text-sm text-gray-400">Job ID: {jobId}</span>
                </div>

                <div className="grid md:grid-cols-3 gap-4 mb-6">
                  <div>
                    Status:{" "}
                    <span
                      className={`font-bold ${job.cancelled ? "text-yellow-400" : "text-blue-400"}`}
                    >
                      {job.status}
                      {job.cancelled ? " (Cancelled)" : ""}
                    </span>
                  </div>
                  <div>
                    Progress: <span className="font-bold">{job.progress}%</span>
                  </div>
                  <div>
                    Leads:{" "}
                    <span className="text-green-400 font-bold">
                      {job.leads?.length || 0}
                    </span>
                  </div>
                </div>

                <div className="w-full bg-gray-700 rounded-full h-4">
                  <div
                    className="bg-gradient-to-r from-blue-500 to-purple-500 h-4 rounded-full transition-all"
                    style={{ width: `${job.progress}%` }}
                  ></div>
                </div>

                {job?.leads?.length > 0 && (
                  <button
                    onClick={downloadCSV}
                    className="mt-6 w-full bg-green-600 hover:bg-green-700 p-4 rounded-xl font-bold text-lg"
                  >
                    📥 Download CSV ({job.leads.length} leads)
                  </button>
                )}
                {job.status === "running" && !job.cancelled && (
                  <button
                    onClick={stopScraping}
                    disabled={stopping}
                    className="mt-4 w-full bg-red-600 hover:bg-red-700 p-4 rounded-xl font-bold text-lg transition-all"
                  >
                    ⏹️ Stop Scraping
                  </button>
                )}
              </div>
            )}

            {/* RESULTS */}
            {job?.leads && job.leads.length > 0 && (
              <div className="bg-gray-800/60 p-8 rounded-2xl shadow-xl border border-gray-700">
                <h2 className="text-2xl font-bold mb-6">
                  Results ({job.leads.length} leads)
                </h2>

                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-900">
                      <tr>
                        <th className="p-3 text-left">Name</th>
                        <th className="p-3 text-left">Phone</th>
                        <th className="p-3 text-left">Website</th>
                        <th className="p-3 text-left">Email</th>
                        <th className="p-3 text-left">Owner</th>
                        <th className="p-3 text-left">Rating</th>
                        <th className="p-3 text-left">Reviews</th>
                        <th className="p-3 text-left">Intent</th>
                        <th className="p-3 text-left">Website Quality</th>
                      </tr>
                    </thead>

                    <tbody key={job?.leads?.length} >
                      {job.leads.slice(0, 100).map((lead, index) => (
                        <tr
                          key={index}
                          className="border-b border-gray-700 hover:bg-gray-700/40"
                        >
                          <td className="p-3">{lead.business_name || "-"}</td>
                          <td className="p-3">{lead.phone || "-"}</td>

                          <td className="p-3">
                            {lead.website ? (
                              <a
                                href={lead.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:underline"
                              >
                                Visit
                              </a>
                            ) : (
                              "-"
                            )}
                          </td>

                          <td className="p-3">
                            {lead.primary_email || lead.secondary_emails || "-"}
                          </td>
                          <td className="p-3">{lead.owner_name || "-"}</td>
                          <td className="p-3">{lead.rating || "-"}</td>
                          <td className="p-3">{lead.reviews || "-"}</td>

                          <td className="p-3">
                            <span
                              className={`px-3 py-1 rounded-full text-xs font-bold ${
                                lead.intent === "HIGH"
                                  ? "bg-red-500 text-white"
                                  : lead.intent === "MEDIUM"
                                    ? "bg-yellow-500 text-black"
                                    : "bg-green-500 text-white"
                              }`}
                            >
                              {lead.intent || "LOW"}
                            </span>
                          </td>
                          <td className="p-3">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-bold ${
                                lead.website_quality === "good"
                                  ? "bg-green-500"
                                  : lead.website_quality === "basic"
                                    ? "bg-yellow-500 text-black"
                                    : "bg-gray-500"
                              }`}
                            >
                              {lead.website_quality || "none"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        // HISTORY PAGE
        <div className="max-w-6xl mx-auto px-6 py-10">
          <h1 className="text-4xl font-bold mb-8 text-center">
            Scraping History
          </h1>

          <div className="space-y-4">
            {history.map((job) => (
              <div
                key={job.id}
                className="bg-gray-800/60 p-6 rounded-2xl shadow-xl border border-gray-700"
              >
                <div className="grid md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <span className="text-gray-400">Job ID:</span>
                    <div className="font-mono text-sm">{job.id}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Niche:</span>
                    <div className="font-bold">{job.niche}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Location:</span>
                    <div className="font-bold">{job.location}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Leads:</span>
                    <div className="text-green-400 font-bold">
                      {job.leads?.length || 0}
                    </div>
                  </div>
                </div>
                <div className="mb-4">
                  <span className="text-gray-400">Date:</span>
                  <div>{new Date(job.createdAt).toLocaleString()}</div>
                </div>
                <div className="flex space-x-4">
                  <button
                    onClick={() => viewJob(job.id)}
                    className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-bold transition-colors"
                  >
                    View Results
                  </button>
                  <button
                    onClick={() => downloadJobCSV(job.id)}
                    className="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg font-bold transition-colors"
                  >
                    Download CSV
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
