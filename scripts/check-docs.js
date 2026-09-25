#!/usr/bin/env node

'use strict';

// Сверка документации с кодом (npm run lint:docs, CI):
//   1. переменные окружения: src/config.js (ENV_VARS) ↔ таблица README ↔ .env.example;
//   2. process.env читается только в src/config.js;
//   3. каждый провайдер реестра (providers/index.js) описан в таблице README;
//   4. каждый маршрут сервера (router.add в src/) упомянут в README;
//   5. локальные ссылки в Markdown и упоминания docs/*.md в коде ведут на существующие файлы.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CODE_DIRS = ['src', 'providers', 'public', 'scripts'];
const CODE_FILES = ['server.js'];
const MARKDOWN_FILES = ['README.md', 'IMPROVEMENT_PLAN.md'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function listJsFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function checkEnvVars(errors, readme) {
  const { ENV_VARS } = require('../src/config');
  const declared = new Set(ENV_VARS);
  const inReadme = new Set([...readme.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]));
  const inExample = new Set(
    [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1])
  );
  for (const name of declared) {
    if (!inReadme.has(name)) errors.push(`README.md: нет переменной ${name} в таблице настроек`);
    if (!inExample.has(name)) errors.push(`.env.example: нет строки ${name}= (можно закомментированной)`);
  }
  for (const name of inReadme) {
    if (!declared.has(name)) errors.push(`README.md: переменная ${name} не читается кодом (нет в ENV_VARS)`);
  }
  for (const name of inExample) {
    if (!declared.has(name)) errors.push(`.env.example: переменная ${name} не читается кодом (нет в ENV_VARS)`);
  }
}

function checkEnvReads(errors, files) {
  for (const rel of files) {
    if (rel === path.join('src', 'config.js') || rel.startsWith('public' + path.sep)) continue;
    // Передавать process.env целиком в src/config.js можно; читать переменные — нет
    if (/process\.env(?:\.[A-Za-z_]|\[)/.test(read(rel))) {
      errors.push(`${rel}: process.env читается вне src/config.js — добавьте переменную в конфигурацию`);
    }
  }
}

function checkProviders(errors, readme) {
  const { loadProviders } = require('../providers');
  for (const provider of loadProviders({ log: () => {} })) {
    if (!readme.includes(`| **${provider.name}** |`)) {
      errors.push(`README.md: провайдер «${provider.name}» (${provider.id}) не описан в таблице «Провайдеры»`);
    }
  }
}

function checkRoutes(errors, readme, files) {
  const routeRe = /router\.add\(\s*(?:\[[^\]]*\]|'[A-Z]+'|[A-Z_]+)\s*,\s*'([^']+)'/g;
  const seen = new Set();
  for (const rel of files.filter((f) => f.startsWith('src' + path.sep))) {
    for (const [, route] of read(rel).matchAll(routeRe)) {
      if (route === '*' || seen.has(route)) continue;
      seen.add(route);
      const needle = route.replace(/\/\*$/, '/').replace(/:([A-Za-z]+)/g, '{$1}');
      if (!readme.includes(needle)) errors.push(`README.md: маршрут ${route} (${rel}) не описан`);
    }
  }
}

function checkLinks(errors, files) {
  for (const rel of MARKDOWN_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    for (const [, target] of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const file = decodeURI(target.split('#')[0]);
      if (file && !fs.existsSync(path.join(ROOT, path.dirname(rel), file))) {
        errors.push(`${rel}: ссылка на несуществующий файл ${target}`);
      }
    }
  }
  for (const rel of files) {
    for (const [ref] of read(rel).matchAll(/docs\/[\w.-]+\.md/g)) {
      if (!fs.existsSync(path.join(ROOT, ref))) errors.push(`${rel}: упоминание несуществующего ${ref}`);
    }
  }
}

function main() {
  const errors = [];
  const readme = read('README.md');
  const files = [...CODE_FILES, ...CODE_DIRS.flatMap(listJsFiles)];

  checkEnvVars(errors, readme);
  checkEnvReads(errors, files);
  checkProviders(errors, readme);
  checkRoutes(errors, readme, files);
  checkLinks(errors, files);

  if (errors.length > 0) {
    console.error('check-docs failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('check-docs passed.');
}

main();
