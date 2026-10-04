#!/usr/bin/env node
// Adds `cgroup_parent: '${FN_CGROUP_PARENT:-system.slice}'` to every service of every <slug>/docker-compose.yaml
// (except gtm-sst, which is billed by requests and has its own limits). Run from the repo root:
//   node generator/add-cgroup-parent.js
// Idempotent: a service that already has the line is left alone.
//
// Why: FlyNode caps a Cloud Node subscription's apps TOGETHER by putting all their containers in one systemd slice.
// For these compose apps the slice name arrives as the FN_CGROUP_PARENT env var, set by flynode-api at deploy
// time. When it is not set the value is `system.slice`, which is Docker's own default parent with the systemd
// cgroup driver, so an app deployed without FlyNode's cap behaves exactly as before.
const fs = require('fs');
const path = require('path');

const LINE = "    cgroup_parent: '${FN_CGROUP_PARENT:-system.slice}'";
const SKIP = new Set(['gtm-sst', 'generator', 'node_modules']);
const root = path.join(__dirname, '..');
let files = 0;
let services = 0;

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
  const file = path.join(root, entry.name, 'docker-compose.yaml');
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  let inServices = false;
  let current = null; // index in `out` of the current service's header line
  let hasLine = false;
  const flush = () => {
    if (current !== null && !hasLine) {
      out.splice(current + 1, 0, LINE);
      services++;
    }
    current = null;
    hasLine = false;
  };
  for (const line of lines) {
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) {
      // a top-level key
      flush();
      inServices = line.startsWith('services:');
      out.push(line);
      continue;
    }
    if (inServices && /^  [A-Za-z0-9_.-]+:\s*$/.test(line)) {
      flush();
      out.push(line);
      current = out.length - 1;
      continue;
    }
    if (inServices && /^    cgroup_parent:/.test(line)) hasLine = true;
    out.push(line);
  }
  flush();
  const next = out.join('\n');
  if (next !== lines.join('\n')) {
    fs.writeFileSync(file, next);
    files++;
  }
}
console.log(`Added cgroup_parent to ${services} services in ${files} files.`);
