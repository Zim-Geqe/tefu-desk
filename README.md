# Tefo Desk

Tefo means “payment” in Sesotho. Tefo Desk is a small-business order-to-payment workspace: a seller turns a customer’s plain-language request into a reviewable catalog order, confirms it, and collects payment through PayPal Checkout. Payment status is recorded only after the backend verifies the PayPal capture.

The project is being built for the **Build What’s Next with PayPal and AI** hackathon. The submission story and demo outline are in [HACKATHON.md](HACKATHON.md); local setup, API details, and deployment notes are below.

## Inspiration

Small businesses often receive orders in messages and then re-enter the details into a separate payment tool. Tefo Desk explores whether AI can help bridge that gap without taking control away from the seller. “Tefo” means payment in Sesotho, grounding the project in its South African context.

## What it does

- Turns a seller’s customer-request text into a proposed order using the business’s active product catalog.
- Asks for clarification instead of creating an order when the request is uncertain.
- Keeps the seller in control: every AI-generated order is a draft that must be reviewed and confirmed.
- Calculates prices from saved catalog data, not from AI output.
- Creates PayPal Checkout orders, captures approved payments on the server, and reconciles uncertain payment attempts.
- Provides workspace-scoped order, catalog, payment, refund, and activity views.

## How we built it

The web app is built with **TypeScript, React 19, and Next.js 16**. A **Node.js 22+ / Fastify 5** API uses **Prisma 6** with **PostgreSQL 16**. The API calls the **PayPal Orders v2 REST API** and the configured **Gemini API** directly over HTTPS; the project does not use a PayPal or AI client SDK. Gemini returns structured order suggestions, which the API validates before creating a draft. The local database runs with **Docker Compose**.

For the full stack and service disclosure, see [HACKATHON.md](HACKATHON.md). The repository also includes a Docker-based deployment configuration for a Linux VPS with Nginx and Certbot/Let’s Encrypt; it is a deployment recipe, not a claim that a hosted demo is currently available.

## License

This project is released under the [MIT License](LICENSE).

## Challenges we ran into

The main challenge is keeping AI suggestions separate from financial authority. Catalog IDs and quantities are validated by the API, amounts are calculated from the database, and seller confirmation is required before checkout. PayPal’s asynchronous approval, capture, webhook, and uncertain-result states also need careful handling so a redirect alone never marks an order as paid.

## Accomplishments that we're proud of

The repository contains a working full-stack path from an AI-assisted draft to PayPal Sandbox checkout and server-verified capture, plus persistent order/payment records, idempotency, and a local seeded demo workspace. Automated tests cover the AI output boundary, payment adapter behavior, and application flows; live provider credentials are needed to run external-service smoke tests.

## What we learned

Structured AI output still needs strict server-side validation; a model response must never be treated as a price or a payment instruction. We also learned to model payment attempts as stateful records and to reconcile with PayPal when a network timeout makes the outcome uncertain.

## What's next for Tefo Desk

Tefo Desk currently helps a seller turn a customer request into a reviewed catalog order and collect payment through PayPal. The next step is to grow that workflow into a more capable assistant for small businesses:

- Make order intake conversational across more channels, so sellers can bring in requests from messaging and email instead of copying them into the app.
- Extend the AI assistant beyond drafting orders to help with catalog updates, order summaries, and customer follow-ups, while keeping seller approval in control of important actions.
- Add clearer payment operations, including reliable webhook-driven updates, reconciliation, and a more complete view of refunds and outstanding orders.
- Build a localized Sesotho and English experience with terminology reviewed by Sesotho speakers, alongside payment options and currency support suited to South African businesses.
- Use feedback from small-business owners to prioritize practical improvements such as sales insights, repeat-customer workflows, and simpler day-to-day order management.

## Current scope and important limitations

- **Payments:** PayPal is configured for Sandbox by default. ZAR is currently unsupported by this Orders integration and is rejected rather than silently converted. The demo fixture uses USD. Do not use live credentials for the hackathon demo.
- **AI:** Gemini is the documented/demo provider; the backend also supports OpenAI and compatible chat-completions endpoints. AI is disabled until configured both in the backend environment and in **Business settings → AI order assistant**. The app does not localize the AI flow to Sesotho.
- **Data sent to AI:** The customer request and active catalog names, descriptions, and SKUs are sent to the configured provider to make a draft. Do not include sensitive customer data; review the provider’s terms and data-retention policy.
- **Messaging:** Follow-up text can be drafted from order state, but it is not sent by the application.
- **Hosting:** Source includes VPS deployment files. The judge-ready local setup below is the supported run path; configure and verify a hosted deployment separately.

## Requirements

- Node.js 22 LTS (or later supported LTS)
- Docker Desktop with Compose
- A PayPal developer sandbox REST app for checkout smoke tests
- Optional Gemini, OpenAI, or OpenAI-compatible API credentials for AI smoke tests

## Local setup (Windows PowerShell)

```powershell
Copy-Item .env.example .env
docker compose up -d postgres
npm.cmd ci
npm.cmd run db:generate
npm.cmd run db:migrate:dev
npm.cmd run dev
```

The API listens on `http://localhost:3000`; OpenAPI UI is at `http://localhost:3000/docs`. The Tefo Desk web app runs at `http://localhost:3001`, which is the default `APP_ORIGIN` for credentialed API requests. PostgreSQL is published on host port `55432` to avoid conflicts with local PostgreSQL services. `GET /health` is process health and `GET /ready` checks the live PostgreSQL connection. The first command copies safe local defaults. Set a unique database password before exposing PostgreSQL beyond localhost.

For the hackathon AI demo, first edit the root `.env`: set `AI_PROVIDER=gemini`, choose an `AI_MODEL` enabled for your Google AI project, and set `AI_API_KEY`. For PayPal, provide your Sandbox app's `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`; keep `PAYPAL_ENV=sandbox`. Restart the API after changing `.env`. Never use or publish live credentials for the demo.

## Web application (Windows PowerShell)

In a second terminal after starting the API, install and configure the frontend:

```powershell
Set-Location frontend
Copy-Item .env.example .env.local
npm.cmd ci
npm.cmd run dev
```

The browser app uses the HttpOnly `tefo_session` cookie and requests `http://localhost:3000/api/v1` with credentials. Keep the API `APP_ORIGIN=http://localhost:3001` so Fastify permits the frontend origin. If the API is hosted elsewhere, set `NEXT_PUBLIC_API_BASE_URL` in `frontend/.env.local` and set the API `APP_ORIGIN` to the exact frontend origin. Localhost ports are same-site for the API's SameSite=Strict session cookie. For production, use HTTPS and deploy on the same site.

Frontend checks and production build (run from `frontend`):

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The UI reads live workspace data only. `GET /api/v1/workspaces/{workspaceId}/settings/paypal` returns safe PayPal environment/configuration status and the backend's supported currency list; it never returns credentials. To enable the seeded workspace's AI order assistant, open **Business settings → AI order assistant**, choose the same provider and model as the backend `.env`, then save. Provider credentials remain server-side. Messaging delivery and sending follow-ups are not implemented by the API.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `APP_ORIGIN` | Exact frontend origin permitted for credentialed CORS |
| `COOKIE_SECURE` | Set `true` behind HTTPS in deployment |
| `SESSION_TTL_DAYS` | Session expiry (1–90 days) |
| `PAYPAL_ENV` | Explicit `sandbox` (default) or `live` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Server-side PayPal REST credentials; both required together |
| `PAYPAL_WEBHOOK_ID` | Webhook ID registered in the matching PayPal environment |
| `AI_PROVIDER` | `none` (default), `gemini`, `openai`, or `compatible` |
| `AI_MODEL`, `AI_API_KEY` | Model and server-side provider key; required when AI is enabled |
| `AI_BASE_URL` | Base URL for compatible provider (for example an `/v1` endpoint) |
| `AI_TIMEOUT_MS`, `AI_MAX_RETRIES` | Bounded provider request settings |
| `LOG_LEVEL` | Pino log level |

Secrets must be injected by the runtime secret manager in deployment. Do not commit `.env`. User-facing AI settings only select the provider and model enabled in deployment; API keys are not stored in PostgreSQL.

## Database and development fixtures

Use `npm.cmd run db:migrate:dev` locally to create/update a checked-in migration, and `npm.cmd run db:migrate` to apply committed migrations in deployed environments. Production startup does not mutate the schema. Explicit development fixtures are opt-in:

```powershell
$env:ALLOW_DEV_SEED = 'true'
npm.cmd run db:seed:dev
Remove-Item Env:ALLOW_DEV_SEED
```

The fixture login is `owner@example.test` / `ChangeMe123456`; use only in local development and never expose it to a network. Fixtures create a USD business, three catalog products, and a sample draft order so the PayPal Sandbox flow can be tried without first creating catalog data. Seeding is repeatable and resets the demo account password. Before production migrations, take a database backup and rehearse restore and migration against a staging copy. Configure encrypted backups, retention, monitoring and tested restore procedures; this repository does not operate backups for you.

## Authentication and frontend contract

Register with `POST /api/v1/auth/register` using `{email,password,name,workspaceName}`. A successful response sets an HttpOnly, SameSite=Strict `tefo_session` cookie; store no bearer token in browser storage. Send credentials for same-origin requests (or `credentials: 'include'` for a configured cross-origin frontend). Use `GET /api/v1/auth/me` to retrieve workspaces. Logout invalidates the server session. Cookie-authenticated writes require the same-site cookie policy and strict CORS origin; deploy the frontend and API on the same site. Do not pass workspace IDs as authority: every workspace route checks membership on the server. Orders from AI remain drafts until the user calls the explicit confirm endpoint.

Money fields are integer minor units and product currency must match the business currency. Product deletion deactivates a product; historical order item descriptions and prices are snapshots. PayPal only accepts currencies supported by its Orders API; ZAR is currently rejected by this integration rather than converted silently. Sandbox captures are not live funds.

## PayPal Sandbox setup and smoke test

1. In the PayPal Developer Dashboard create a Sandbox REST app and copy its client ID and secret into `.env` (`PAYPAL_ENV=sandbox`). Never use live credentials for this test.
2. Register the webhook URL `https://YOUR_PUBLIC_HOST/api/v1/paypal/webhook/WORKSPACE_ID` in that sandbox app. Subscribe to `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.PENDING`, and `PAYMENT.CAPTURE.REFUNDED`; copy the webhook ID into `PAYPAL_WEBHOOK_ID`.
3. Because local PayPal webhooks need a public HTTPS endpoint, use a controlled HTTPS tunnel for local smoke testing and set the exact webhook URL in PayPal. Keep the tunnel private and remove it afterward.
4. Register/login, create a USD business/catalog item (or another supported PayPal currency), create an order, confirm it, then call the checkout endpoint with a unique idempotency key. Open the returned approval URL and approve with a PayPal sandbox buyer account.
5. After redirect, call the server capture endpoint using the returned payment attempt ID. Confirm the API reports captured only after PayPal’s completed capture and the dashboard records captured value. Also verify duplicate checkout calls with the same key return the same attempt.

Automated PayPal tests below mock HTTP at the adapter boundary; they are not a real sandbox smoke test. The webhook route verifies signatures through PayPal’s official verification endpoint and deduplicates event IDs.

## AI provider configuration and smoke test

Choose exactly one provider in `.env`, supply a model enabled for that provider and a key, and for a compatible service set `AI_BASE_URL` to its OpenAI-compatible API base. The adapter supports Gemini `generateContent` structured JSON and OpenAI chat completions JSON mode. Compatible endpoints may implement different options; unsupported behavior fails safely. Restart after changing environment settings, sign in, and save that same provider/model under **Business settings → AI order assistant**. `GET /api/v1/workspaces/{workspaceId}/settings/ai` reports non-secret health. Create active catalog items and call `POST /api/v1/workspaces/{workspaceId}/orders/draft-from-request` with a real customer request. Verify it matches only returned catalog IDs; ambiguous requests return questions and no order. This manual smoke test requires a real provider credential. AI output is validated and prices are recomputed by the backend.

## Endpoint inventory

All product endpoints are under `/api/v1`; protected endpoints require the session cookie.

| Method | Path | Use |
| --- | --- | --- |
| GET | `/health`, `/ready` | Process and DB readiness |
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Account and session lifecycle |
| GET | `/auth/me` | User and authorized workspace list |
| POST | `/workspaces` | Create another workspace owned by the current user |
| GET/POST | `/workspaces/{workspaceId}/members` | List members and add an existing registered user |
| PATCH/DELETE | `/workspaces/{workspaceId}/members/{memberUserId}` | Change eligible role or remove member |
| GET/PATCH | `/workspaces/{workspaceId}/business` | Business profile and currency |
| GET/POST | `/workspaces/{workspaceId}/products` | List/create catalog entries |
| PATCH/DELETE | `/workspaces/{workspaceId}/products/{productId}` | Edit/deactivate catalog entry |
| GET/POST | `/workspaces/{workspaceId}/orders` | Search/filter/paginate and create order |
| GET | `/workspaces/{workspaceId}/orders/{orderId}` | Inspect order |
| PATCH | `/workspaces/{workspaceId}/orders/{orderId}` | Edit customer details or line items on a draft |
| POST | `/workspaces/{workspaceId}/orders/draft-from-request` | AI-assisted draft proposal |
| POST | `/workspaces/{workspaceId}/orders/{orderId}/confirm` | Confirm draft and record actor/time |
| POST | `/workspaces/{workspaceId}/orders/{orderId}/cancel` | Cancel eligible order |
| POST | `/workspaces/{workspaceId}/orders/{orderId}/follow-up-draft` | Draft unsent follow-up using real state |
| GET/PATCH | `/workspaces/{workspaceId}/settings/ai` | Provider health and safe selection |
| GET | `/workspaces/{workspaceId}/settings/paypal` | Safe environment/configuration and server-supported checkout currencies |
| POST | `/workspaces/{workspaceId}/orders/{orderId}/paypal-checkout` | Create/reuse PayPal checkout attempt |
| POST | `/workspaces/{workspaceId}/payment-attempts/{attemptId}/capture` | Server-side capture and validation |
| POST | `/workspaces/{workspaceId}/payment-attempts/{attemptId}/reconcile` | Recheck an uncertain capture with PayPal |
| POST | `/paypal/webhook/{workspaceId}` | Verified/deduplicated PayPal events |
| GET | `/workspaces/{workspaceId}/dashboard` | Order, captured, refund, net-paid and activity summaries |

OpenAPI UI is `/docs`. Follow-up text is never delivered by this service.

## Scripts

`npm.cmd run dev`, `npm.cmd run build`, `npm.cmd run start`, `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run test:integration`, `npm.cmd run db:check`, `npm.cmd run db:generate`, `npm.cmd run db:migrate`, `npm.cmd run db:migrate:dev`, and explicit `npm.cmd run db:seed:dev`.

For PostgreSQL-backed API tests, set `TEST_DATABASE_URL` to a disposable migrated database and run `npm.cmd run test:integration`. For the local Compose database in PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://tefo:tefo_local_password@localhost:55432/tefo_desk?schema=public'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm.cmd run db:migrate
npm.cmd run test:integration
```

## Deployment

For the prepared Docker, Nginx, TLS and VPS port setup for `tefudesk.fastlaneorders.online`, see [DEPLOYMENT.md](DEPLOYMENT.md). It keeps the app ports private on loopback, uses a separate PostgreSQL volume, applies migrations as a deployment step, and leaves other VPS containers untouched. A PayPal create timeout returns a reconciliation handle; retry reconciliation with the same attempt ID. Capture timeouts remain uncertain until PayPal is queried, so the client must reconcile before another capture request.

## Verification status

Unit tests cover money safety, configuration, AI schema/catalog validation, PayPal HTTP behavior, and PayPal webhook signature verification with mocked external HTTP. Database-backed integration tests cover readiness, registration/login/logout, tenant isolation, membership, order snapshots and edits, idempotent checkout/capture, denied payment retry, unsupported-currency rejection, uncertain-create reconciliation, partial/full refunds, and webhook retry/deduplication. They do not replace a real Gemini/OpenAI request or PayPal sandbox transaction/webhook smoke test; those need provider credentials.
