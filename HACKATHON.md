# Build What's Next with PayPal and AI — Tefo Desk

## Project description

Tefo Desk is an AI payment assistant for small businesses. A seller describes what a customer wants in plain language; the assistant matches that request to the seller's real catalog and drafts an order. The seller reviews the items and catalog prices, confirms the order, and sends the customer to PayPal Checkout. Tefo Desk records payment only after the server verifies PayPal's capture result.

This connects two jobs that usually live in separate tools: understanding an order and getting it paid. It gives a small business a faster path from customer message to verified payment while keeping the business owner in control of every order and payment request.

AI cannot invent a price or choose a product outside the business catalog. Unclear requests become questions instead of orders. The owner must confirm the draft before checkout. PayPal credentials stay on the server, and the demo runs against PayPal Sandbox.

## Tools and how they are used

- **PayPal Orders v2 REST API (Sandbox):** create checkout orders, return the customer to PayPal for approval, capture approved orders server-side, and reconcile uncertain capture results. The webhook adapter verifies PayPal signatures and deduplicates events when a public HTTPS webhook URL is configured.
- **Google Gemini API:** interpret a customer's plain-language request into catalog product IDs, quantities, and clarification questions. The backend validates every product ID and quantity and computes the final prices from the database catalog.
- **Next.js, React, TypeScript:** responsive seller workspace and checkout-return experience.
- **Fastify, Prisma, PostgreSQL:** authenticated, workspace-scoped API; order state, audit history, and payment ledger.
- **Docker Compose:** local PostgreSQL for a repeatable judge setup.

Only PayPal and Gemini are required external services. Credentials are supplied by the developer in local environment variables; none are committed to this repository or exposed to the browser.

## Run the functional demo

Prerequisites: Node.js 22+, npm, and Docker Desktop with Compose. Create a PayPal Developer Sandbox REST app and a Gemini API key first. No live PayPal account credentials should be used.

1. In the repository root, create local environment files and start PostgreSQL:

   ```powershell
   Copy-Item .env.example .env
   docker compose up -d postgres
   npm.cmd ci
   npm.cmd run db:generate
   npm.cmd run db:migrate:dev
   ```

2. Edit the ignored root `.env` file. Keep `PAYPAL_ENV=sandbox` and set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from the PayPal Sandbox app. Set `AI_PROVIDER=gemini`, `AI_MODEL=gemini-3.5-flash-lite`, and `AI_API_KEY` from Google AI Studio. Keep secrets out of source control and chat. Restart the API after editing `.env`.

   ```dotenv
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=your_sandbox_client_id
   PAYPAL_CLIENT_SECRET=your_sandbox_secret
   AI_PROVIDER=gemini
   AI_MODEL=gemini-3.5-flash-lite
   AI_API_KEY=your_gemini_api_key
   ```

   These are local placeholders; replace them in `.env`, never in a tracked file. Gemini model availability can vary by project, so select a currently enabled model from [Google's Gemini model list](https://ai.google.dev/gemini-api/docs/models). Create the Gemini key in [Google AI Studio](https://aistudio.google.com/app/apikey) and Sandbox credentials in the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).

3. Seed a repeatable USD demo workspace. It has a ready-made draft order and three catalog products, including a $129.00 Starter Workflow Pack:

   ```powershell
   $env:ALLOW_DEV_SEED = 'true'
   npm.cmd run db:seed:dev
   Remove-Item Env:ALLOW_DEV_SEED
   ```

4. Start the backend in one terminal and the web app in another:

   ```powershell
   npm.cmd run dev
   ```

   ```powershell
   Set-Location frontend
   Copy-Item .env.example .env.local
   npm.cmd ci
   npm.cmd run dev
   ```

5. Open `http://localhost:3001` and sign in with `owner@example.test` / `ChangeMe123456`. Open **Order desk**, describe a customer request using the seeded catalog, review the Gemini proposal, create/confirm the order, then choose PayPal checkout. Approve the transaction with a PayPal Sandbox buyer account. The return flow asks the API to capture and verify payment before the dashboard marks it paid.

The demo login is only for a local development database. Do not expose it on a public host. PayPal Sandbox approvals do not move real funds. If Gemini is unavailable, the manual order workflow remains available but does not demonstrate the required AI integration. If PayPal credentials are missing, checkout stays disabled; configure both PayPal keys before recording the end-to-end video.

## Under-three-minute demo video outline

Record the actual running app with narration and no copyrighted music or unlicensed third-party material.

- **0:00–0:20 — Problem:** A small seller receives orders in informal messages and manually re-enters them before asking for payment.
- **0:20–0:55 — AI in action:** Enter a request such as “Maya wants two Starter Workflow Packs.” Show Gemini's proposed catalog item and quantity. Briefly show that the price comes from the catalog and that the seller reviews the draft.
- **0:55–1:15 — Human control:** Confirm the order and show its payment-pending state. Explain that the agent cannot create its own price or take payment without seller confirmation.
- **1:15–2:20 — PayPal in action:** Start Sandbox checkout, approve as a Sandbox buyer, return to Tefo Desk, and show the verified capture and updated dashboard.
- **2:20–2:50 — Why it matters:** Show the order record and explain how this shortens the path from customer request to verified payment for small businesses.

Do not record the merchant secret, Gemini key, browser password manager, or real customer information. Use the demo fixture and a Sandbox buyer.

## Hackathon progress

For this event, the project was advanced with the end-to-end PayPal/AI story in mind: the seller workspace was styled to present the request-to-payment flow, the demo seed now uses a PayPal-supported USD catalog with a starter draft order, and the repository gained an event-focused run guide, tool disclosure, video outline, and MIT license. The existing backend already validates Gemini catalog selections and uses PayPal Orders v2 for sandbox checkout and server-side capture.

## Repository and submission checklist

- [x] Project description and feature explanation.
- [x] PayPal and AI tools disclosed above.
- [x] Functional local setup and demo account documented.
- [x] Open-source MIT license included at repository root.
- [ ] Push this source tree to a public GitHub, GitLab, or Bitbucket repository and place that URL in the Devpost submission.
- [ ] Record and upload the working end-to-end video to YouTube as public or unlisted, then add its link to Devpost.
- [ ] Complete Devpost project metadata and submit before the deadline.
- [ ] Run the end-to-end flow with your own PayPal Sandbox merchant and buyer accounts and a live Gemini API key before recording.

The source tree is ready for a public repository, but this workspace is not currently initialized as a Git repository and has no hosted demo URL. A published submission still needs the author's public repository URL and video URL.
