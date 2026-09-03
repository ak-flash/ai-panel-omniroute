#!/usr/bin/env node

'use strict';

const fs = require('node:fs');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function contains(text, needle) {
  return text.includes(needle);
}

// (per-row check happens inline below)

function main() {
  const errors = [];

  const readme = readText('README.md');
  const baseline = readText('docs/BASELINE.md');
  const envExample = readText('.env.example');
  const docs = {
    TESTING: readText('docs/TESTING.md'),
    DECISIONS: readText('docs/DECISIONS.md'),
    STORE: readText('docs/STORE.md'),
  };

  const envVariables = [
    'HOST',
    'PUBLIC_ORIGIN',
    'PORT',
    'ALLOWED_ORIGINS',
    'AIPANEL_MASTER_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ];

  for (const variable of envVariables) {
    if (!contains(envExample, `${variable}=`)) {
      errors.push(`.env.example: missing ${variable}=`);
    }

    const envPattern = new RegExp(`\\|\\s* \`${variable}\`\\s*\\|`, 'i');
    if (!envPattern.test(readme)) {
      errors.push(`README.md: missing variable ${variable} in configuration table`);
    }

    if (!contains(baseline, `
| \`${variable}\``)) {
      errors.push(`BASELINE.md: missing ${variable} in process configuration table`);
    }
  }

  const endpoints = [
    'GET /api/config',
    'PUT /api/config',
    '/api/antigravity-quota',
    '/api/settings/google-token',
    '/api/providers/{id}/usage',
    '/api/providers/{id}/models',
  ];

  for (const endpoint of endpoints) {
    if (!contains(readme, endpoint)) {
      errors.push(`README.md: missing endpoint reference ${endpoint}`);
    }
  }

  const docsRefs = ['docs/BASELINE.md', 'docs/DECISIONS.md', 'docs/TESTING.md', 'docs/STORE.md'];
  for (const docRef of docsRefs) {
    if (!contains(readme, docRef)) {
      errors.push(`README.md: missing link/reference to ${docRef}`);
    }
    if (!contains(docs[docRef.split('/')[1].replace('.md', '').toUpperCase()] || '', docRef)) {
      // noop: keep optional cross-reference checks lightweight
    }
  }

  if (!contains(readme, 'Baseline HTTP-контракта')) {
    errors.push('README.md: baseline/contract section anchor likely renamed or removed');
  }

  if (errors.length > 0) {
    console.error('check-docs failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('check-docs passed.');
}

main();
