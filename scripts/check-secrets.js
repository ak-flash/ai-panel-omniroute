#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE_EXTS = ['.js', '.md', '.json', '.yml', '.yaml', '.html', '.css'];

const SENSITIVE_PATTERNS = [
  // 64-hex-строки (AIPANEL_MASTER_KEY)
  /\b[0-9a-fA-F]{64}\b/,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // AWS access keys
  /\bAKIA[0-9A-Z]{16}\b/,
  // OpenAI-style keys
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // GitHub tokens
  /\bghp_[A-Za-z0-9]{30,}\b/,
];

function isProbablyFixture(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  return rel.startsWith('test/') || rel.startsWith('tests/');
}

function isProbablyDocumentation(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  return rel.startsWith('docs/') || rel === 'README.md';
}

function walk(dir, list = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'coverage' || entry.name === 'playwright-report' || entry.name === 'logs' || entry.name === 'data') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, list);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (FILE_EXTS.includes(ext)) {
        list.push(full);
      }
    }
  }
  return list;
}

/** Файлы репозитория (индекс git); без git — обход каталога. Так в проверку
 * не попадают локальные артефакты, которые не коммитятся. */
function listFiles(root) {
  try {
    const out = require('node:child_process').execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\0')
      .filter((rel) => rel && FILE_EXTS.includes(path.extname(rel)))
      .map((rel) => path.join(root, rel))
      .filter((file) => fs.existsSync(file));
  } catch {
    return walk(root);
  }
}

function main() {
  const root = process.cwd();
  const files = listFiles(root);
  const bad = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel === '.env' || rel.startsWith('.env.')) {
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    if (isProbablyFixture(file) || isProbablyDocumentation(file)) {
      // Только логируем, но не валим — в фикстурах/доках значения могут
      // присутствовать осознанно. Усиливать фильтр нужно отдельно.
      continue;
    }
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        bad.push(`${rel}: pattern ${pattern}`);
        break;
      }
    }
  }

  if (bad.length > 0) {
    console.error('check-secrets failed: обнаружены шаблоны потенциальных секретов:');
    for (const line of bad) {
      console.error(`- ${line}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('check-secrets passed: явных секретов в исходниках не найдено');
}

main();
