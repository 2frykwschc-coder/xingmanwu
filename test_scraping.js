// Test MangaKakalot search and reading
import { initDB, default as db } from './db.js';
await initDB();

const testManga = ['Naruto', 'Yowaki MAX Reijou Nano ni', 'Nagare Ookami', 'Cheopboui Byeol Season 2'];

for (const title of testManga) {
  console.log(`\n🔍 Searching: ${title}`);
  try {
    // Try MangaKakalot
    const url = 'https://manganato.com/search/story/' + encodeURIComponent(title.replace(/ /g, '_'));
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    
    // Extract links
    const items = html.match(/class="item_name"[^>]*>[\s\S]*?<\/a>/g) || [];
    console.log(`  MangaNato结果: ${items.length}个`);
    if (items.length > 0) {
      const first = items[0];
      const href = first.match(/href="([^"]+)"/)?.[1] || '';
      const name = first.replace(/<[^>]*>/g, '').trim();
      console.log(`  第一个: ${name} (${href})`);
      
      // Get chapter list
      if (href) {
        const chRes = await fetch(href, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const chHtml = await chRes.text();
        const chLinks = chHtml.match(/class="chapter-name"[^>]*>[\s\S]*?<\/a>/g) || [];
        const chh = chLinks.map(l => ({
          text: l.replace(/<[^>]*>/g, '').trim(),
          href: l.match(/href="([^"]+)"/)?.[1]
        }));
        console.log(`  章节: ${chh.length}话`);
        if (chh.length > 0) {
          console.log(`  最新: ${chh[0].text}`);
          
          // Try to get chapter pages
          const pageRes = await fetch(chh[0].href, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const pageHtml = await pageRes.text();
          const imgs = pageHtml.match(/src="https?:\/\/[^"]*\.(jpg|png|webp)[^"]*"/gi) || [];
          console.log(`  第1话图片: ${imgs.length}张`);
          if (imgs.length > 0) console.log(`  第一张: ${imgs[0].slice(5, -1)}`);
        }
      }
    }
  } catch(e) {
    console.log(`  ❌ 错误: ${e.message.slice(0, 60)}`);
  }
  await new Promise(r => setTimeout(r, 1000));
}
