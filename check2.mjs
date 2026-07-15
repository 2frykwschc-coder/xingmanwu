import {initDB, default as db} from './db.js';
await initDB();
const v = db.get("SELECT id, title_romaji, chapters FROM manga WHERE title_romaji LIKE '%Vagabond%'");
console.log('Vagabond:', v);
