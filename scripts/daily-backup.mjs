#!/usr/bin/env node
/**
 * Daily Second Brain Backup - GitHub Archive
 * Runs at 00:00 to backup Obsidian vault and chat state
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHAT_DIR = join(process.env.HOME, 'chat');
const VAULT_DIR = join(process.env.HOME, 'Obsidian/민하의-세컨드-브레인');
const METADATA_DIR = join(VAULT_DIR, '_metadata');
const BACKUP_LOG = join(METADATA_DIR, 'backup-log.md');

try {
  console.log('🔄 Starting daily backup...');

  // Ensure metadata directory exists
  if (!existsSync(METADATA_DIR)) {
    mkdirSync(METADATA_DIR, { recursive: true });
  }

  // Backup Obsidian Vault
  process.chdir(CHAT_DIR);

  // Stage all changes
  execSync('git add -A', { stdio: 'inherit' });

  // Check if there are changes to commit
  try {
    const status = execSync('git diff --cached --exit-code').toString();
    if (status === '') {
      console.log('✓ No changes to backup');
      process.exit(0);
    }
  } catch (e) {
    // Changes exist, continue with backup
  }

  // Commit with timestamp
  const today = new Date().toISOString().split('T')[0];
  const timestamp = new Date().toISOString();
  try {
    execSync(`git commit -m "Daily Second Brain backup - ${today}"`, {
      stdio: 'inherit',
    });
  } catch (e) {
    console.log('✓ No changes to commit');
  }

  // Push to remote (optional - only if configured)
  try {
    const remotes = execSync('git remote -v').toString();
    if (remotes.includes('origin')) {
      execSync('git push origin master', { stdio: 'inherit' });
      console.log('✓ Pushed to GitHub');
    } else {
      console.log('ℹ No remote repository configured - local backup only');
    }
  } catch (e) {
    console.warn('⚠ Push failed - continuing with local backup');
  }

  // Record backup log
  const backupEntry = `## ${today}
- Time: ${timestamp}
- Status: ✓ Completed
- Files backed up: Obsidian vault + chat state

`;

  let currentLog = '';
  if (existsSync(BACKUP_LOG)) {
    currentLog = readFileSync(BACKUP_LOG, 'utf8');
  }

  writeFileSync(BACKUP_LOG, backupEntry + currentLog);

  console.log(`✓ Backup completed at ${timestamp}`);
  console.log('✓ Backup log updated');
} catch (err) {
  console.error('❌ Backup failed:', err.message);
  process.exit(1);
}
