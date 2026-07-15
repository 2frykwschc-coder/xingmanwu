import { initDB, default as db } from './db.js';
await initDB();

const API = 'https://graphql.anilist.co';
const sort = 'CHAPTERS_DESC';
const p = 1;
const query = `query($p:Int){Page(page:$p,perPage:50){media(type:MANGA,sort:[${sort}]){id}pageInfo{hasNextPage}}}`;
const res = await fetch(API, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ query, variables: { p } })
});
const d = await res.json();
console.log('hasNextPage:', d.data.Page.hasNextPage);
console.log('media count:', d.data.Page.media?.length);
