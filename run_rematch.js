// Wrapper: runs rematch.js and logs output
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const LOG = '/tmp/rematch_cron.log';

const child = spawn('node', [join(DIR, 'rematch.js')], {
  cwd: DIR,
  stdio: ['ignore', 'pipe', 'pipe']
});

const outStream = fs.createWriteStream(LOG, { flags: 'a' });
child.stdout.pipe(outStream);
child.stderr.pipe(outStream);

child.on('exit', (code) => {
  outStream.write(`\n--- rematch exit code ${code} at ${new Date().toISOString()} ---\n`);
  outStream.end();
  process.exit(code ?? 1);
});
