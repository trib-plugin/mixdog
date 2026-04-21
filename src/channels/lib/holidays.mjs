import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DATA_DIR } from "./config.mjs";
const CACHE_FILE = join(DATA_DIR, "holidays-cache.json");
const FALLBACK_FILE = join(homedir(), ".claude", "schedules", "holidays.json");
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
async function fetchHolidays(year, countryCode) {
  const url = `https://date.nager.at/api/v3/publicholidays/${year}/${countryCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nager API ${res.status}: ${res.statusText}`);
  return res.json();
}
function loadCache(year, countryCode) {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (cache.year !== year || cache.countryCode !== countryCode) return null;
    if (Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) return null;
    return cache.holidays;
  } catch {
    return null;
  }
}
function saveCache(year, countryCode, holidays) {
  const cache = { year, countryCode, fetchedAt: Date.now(), holidays };
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
  }
}
function loadFallback() {
  try {
    if (!existsSync(FALLBACK_FILE)) return /* @__PURE__ */ new Set();
    const data = JSON.parse(readFileSync(FALLBACK_FILE, "utf8"));
    const dates = data.holidays ?? [];
    return new Set(dates);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function isHoliday(date, countryCode) {
  const year = date.getFullYear();
  const dateStr = `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  let holidays = loadCache(year, countryCode);
  if (!holidays) {
    try {
      holidays = await fetchHolidays(year, countryCode);
      saveCache(year, countryCode, holidays);
    } catch (err) {
      process.stderr.write(`mixdog holidays: API fetch failed: ${err}
`);
      holidays = null;
    }
  }
  if (holidays) {
    return holidays.some((h) => h.date === dateStr);
  }
  const fallback = loadFallback();
  return fallback.has(dateStr);
}
export {
  isHoliday
};
