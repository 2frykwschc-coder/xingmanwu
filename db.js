import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'data', 'xingmanwu.db');
let db;

export async function initDB() {
  const SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    const d = dirname(DB_PATH);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    db = new SQL.Database();
  }
  db.run("CREATE TABLE IF NOT EXISTS manga(id INTEGER PRIMARY KEY,title_romaji TEXT,title_english TEXT,title_native TEXT,cover_url TEXT,banner_url TEXT,description TEXT,format TEXT,manga_status TEXT,start_year INTEGER,genres TEXT,tags TEXT,score REAL,popularity INTEGER,favorites INTEGER,chapters INTEGER,volumes INTEGER,author TEXT,artist TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS collections(id INTEGER PRIMARY KEY AUTOINCREMENT,manga_id INTEGER NOT NULL UNIQUE,status TEXT DEFAULT 'plan_to_read',score INTEGER,progress INTEGER DEFAULT 0,notes TEXT,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  db.run("CREATE TABLE IF NOT EXISTS dex_mapping(manga_id INTEGER PRIMARY KEY,dex_id TEXT NOT NULL,dex_title TEXT,total_chapters INTEGER DEFAULT 0,readable_chapters INTEGER DEFAULT 0,all_langs TEXT,last_checked TEXT)");
  save();
}

function save() {
  writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.run("CREATE TABLE IF NOT EXISTS fix_alt (id INTEGER PRIMARY KEY AUTOINCREMENT, manga_id INTEGER UNIQUE, source TEXT, source_url TEXT, chapters INTEGER DEFAULT 0, source_title TEXT, updated_at TEXT)");
}

const p = {
  run: (s, p) => p && p.length ? db.run(s, p) : db.run(s),
  get: (s, p) => {
    const st = db.prepare(s);
    if (p) st.bind(p);
    const r = stmtStep(st);
    st.free();
    return r;
  },
  all: (s, p) => {
    const st = db.prepare(s);
    if (p) st.bind(p);
    const r = [];
    while (st.step()) r.push(st.getAsObject());
    st.free();
    return r;
  },
  transaction: f => (...a) => {
    db.run('BEGIN');
    try {
      const r = f(...a);
      db.run('COMMIT');
      save();
      return r;
    } catch(e) {
      try { db.run('ROLLBACK') } catch(_) {}
      throw e;
    }
  },
  save: () => save()
};

function stmtStep(st) {
  return st.step() ? st.getAsObject() : undefined;
}

export default p;
