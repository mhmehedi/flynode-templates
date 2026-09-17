# Template generator

`catalog.json` holds metadata for every app that fits the generic "one
app image + optionally one database" shape. `generate-templates.js`
reads it and writes each app's `docker-compose.yaml` to `../<slug>/`
(the repo root, alongside every hand-authored template).

```bash
node generator/generate-templates.js
```

No dependencies to install — it's plain Node, run from a clone of this
repo.

## What it deliberately does not do

- **No Traefik labels.** Coolify generates its own Traefik routing from
  the `docker_compose_domains` field set via its API at deploy time.
  Hand-written labels would create a second, conflicting router
  definition for the same service.
- **No memory/CPU limits in the YAML.** Those are passed as
  `limits_memory`/`limits_cpus` API parameters, driven by the customer's
  plan — baking a number into the compose file would hardcode one limit
  for every customer regardless of plan.

## Per-app fields

Beyond the basics (`appName`, `slug`, `dockerImage`, `internalPort`,
`defaultEnv`), a few fields exist because a real deploy failure proved
they were necessary — not because they seemed like a good idea in
advance:

- `requiresDb` / `db` — most apps need a database; `db.passwordSecret`/
  `db.rootPasswordSecret` must name an entry in `secretEnvKeys`
  explicitly (never infer this positionally — an early version did that
  and silently mismatched the app's password against its own database).
- `secretEnvKeys` / `secretFormats` — random secrets generated per
  deploy; `secretFormats: { KEY: 'laravel-key' }` for apps that reject a
  plain hex string (BookStack, InvoiceNinja, Crater, Bagisto all need
  Laravel's `base64:` + 32-byte format).
- `urlEnvKey` / `urlHostEnvKey` — some apps need their own public URL
  injected (they don't auto-detect it from request headers the way
  WordPress does); `urlHostEnvKey` is the bare-hostname variant for apps
  like Shlink that break if given a full `https://` URL.
- `confidence` — `'high' | 'medium' | 'low' | 'verified'`. Everything
  starts unverified; flip to `'verified'` only after a real deploy →
  curl → teardown cycle, the same one every app in this repo has gone
  through. `'low'` means the image name/tag or env vars are a best
  guess, not something run.

## Apps that don't fit this shape

`bespoke-apps.json` lists the ones that need more than one
app+optional-db service (Supabase, Chatwoot, Discourse, ...) or don't
have a generic pre-built image at all (Strapi, Payload CMS). Each needs
its own hand-authored `docker-compose.yaml` and the same real
verification, not this generator.
