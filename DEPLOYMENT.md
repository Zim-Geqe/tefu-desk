# Tefo Desk VPS deployment

Production deployment for `https://tefudesk.fastlaneorders.online` uses Docker Compose for PostgreSQL, the Fastify API, and the Next.js standalone server. Nginx terminates TLS and proxies the site. The deployment script does not stop or replace any of the other Docker containers shown in the VPS inventory.

## Port plan

The VPS inventory already has services on host ports 3000, 3001, 4000, and 4002. Tefo Desk uses two private loopback ports instead:

| Service | VPS bind | Container port | Public access |
| --- | --- | --- | --- |
| Fastify API | `127.0.0.1:4510` | `3000` | Nginx at `/api/` |
| Next.js web | `127.0.0.1:4511` | `3000` | Nginx at `/` |
| PostgreSQL | Docker network only | `5432` | None |

The ports 4510 and 4511 were selected because they do not appear in the `docker ps` inventory supplied for this VPS. `deploy.sh` checks that they are free before starting. To choose other free ports, set `BACKEND_HOST_PORT` and `FRONTEND_HOST_PORT` before the first deployment; the script records the values in `.env.production` for later runs. Never expose the app or database ports directly to the public internet.

## Before deployment

1. Copy the complete project directory to `/var/www/tefo-desk` on the VPS. Include source, package lockfiles, Prisma migrations, both Dockerfiles, Compose files, and `deploy.sh`. Do not copy local `node_modules`, `.next`, `dist`, `.env`, or `.env.production` files.
2. Ensure DNS `A` for `tefudesk.fastlaneorders.online` points to the VPS public IPv4. Allow inbound TCP 80 and 443 in the VPS firewall/security group. The script checks DNS before requesting a certificate.
3. The VPS needs Docker Engine with Compose v2, Nginx, Certbot with its Nginx plugin, and systemd. The script refuses to overwrite a pre-existing Nginx virtual host for this domain unless it was created by this Tefo Desk script.
4. For a reproducible clone-based deployment, push this source to a Git repository and clone it into `/var/www/tefo-desk`. This workspace currently has no `.git` repository configured.

## Deploy

Run this on the VPS as root (or from a root shell):

```bash
cd /var/www/tefo-desk
bash deploy.sh
```

On first run the script prompts without echoing the PayPal Sandbox client ID, Sandbox secret, and Gemini API key. It generates a unique PostgreSQL password and writes all runtime settings to `/var/www/tefo-desk/.env.production` with permissions `600`. It builds the three production targets, starts the private database, runs committed Prisma migrations, starts and health-checks both app services, configures the domain in Nginx, obtains the Let's Encrypt certificate, and checks HTTPS frontend/API responses.

PayPal remains explicitly in **Sandbox** mode. The script uses `gemini-3.5-flash-lite`, the model verified with the current demo key; enter another Gemini model at the prompt if your Google AI project enables a different one. The Gemini key and PayPal secret are only passed to the backend container. The public browser bundle contains only the API URL.

The deployment does not seed the local demo owner account or sample data into the production database. Create the production owner through the registration screen. Keep `.env.production` backed up securely and out of Git. To add webhook verification later, set `PAYPAL_WEBHOOK_ID` in `.env.production` to the webhook registered for this exact Sandbox app/URL and redeploy; checkout approval and server-side capture also work without webhooks.

## Operations

```bash
cd /var/www/tefo-desk
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend frontend
docker compose --env-file .env.production -f docker-compose.prod.yml restart backend frontend
```

Deploy updates by copying/pulling the new source and rerunning `bash deploy.sh`. Before production schema changes, take and verify a PostgreSQL backup. The named volume is `tefo_desk_postgres`; deploy does not delete it. Do not use `docker compose down -v` on production.

If deployment stops before SSL setup, inspect `docker compose ... logs`, `nginx -t`, DNS, and firewall access. The app containers remain bound to loopback. If the HTTPS step fails, fix the reported prerequisite and rerun the script; it preserves this app's existing Nginx config and refuses unrelated ones.
