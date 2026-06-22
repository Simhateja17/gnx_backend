# Globonexo Sales AI — Backend Structure Guide

**Goal:** Ensure the Express backend is properly structured, scalable, and easy for Manasa and Poojitha to work on in parallel.

**Owner:** Manasa (backend scaffolding + AI/voice), Poojitha (campaigns/leads/inbox routes)
**Reviewer:** Simha Teja

---

## 1. Repository Structure

**Physical skeleton files have been created in `backend/src/`.** Manasa and Poojitha implement the TODOs in each file.

```
globonexo-backend/
├── src/
│   ├── index.ts                    # Express app entry point
│   ├── config/
│   │   ├── env.ts                  # Environment variable loader + validation
│   │   └── constants.ts            # App-wide constants (plans, limits, etc.)
│   ├── routes/                     # API route definitions
│   │   ├── auth.routes.ts
│   │   ├── onboarding.routes.ts
│   │   ├── gmail.routes.ts
│   │   ├── campaigns.routes.ts
│   │   ├── leads.routes.ts
│   │   ├── emails.routes.ts
│   │   ├── inbox.routes.ts
│   │   ├── voice.routes.ts
│   │   ├── ai.routes.ts
│   │   ├── billing.routes.ts
│   │   ├── dashboard.routes.ts
│   │   ├── settings.routes.ts
│   │   ├── admin.routes.ts
│   │   └── support.routes.ts
│   ├── services/                   # Business logic layer
│   │   ├── auth.service.ts
│   │   ├── onboarding.service.ts
│   │   ├── gmail.service.ts
│   │   ├── campaigns.service.ts
│   │   ├── leads.service.ts
│   │   ├── apollo.service.ts
│   │   ├── email.service.ts
│   │   ├── inbox.service.ts
│   │   ├── voice.service.ts
│   │   ├── ai.service.ts
│   │   ├── billing.service.ts
│   │   ├── dashboard.service.ts
│   │   ├── settings.service.ts
│   │   ├── admin.service.ts
│   │   └── support.service.ts
│   ├── workers/                    # BullMQ job processors
│   │   ├── index.ts
│   │   ├── send-email.worker.ts
│   │   ├── poll-inbox.worker.ts
│   │   ├── schedule-call.worker.ts
│   │   └── enrich-leads.worker.ts
│   ├── lib/                        # Third-party client wrappers
│   │   ├── supabase.ts
│   │   ├── openai.ts
│   │   ├── retell.ts
│   │   ├── apollo.ts
│   │   ├── gmail.ts
│   │   ├── stripe.ts
│   │   ├── resend.ts
│   │   ├── redis.ts
│   │   └── posthog.ts
│   ├── middleware/                 # Express middleware
│   │   ├── auth.middleware.ts
│   │   ├── error.middleware.ts
│   │   ├── validate.middleware.ts
│   │   └── rate-limit.middleware.ts
│   ├── jobs/                       # Job enqueue helpers
│   │   ├── send-email.job.ts
│   │   ├── poll-inbox.job.ts
│   │   ├── schedule-call.job.ts
│   │   └── enrich-leads.job.ts
│   ├── schemas/                    # Zod validation schemas
│   │   ├── auth.schema.ts
│   │   ├── onboarding.schema.ts
│   │   ├── campaigns.schema.ts
│   │   └── leads.schema.ts
│   └── types/                      # Shared TypeScript types
│       └── index.ts
├── supabase/
│   └── migrations/
│       └── 001_initial.sql
├── deploy.sh                       # PM2 deployment script
├── ecosystem.config.js             # PM2 process config
├── .env.example
├── API_CONTRACT.md
├── PRD.md
└── TEAM_PLAN.md
```

---

## 2. Layer Responsibilities

### Routes

- Define HTTP endpoints.
- Apply middleware (auth, validation, rate limiting).
- Call services and return JSON responses.
- **No business logic here.**

Example:

```ts
// src/routes/campaigns.routes.ts
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createCampaignSchema } from '../schemas/campaigns.schema';
import * as campaignsService from '../services/campaigns.service';

const router = Router();

router.get('/', authenticate, campaignsService.listCampaigns);
router.post('/', authenticate, validate(createCampaignSchema), campaignsService.createCampaign);
router.post('/:id/launch', authenticate, campaignsService.launchCampaign);

export default router;
```

### Services

- Contain all business logic.
- Call `lib/` clients for external APIs.
- Call `jobs/` to enqueue background work.
- Return data or throw errors.

Example:

```ts
// src/services/campaigns.service.ts
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

export async function listCampaigns(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = req.organization.id;
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('organization_id', orgId);
    if (error) throw error;
    res.json({ campaigns: data });
  } catch (err) {
    next(err);
  }
}
```

### Workers

- Process BullMQ jobs.
- Each worker file handles one job type.
- Retry logic and idempotency live here.

### Lib

- Thin wrappers around third-party SDKs.
- No business logic.
- Centralizes API keys and base URLs.

### Middleware

- `auth.middleware.ts` — verify session cookie, attach user/org to request.
- `validate.middleware.ts` — validate request body with Zod.
- `rate-limit.middleware.ts` — limit public endpoints.
- `error.middleware.ts` — global error handler, format errors, log to Sentry.

### Jobs

- Helper functions to add jobs to BullMQ queues.
- Decouples services from queue implementation.

---

## 3. Auth & Session Flow

1. User signs up/logs in via `/api/auth/signup` or `/api/auth/login`.
2. Express calls Supabase Auth to create/verify user.
3. Express creates an HTTP-only cookie with the Supabase access token.
4. On every request, `auth.middleware.ts` verifies the JWT and fetches the organization.
5. `req.user` and `req.organization` are available in all authenticated routes.

---

## 4. Database Access Pattern

- Use Supabase service role key from `lib/supabase.ts`.
- Set `app.current_org_id` before queries if using RLS:

```ts
await supabase.rpc('set_config', { key: 'app.current_org_id', value: orgId });
```

- Always filter by `organization_id` in service queries as a safety net.

---

## 5. Job Queue Structure

| Queue Name | Worker File | Purpose |
|------------|-------------|---------|
| `send-email` | `workers/send-email.worker.ts` | Send individual emails via Gmail API |
| `poll-inbox` | `workers/poll-inbox.worker.ts` | Poll Gmail inbox for replies |
| `schedule-call` | `workers/schedule-call.worker.ts` | Trigger Retell outbound calls |
| `enrich-leads` | `workers/enrich-leads.worker.ts` | Enrich Apollo leads |

### Job Scheduling

- Use `BullMQ` repeatable jobs for polling (`poll-inbox` every 3 minutes).
- Use delayed jobs for sequence steps (`send-email` after `delay_days`).

---

## 6. External Client Setup

### Supabase (`src/lib/supabase.ts`)

```ts
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
```

### Redis (`src/lib/redis.ts`)

```ts
import IORedis from 'ioredis';
import { env } from '../config/env';

export const redis = new IORedis(env.REDIS_URL);
```

### Azure OpenAI (`src/lib/openai.ts`)

```ts
import { AzureOpenAI } from 'openai';
import { env } from '../config/env';

export const openai = new AzureOpenAI({
  endpoint: env.AZURE_OPENAI_ENDPOINT,
  apiKey: env.AZURE_OPENAI_API_KEY,
  apiVersion: '2024-02-01',
  deployment: env.AZURE_OPENAI_DEPLOYMENT_NAME,
});
```

### Retell (`src/lib/retell.ts`)

```ts
import Retell from 'retell-sdk';
import { env } from '../config/env';

export const retell = new Retell({ apiKey: env.RETELL_API_KEY });
```

### Apollo, Gmail, Stripe, Resend, PostHog

- Similar thin wrappers in `src/lib/`.
- All API keys read from `config/env.ts`.

---

## 7. Error Handling

All errors flow through `error.middleware.ts`:

```ts
// src/middleware/error.middleware.ts
import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  Sentry.captureException(err);
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.code,
  });
}
```

Custom error classes:

```ts
// src/types/errors.ts
export class AppError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
```

---

## 8. Logging

- Use `pino` or built-in `console` with structured logs.
- Forward logs to GCP Cloud Logging via Ops Agent.
- PM2 logs stored in `logs/` directory.

---

## 9. Security Checklist

- [ ] HTTPS only in production.
- [ ] CORS configured for `app.globonexo.com` only.
- [ ] Rate limiting on auth and webhook endpoints.
- [ ] Zod validation on all inputs.
- [ ] SQL injection prevention via Supabase query builder.
- [ ] XSS prevention by not rendering user input as HTML.
- [ ] Secrets in GCP Secret Manager, never in code.
- [ ] Refresh tokens encrypted at rest.

---

## 10. Testing

| Type | Location | Examples |
|------|----------|----------|
| Unit tests | `src/**/*.test.ts` | Prompt generation, CSV parsing, timezone logic |
| Integration tests | `tests/integration/*.test.ts` | Auth flow, campaign creation, email send |
| Smoke tests | `tests/smoke/*.test.ts` | End-to-end critical paths on staging |

Use `vitest` or `jest` + `supertest`.

---

## 11. Deployment

### Local Dev

```bash
cd globonexo-backend
cp .env.example .env
npm install
npm run dev
```

### Production Deploy

```bash
./deploy.sh
```

`deploy.sh`:

```bash
#!/bin/bash
set -e
git pull origin main
npm ci
npm run build
pm2 reload ecosystem.config.js --env production
```

### PM2 Config

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'globonexo-api',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
    },
    {
      name: 'globonexo-workers',
      script: './dist/workers/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      log_file: './logs/workers.log',
    },
  ],
};
```

---

## 12. API Versioning

For v0.1, all routes are prefixed with `/api` (no version).

Example: `https://api.globonexo.com/api/campaigns`

Versioning (`/api/v1/...`) is deferred to v0.2.
