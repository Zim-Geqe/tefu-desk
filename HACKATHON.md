# Tefo Desk — Build What's Next with PayPal and AI

## Inspiration

Tefo means “payment” in Sesotho, a South African language. Small businesses often receive customer orders in messages, re-enter them into a catalog or order book, and then switch tools again to collect payment. We wanted to explore how AI could reduce that manual handoff while leaving the business owner in control.

## What it does

Tefo Desk is a business workspace that moves an order from customer request to PayPal payment:

1. A seller enters a customer request in English, Sesotho, or a mix of the two.
2. AI proposes products and quantities from the seller’s active catalog, or asks questions if the request is unclear.
3. AI provides a short match note for each suggested product so the seller can see why it was selected. Tefo Desk calculates prices from catalog records and saves the proposal as a draft.
4. The seller reviews and confirms the order.
5. Mission Control tracks the saved order and payment activity, distinguishes buyer approval from capture, and points to the next seller action. The customer approves PayPal Checkout, and the backend captures and verifies the payment before marking the order paid. Tefo Desk then shows the resulting payment record linking the original request, order, amount, and PayPal capture ID.

AI cannot add an unlisted product or set a price, and it cannot initiate checkout without the seller confirming the draft. The app also includes manual order creation, order and catalog management, payment reconciliation, and payment/refund activity.

## How we built it

### Tools and technologies

- **Languages:** TypeScript; SQL through Prisma migrations; CSS for the web interface.
- **Frontend:** Next.js 16, React 19, and Lucide React icons.
- **Backend:** Node.js 22+ and Fastify 5, with Zod request/config validation.
- **Database:** PostgreSQL 16, accessed through Prisma 6.
- **Payments:** PayPal Orders v2 REST API in Sandbox for checkout creation, approval, server-side capture and reconciliation. The app can verify and deduplicate PayPal webhooks when configured.
- **AI:** Google Gemini API for structured order proposals. The backend also has adapters for OpenAI and OpenAI-compatible chat-completions APIs. It calls provider APIs directly over HTTPS; no AI SDK is used.
- **Security and API documentation:** Argon2id password hashing, HttpOnly session cookies, Fastify security plugins, and OpenAPI/Swagger UI.
- **Local development and deployment:** Docker Compose for PostgreSQL and a Linux VPS deployment recipe using Docker Compose, Nginx, and Certbot/Let’s Encrypt.

### What the AI and PayPal do

The AI receives the customer request and active catalog names, descriptions, and SKUs; it is prompted to interpret English, Sesotho, or mixed-language requests and returns product IDs, quantities, match notes, clarification questions, and an explanation. Language quality is model-dependent and has not yet been validated with Sesotho speakers. The server validates the response against the workspace catalog and computes amounts from database prices. PayPal credentials remain in the backend environment. Checkout approval is not treated as payment: the backend captures through PayPal and checks the capture result before updating the order. The verified payment record is generated from the persisted order and capture, not from AI output.

## Challenges we ran into

The key challenge was making AI useful without making it authoritative over money. Model output must be treated as untrusted: product IDs and quantities are checked, prices are never accepted from the model, uncertain requests should become clarification questions, and a human must confirm an order.

Payment flows also have more than a success and failure state. A browser can close or a network request can time out while PayPal is still processing, so the app records payment attempts and supports reconciliation instead of assuming that a redirect or timeout tells the whole story.

## Accomplishments that we're proud of

- Built the end-to-end seller flow: English/Sesotho/mixed-language AI-assisted draft with per-item match notes, human review, PayPal Sandbox checkout, server-side capture, and a persisted payment record.
- Kept prices anchored to the database catalog and made order confirmation an explicit seller action.
- Built Mission Control to present persisted order/payment events, the current payment state, and the next action without treating a PayPal redirect or buyer approval as proof of payment.
- Added workspace-scoped records, idempotent checkout attempts, payment reconciliation, and webhook signature verification/deduplication support.
- Added a repeatable local demo workspace with three USD catalog items and a draft order, plus automated tests for core logic and mocked provider/payment boundaries.

## What we learned

Structured output does not make an AI response trustworthy; the server still needs to validate every field and make all financial decisions from trusted records. We also learned to represent payment attempts explicitly, because PayPal’s external state can be temporarily uncertain from the app’s point of view.

## What's next for Tefo Desk

- Validate Sesotho and mixed-language interpretation and terminology with fluent speakers, then localize the interface. The UI is currently English-only and model language quality is not certified.
- Improve support for South African payment expectations. This PayPal Orders integration currently rejects ZAR rather than converting it; the seeded checkout demo therefore uses USD.
- Complete and record a credentialed end-to-end Gemini and PayPal Sandbox run, including webhook delivery.
- Test the workflow with small-business owners and improve the catalog matching and clarification experience from their feedback.

## Technology and demo notes

**PayPal:** PayPal Orders v2 REST API, Sandbox environment.
**AI:** Gemini API (provider can be selected at deployment; OpenAI and compatible endpoints are also supported).
**Languages/frameworks:** TypeScript, SQL/Prisma migrations, CSS, Next.js, React, Fastify.
**Database/platforms:** PostgreSQL, Docker Compose; deployment files target a Linux VPS behind Nginx with TLS from Certbot/Let’s Encrypt.

The project calls PayPal and AI provider APIs directly over HTTPS; it does not use a PayPal SDK, AI SDK, hosted database service, or messaging-delivery platform. The included VPS deployment configuration is not itself a hosted demo.

For local setup, API details, and deployment instructions, see [README.md](README.md) and [DEPLOYMENT.md](DEPLOYMENT.md). Use PayPal Sandbox credentials only for the demo. To use the seeded AI flow, configure `AI_PROVIDER`, `AI_MODEL`, and `AI_API_KEY` in the root `.env`, start the API, then sign in and open **Business settings → AI order assistant**. Select the same provider and model configured in the environment and save the preference; the seeded workspace starts with AI disabled. Configure PayPal Sandbox client ID and secret before trying checkout. Never put credentials in the repository or video.

AI receives customer-request text and catalog names, descriptions, and SKUs. Do not include sensitive customer data in a request, and review the configured provider’s data terms. The fixture account (`owner@example.test` / `ChangeMe123456`) and sample records are for local development only and must not be exposed on a public host.
