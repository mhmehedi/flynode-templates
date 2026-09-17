#!/usr/bin/env node
// Reads catalog.json and writes one <slug>/docker-compose.yaml per app
// into the current directory (run this from inside a clone of
// flynode-templates). No Traefik labels, no memory-limit blocks — Coolify
// generates Traefik's routing itself from the docker_compose_domains API
// field at deploy time, and resource limits are passed as separate
// limits_memory/limits_cpus API params keyed to the customer's plan, not
// baked into the compose file. See coolify.service.ts's
// createPublicGitApplication/toDockerLimitFields for both.
//
// Zero npm dependencies on purpose — clone the repo and run
// `node generate-templates.js`, nothing to install first.
//
// Every service gets an explicit `expose:` for internalPort. Found via a
// real PocketBase deploy: Coolify normally auto-detects a compose
// service's port from the base image's own EXPOSE metadata to generate
// Traefik's loadbalancer.server.port label, but silently emits no port
// label at all when the image doesn't declare one — the container runs
// fine, Coolify still issues a route and a cert, but Traefik has nothing
// to forward to (a fresh cert-handshake-then-nothing failure, not the
// literal "no available server" text of a fully missing route). Every
// catalog entry needs an accurate internalPort now, not just for docs.
const fs = require('fs');
const path = require('path');

const DB_DATA_PATHS = {
  postgres: '/var/lib/postgresql/data',
  mariadb: '/var/lib/mysql',
  mysql: '/var/lib/mysql',
  mongo: '/data/db',
};
const DB_IMAGES = {
  postgres: 'postgres:16-alpine',
  mariadb: 'mariadb:11',
  mysql: 'mysql:8.0',
  mongo: 'mongo:7',
};
// `depends_on: [db]` alone only waits for the db CONTAINER to start, not
// for the database engine inside it to actually accept connections —
// found via a real Huginn deploy that failed its first boot outright
// ("Couldn't create 'huginn' database... issue connecting with your
// hostname: db") because MariaDB was still initializing when Huginn's
// own db:create ran, with no retry on Huginn's side. A healthcheck-gated
// `condition: service_healthy` makes Compose actually wait.
// CMD-SHELL runs via the container's own /bin/sh -c, so $POSTGRES_USER
// here resolves against that container's real runtime env — NOT the
// literal per-app username, which is what actually matters: every one
// of our postgres services sets a custom POSTGRES_USER (never the
// image's own default "postgres" role), so a hardcoded `-U postgres`
// fails with "role postgres does not exist" on every single one of
// them. Found live, in production: this exact bug shipped in the first
// version of this healthcheck and silently broke Directus, Umami, n8n,
// and Odoo (already-verified templates it was retroactively applied to)
// the moment a real customer would have tried to deploy any of them —
// caught by a real Kutt deploy hanging forever waiting on Postgres to
// report healthy, not by inspection.
const DB_HEALTHCHECKS = {
  postgres: ['CMD-SHELL', 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
  mariadb: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'],
  mysql: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
  // Same root-cause fix as postgres above — auth is enabled the moment
  // MONGO_INITDB_ROOT_USERNAME/PASSWORD are set (every mongo app here
  // sets them), so an unauthenticated ping would fail the same way.
  mongo: [
    'CMD-SHELL',
    'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand(\'ping\')"',
  ],
};

function yamlEnvBlock(env, indent) {
  const pad = ' '.repeat(indent);
  const entries = Object.entries(env);
  if (entries.length === 0) return `${pad}{}`;
  return entries.map(([k, v]) => `${pad}${k}: '${String(v).replace(/'/g, "''")}'`).join('\n');
}

// Builds the secondary `db` service block. Only the four engines above
// are supported — anything else in the catalog should go through the
// bespoke, hand-verified path instead (same as WordPress/Ghost/Uptime
// Kuma), not this generator.
//
// db.passwordSecret / db.rootPasswordSecret must name an entry in
// secretEnvKeys explicitly — do NOT infer these positionally (e.g.
// "last key in the list"). An earlier version of this script did exactly
// that and silently generated a db service whose password didn't match
// what the app itself connects with, for every app that also needed an
// unrelated secret (an encryption key, an app token) listed alongside
// the db password — caught by actually running the generator and reading
// the n8n output, not by inspection.
function buildDbService(app) {
  const { db, secretEnvKeys } = app;
  const image = DB_IMAGES[db.engine];
  if (!image) throw new Error(`${app.slug}: unsupported db.engine "${db.engine}"`);
  if (db.passwordSecret && !secretEnvKeys.includes(db.passwordSecret)) {
    throw new Error(`${app.slug}: db.passwordSecret "${db.passwordSecret}" is not in secretEnvKeys`);
  }
  if (db.rootPasswordSecret && !secretEnvKeys.includes(db.rootPasswordSecret)) {
    throw new Error(`${app.slug}: db.rootPasswordSecret "${db.rootPasswordSecret}" is not in secretEnvKeys`);
  }

  const dbEnv = {};
  const names = db.envVarNames || {};
  if (names.rootPassword) dbEnv[names.rootPassword] = `\${${db.rootPasswordSecret}}`;
  if (names.rootUsername) dbEnv[names.rootUsername] = db.username || 'root';
  if (names.database) dbEnv[names.database] = db.databaseName;
  if (names.user) dbEnv[names.user] = db.username;
  if (names.password) dbEnv[names.password] = `\${${db.passwordSecret}}`;

  return { image, env: dbEnv, dataPath: DB_DATA_PATHS[db.engine], volumeName: `${app.slug}-db-data` };
}

function generateCompose(app) {
  const appEnv = { ...app.appEnv, ...app.defaultEnv };
  const volumes = app.volumes || [];
  const volumeLines = volumes.map((v) => `      - ${v.name}:${v.path}`).join('\n');
  const volumeDecls = volumes.map((v) => `  ${v.name}:`);

  let dbSection = '';
  let dependsOn = '';
  if (app.requiresDb) {
    if (!app.db) throw new Error(`${app.slug}: requiresDb is true but db is null`);
    const { image, env, dataPath, volumeName } = buildDbService(app);
    const healthTest = DB_HEALTHCHECKS[app.db.engine];
    dependsOn = `\n    depends_on:\n      db:\n        condition: service_healthy`;
    dbSection = `\n  db:\n    image: '${image}'\n    environment:\n${yamlEnvBlock(env, 6)}\n    volumes:\n      - ${volumeName}:${dataPath}\n    healthcheck:\n      test: ${JSON.stringify(healthTest)}\n      interval: 5s\n      timeout: 5s\n      retries: 20\n    restart: unless-stopped\n`;
    volumeDecls.push(`  ${volumeName}:`);
  }

  // An empty YAML block sequence can't be spelled as a bare `[]` on its
  // own line under a block-mapping key — Node's `yaml` package parses it
  // leniently, but Coolify's own compose validator rejected it outright
  // ("services.umami.volumes must be a array") on a real verification
  // deploy. Omitting the key entirely when there's nothing under it is
  // the only form both parsers agree on.
  const lines = [
    'services:',
    `  ${app.slug}:`,
    `    image: '${app.dockerImage}'`,
    '    environment:',
    yamlEnvBlock(appEnv, 6),
    '    expose:',
    `      - '${app.internalPort}'`,
    ...(volumeLines ? ['    volumes:', volumeLines] : []),
    `${dependsOn}`,
    '    restart: unless-stopped',
    dbSection,
    ...(volumeDecls.length > 0 ? ['volumes:', volumeDecls.join('\n')] : []),
    '',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// This script lives in generator/, one level below the repo root — each
// app's docker-compose.yaml belongs at <repo root>/<slug>/, alongside
// every hand-authored template (wordpress/, ghost/, uptime-kuma/, ...),
// not nested under generator/ itself.
const REPO_ROOT = path.join(__dirname, '..');

function main() {
  const catalogPath = path.join(__dirname, 'catalog.json');
  const { apps } = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const lowConfidence = [];
  for (const app of apps) {
    const dir = path.join(REPO_ROOT, app.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yaml'), generateCompose(app));
    if (app.confidence === 'low') lowConfidence.push(app.slug);
    console.log(`wrote ${app.slug}/docker-compose.yaml (confidence: ${app.confidence})`);
  }

  console.log(`\nGenerated ${apps.length} templates.`);
  console.log('None of these are verified. Deploy each one for real and curl the live domain');
  console.log('before treating it as production-ready — same process WordPress/Ghost/Uptime Kuma went through.');
  if (lowConfidence.length > 0) {
    console.log(`\nLow-confidence entries (check image name/tag and env vars by hand first): ${lowConfidence.join(', ')}`);
  }
}

main();
