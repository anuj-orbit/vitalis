# app-template

Starter for apps built by the Orbit AI Dev Team and deployed with Coolify on the Oracle server.

## Contract every app keeps

| Rule | Why |
|---|---|
| Listens on `PORT` (default 3000), host `0.0.0.0` | Coolify/Traefik routes to it |
| `GET /health` returns 200 when healthy | Docker healthcheck and deploy verification |
| Config only from env vars: `DATABASE_URL`, `MONGODB_URI`, ... | Secrets live in Coolify, never in git |
| `Dockerfile` at repo root | Coolify builds it on the ARM server |
| `npm run lint` and `npm test` pass | CI gate before deploy |

## Run locally

```bash
npm ci
npm test
npm start          # http://localhost:3000
```

## CI/CD

`.github/workflows/ci.yml` runs lint and tests, then a Docker build. On `main` it then calls the Coolify deploy API. That last step needs:

- repo **variable** `COOLIFY_APP_UUID`
- repo **secrets** `COOLIFY_API_URL` and `COOLIFY_DEPLOY_TOKEN`

Without them, the deploy step is skipped.
