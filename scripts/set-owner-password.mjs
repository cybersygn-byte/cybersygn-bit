#!/usr/bin/env node
/**
 * Interactive helper to generate OWNER_USERNAME / OWNER_PASSWORD_SALT
 * / OWNER_PASSWORD_HASH and set them as wrangler secrets on the
 * cybersygn Worker.
 *
 * The password is read from stdin with TTY echo disabled, so it
 * never appears in your shell history, never gets pasted into a chat
 * log, never gets logged by node or by wrangler. The hash that
 * wrangler uploads is sha256(username + ':' + password + ':' + salt)
 * — same shape the worker's loginWithCredentials() expects.
 *
 * Usage from project root:
 *   node scripts/set-owner-password.mjs
 *
 * The script will:
 *   1. Prompt for username (echoed)
 *   2. Prompt for password (NOT echoed)
 *   3. Prompt for password confirmation
 *   4. Generate a fresh 16-byte salt
 *   5. Compute the salted SHA-256 hex hash
 *   6. Invoke wrangler 3 times to set the secrets
 *   7. Suggest a redeploy
 *
 * No password ever leaves your machine in any form except the hash.
 */

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { stdin, stdout } from 'node:process';

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve) => {
    stdout.write(prompt);
    if (!hidden) {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question('', (answer) => { rl.close(); resolve(answer.trim()); });
      return;
    }
    // Hidden input: turn off echo, swallow chars until enter.
    let buf = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    function onData(ch) {
      if (ch === '\r' || ch === '\n' || ch === '') {
        stdin.removeListener('data', onData);
        stdin.setRawMode && stdin.setRawMode(wasRaw);
        stdin.pause();
        stdout.write('\n');
        resolve(buf);
        return;
      }
      if (ch === '') { process.exit(130); }  // Ctrl+C
      if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); return; }  // backspace
      buf += ch;
    }
    stdin.on('data', onData);
  });
}

function wranglerSecretPut(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin.write(value + '\n');
    child.stdin.end();
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`wrangler exit ${code}`)));
  });
}

(async () => {
  console.log('CyberSygn owner-password setup.');
  console.log('Generates the salt, hash, and uploads the 3 wrangler secrets.');
  console.log('Password is never echoed, never logged, never pasted in chat.');
  console.log('');

  const username = await ask('Username: ');
  if (!username) { console.error('Username required.'); process.exit(1); }

  const password = await ask('Password (hidden): ', { hidden: true });
  if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  const confirm = await ask('Confirm password (hidden): ', { hidden: true });
  if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }

  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(`${username}:${password}:${salt}`, 'utf8').digest('hex');

  console.log('');
  console.log('Uploading 3 wrangler secrets...');
  await wranglerSecretPut('OWNER_USERNAME', username);
  await wranglerSecretPut('OWNER_PASSWORD_SALT', salt);
  await wranglerSecretPut('OWNER_PASSWORD_HASH', hash);

  console.log('');
  console.log('Secrets uploaded. Redeploying...');
  await new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'deploy'], { stdio: 'inherit' });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`deploy exit ${code}`)));
  });

  console.log('');
  console.log('Done. Try the portal:');
  console.log('  https://cybersygn.io/control/');
  console.log(`  Username: ${username}`);
  console.log('  Password: (what you typed)');
})().catch((err) => {
  console.error('FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
