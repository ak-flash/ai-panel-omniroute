#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function usage() {
  console.error(
    'Usage: node scripts/store-backup.js <backup|restore|verify> --db <path> --backup <dir>'
  );
  process.exitCode = 2;
}

function args(argv) {
  const out = { command: argv[2] };
  for (let i = 3; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name.startsWith('--') || value == null) return null;
    out[name.slice(2)] = value;
  }
  return out;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

async function atomicCopy(source, destination) {
  const dir = path.dirname(destination);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = destination + '.tmp-' + process.pid + '-' + Date.now();
  try {
    await fsp.copyFile(source, temporary);
    await fsp.chmod(temporary, 0o600);
    await fsp.rename(temporary, destination);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function backup(db, backupDir) {
  const stat = await fsp.stat(db);
  if (!stat.isFile()) throw new Error('db must be a regular file');
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(backupDir, 'store.db');
  const digest = await sha256(db);
  await atomicCopy(db, target);
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    database: 'store.db',
    bytes: stat.size,
    sha256: digest,
    key: 'not included; restore the matching store.db.key or AIPANEL_MASTER_KEY separately',
  };
  await atomicCopyBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    path.join(backupDir, 'manifest.json')
  );
  console.log(`Backup created: ${backupDir}`);
}

async function atomicCopyBuffer(data, destination) {
  const dir = path.dirname(destination);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = destination + '.tmp-' + process.pid + '-' + Date.now();
  try {
    await fsp.writeFile(temporary, data, { mode: 0o600 });
    await fsp.rename(temporary, destination);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function verify(backupDir) {
  const manifest = JSON.parse(await fsp.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const db = path.join(backupDir, manifest.database);
  const stat = await fsp.stat(db);
  const digest = await sha256(db);
  if (manifest.format !== 1 || stat.size !== manifest.bytes || digest !== manifest.sha256) {
    throw new Error('backup integrity check failed');
  }
  return manifest;
}

async function restore(db, backupDir) {
  await verify(backupDir);
  await atomicCopy(path.join(backupDir, 'store.db'), db);
  console.log(`Backup restored: ${db}`);
}

async function main() {
  const options = args(process.argv);
  if (
    !options ||
    !['backup', 'restore', 'verify'].includes(options.command) ||
    !options.db ||
    !options.backup
  ) {
    usage();
    return;
  }
  try {
    if (options.command === 'backup') await backup(options.db, options.backup);
    else if (options.command === 'restore') await restore(options.db, options.backup);
    else {
      await verify(options.backup);
      console.log('Backup integrity OK');
    }
  } catch (error) {
    console.error(`Backup operation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { backup, restore, verify };
