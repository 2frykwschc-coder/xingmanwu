import { initDB, default as db } from './db.js';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const DEX_API = 'https://api.mangadex.org';
const DEX_HEADERS = { 'User-Agent': 'Xingmanwu/1.0' };
const STATE_PATH = fileURLToPath(new URL('./data/backfill_state.json', import.meta.url));
const BATCH_LOG = 200;

let state = { processed: 0, updated: 0, failed: 0 };
try {
  const raw = await fs.readFile(STATE_PATH, 'utf8');
  state = JSON.parse(raw);
} catch(e) {}

async function saveState(){
  await fs.writeFile(STATE_PATH, JSON.stringify(state));
}

async function dexFetch(url, retries=2){
  for(let i=0;i<=retries;i++){
    try{
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 6000);
      const r = await fetch(url, { headers: DEX_HEADERS, signal: ac.signal });
      clearTimeout(tm);
      if(r.ok) return r;
    } catch(e) {}
    if(i<retries) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function run(){
  await initDB();
  
  const all = db.all(`
    SELECT d.manga_id, d.dex_id, d.total_chapters
    FROM dex_mapping d
    WHERE (d.total_chapters = 0 OR d.total_chapters IS NULL)
      AND d.dex_id IS NOT NULL
  `);
  
  console.log(`Found ${all.length} entries to backfill. Already processed: ${state.processed}`);
  
  const remaining = all.slice(state.processed);
  if(remaining.length === 0){
    console.log('All done!');
    db.save();
    process.exit(0);
  }
  
  console.log(`Processing ${remaining.length} entries...`);
  let startTime = Date.now();
  let batchStart = startTime;
  
  for(let i=0; i<remaining.length; i++){
    const entry = remaining[i];
    const idx = state.processed + i;
    
    try{
      const r = await dexFetch(`${DEX_API}/manga/${entry.dex_id}/feed?limit=0`);
      if(r){
        const d = await r.json();
        const total = d.total || 0;
        db.run('UPDATE dex_mapping SET total_chapters=?, last_checked=? WHERE manga_id=?',
          [total, new Date().toISOString(), entry.manga_id]);
        if(total > 0) state.updated++;
      } else {
        state.failed++;
      }
    } catch(e) {
      state.failed++;
    }
    state.processed = idx + 1;
    
    if((idx+1) % BATCH_LOG === 0 || i === remaining.length - 1){
      const elapsed = Math.round((Date.now() - startTime)/1000);
      const batchElapsed = (Date.now() - batchStart)/1000;
      const batchCount = Math.min(BATCH_LOG, (idx+1) % BATCH_LOG || BATCH_LOG);
      const rate = batchCount / Math.max(batchElapsed, 1);
      
      console.log(
        `[${((state.processed/all.length)*100).toFixed(1)}%] ` +
        `${state.processed}/${all.length} ` +
        `ok=${state.updated} fail=${state.failed} ` +
        `${rate.toFixed(1)}/s ${elapsed}s`
      );
      
      db.save();
      await saveState();
      batchStart = Date.now();
    }
    
    // Rate limit: ~4 req/s
    await new Promise(r => setTimeout(r, 250));
  }
  
  db.save();
  await saveState();
  
  const totalMin = ((Date.now() - startTime)/1000/60).toFixed(1);
  const withCh = db.all('SELECT COUNT(*) as c FROM dex_mapping WHERE total_chapters > 0')[0].c;
  const total = db.all('SELECT COUNT(*) as c FROM dex_mapping')[0].c;
  
  console.log(`\n=== DONE ===`);
  console.log(`Processed: ${state.processed} | Updated: ${state.updated} | Failed: ${state.failed}`);
  console.log(`Time: ${totalMin} min`);
  console.log(`DB: ${withCh}/${total} now have chapter counts`);
  
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
