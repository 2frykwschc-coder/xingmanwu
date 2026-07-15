// Build MangaDex ID mapping for all manga in DB
// Run: node build_dex_mapping.js
import { initDB, default as db } from './db.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DEX_API = 'https://api.mangadex.org';
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'data', 'mapping_state.json');

await initDB();

// Load state (for resumability)
let state = { processed: 0, lastId: 0 };
if (existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    console.log(`Resuming from ID ${state.lastId}, already processed ${state.processed}`);
  } catch {}
}

function simpleMatch(candidate, searchTitle) {
  // Just check if english title or any alt title matches
  const en = (candidate.attributes.title?.en || '').toLowerCase().trim();
  const ja_ro = (candidate.attributes.title?.['ja-ro'] || '').toLowerCase().trim();
  const s = searchTitle.toLowerCase().trim();
  if (s === en || s === ja_ro) return 100;
  if (en.startsWith(s) || ja_ro.startsWith(s) || s.startsWith(en) || s.startsWith(ja_ro)) {
    const longer = s.length > en.length ? s : en;
    const shorter = s.length > en.length ? en : s;
    if (shorter.length >= 4 && longer.includes(shorter)) return 80;
  }
  // Check alt titles
  for (const alt of candidate.attributes.altTitles || []) {
    for (const v of Object.values(alt)) {
      const t = (v || '').toLowerCase().trim();
      if (t === s) return 90;
    }
  }
  return 0;
}

async function dexFetch(path) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(DEX_API + path, { headers: { 'User-Agent': 'Xingmanwu/1.0' }, signal: ac.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function findMangaDexId(manga) {
  for (const term of [manga.title_romaji, manga.title_english].filter(Boolean)) {
    if (term.length < 2) continue;
    const d = await dexFetch('/manga?title=' + encodeURIComponent(term) + '&limit=10&order[relevance]=desc');
    if (!d?.data?.length) continue;
    for (const c of d.data) {
      if (simpleMatch(c, term) >= 80) {
        const t = c.attributes.title;
        return { dex_id: c.id, dex_title: t?.en || t?.['ja-ro'] || t?.ja || '', score: 80 };
      }
    }
  }
  return null;
}

let processed = state.processed;
let failed = 0;

const allManga = db.all('SELECT id,title_romaji,title_english,title_native,format FROM manga ORDER BY id');
console.log(`Total manga: ${allManga.length}`);

const startIdx = allManga.findIndex(m => m.id > state.lastId);
if (startIdx === -1) { console.log('Done!'); process.exit(0); }

const toProcess = allManga.slice(startIdx);
let batchCount = 0;

for (const manga of toProcess) {
  if (manga.format === 'NOVEL' || manga.format === 'ONE_SHOT') {
    processed++;
    if (++batchCount % 100 === 0) {
      db.save();
      writeFileSync(STATE_PATH, JSON.stringify({ processed, lastId: manga.id }));
    }
    continue;
  }
  
  const result = await findMangaDexId(manga);
  processed++;
  
  if (result) {
    try {
      // Use INSERT OR IGNORE to preserve existing chapter counts
      if(!db.get('SELECT id FROM dex_mapping WHERE manga_id=?',[manga.id])){
        db.run('INSERT INTO dex_mapping(manga_id,dex_id,dex_title,total_chapters,readable_chapters,all_langs,last_checked) VALUES(?,?,?,?,?,?,?)',
          [manga.id, result.dex_id, result.dex_title, 0, 0, '', new Date().toISOString()]);
      }
    } catch {}
  } else {
    failed++;
  }
  
  const pct = (processed / allManga.length * 100).toFixed(1);
  if (processed % 200 === 0) {
    console.log(`[${pct}%] ${processed}/${allManga.length}, ok=${processed-failed}, fail=${failed}`);
    db.save();
    writeFileSync(STATE_PATH, JSON.stringify({ processed, lastId: manga.id }));
  }
}

db.save();
const mapped = db.all('SELECT COUNT(*) as c FROM dex_mapping')[0].c;
console.log(`\n=== DONE ===`);
console.log(`Total processed: ${allManga.length}`);
console.log(`Mapped in DB: ${mapped}`);
console.log(`Failed (not on MangaDex): ${failed}`);
process.exit(0);
