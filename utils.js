export function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

export function randomDelay(min = 2000, max = 5000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function safeText(text) {
  if (!text) return '';
  return text.trim().replace(/\s+/g, ' ');
}

export function normalizeNiche(niche) {
  if (Array.isArray(niche)) return niche.map(n => n.trim()).filter(Boolean);
  return [niche.trim()].filter(Boolean);
}
