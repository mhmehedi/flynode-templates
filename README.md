# flynode-templates

Docker Compose templates for FlyNode's app-template deployments. These are
deployed as Coolify Applications (not Coolify's built-in Service catalog),
because Applications support setting a custom FQDN at creation — Coolify's
Service resources (the one-click catalog) reject that field entirely.

Each subdirectory is one template, referenced by `apps/api/src/deployments/app-templates.ts`.
