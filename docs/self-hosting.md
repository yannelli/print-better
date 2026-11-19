# Self-hosting

Print Better runs as one Cloudflare Worker (API, web app, MCP server, install scripts) with D1 for data, R2 for documents and client downloads, and one Durable Object per workspace for live device connections.

## Requirements
- A Cloudflare account on **Workers Paid**. Password hashing (scrypt) needs more CPU time than the free plan allows, and Cloudflare's email sending is paid-only.
- Node 22+ and pnpm. Everything else (wrangler included) installs inside `server/`.
- To build clients: macOS with Rust (see `rust-toolchain` targets in `docs/release.md`), zig + cargo-zigbuild, and optionally a Developer ID for signed macOS builds.

## Deploy
```sh
pnpm --dir server exec wrangler login
scripts/deploy.sh
```
The script builds the app, deploys the Worker (D1 and R2 are created on first deploy), applies database migrations, creates the three secrets below if missing, and prints a one-time setup link. Open it to create the owner account and first workspace.

| Secret | What it protects | If lost |
|---|---|---|
| `SETUP_TOKEN` | Who may create the first account | Harmless after setup; delete it with `wrangler secret delete SETUP_TOKEN` |
| `APP_SECRET` | Encrypts stored secrets (SSO client secrets, Resend key, webhook secret) | Re-enter those secrets in Server admin |
| `AUTH_PEPPER` | Mixed into every password hash | Every password stops working; people sign in with a passkey or SSO, or an admin sends reset links |

Back up `APP_SECRET` and `AUTH_PEPPER` somewhere safe; Cloudflare will not show them again.

## Publish client downloads
The install one-liners and the web app's "Add a device" flow download clients from your own R2 bucket, so publish a release once after deploying (and again for each update):
```sh
scripts/release.sh --publish remote
```
See `docs/release.md` for signing, notarization, and platform options. Devices update by re-running their install command (it keeps the pairing) or by installing the new macOS pkg.

## Custom domain
Add one in the Cloudflare dashboard (Workers & Pages → print-better → Settings → Domains & Routes) or in `server/wrangler.jsonc`:
```jsonc
"routes": [{ "pattern": "print.example.com", "custom_domain": true }]
```
Pick the final domain **before** people register passkeys: passkeys are tied to the hostname they were created on. Paired devices keep talking to the address they paired with, so leave the `workers.dev` address enabled or re-pair them after switching.

## Sign-in options (Server admin → Sign-in options)
Username + password and passkeys work out of the box. New accounts are invite-only unless you switch sign-up to open.

Once Google or OIDC is on, people can connect it to an existing account in Your account → Sign-in and security → Connected accounts. Email verification links need outbound email (see Email below).

**Google**
1. In Google Cloud Console → APIs & Services → Credentials, create an OAuth client ID of type *Web application*.
2. Authorized redirect URI: `https://<your-domain>/api/auth/sso/google/callback`
3. Paste the client ID and secret into Server admin and turn Google on.

**Any OpenID Connect provider** (Okta, Entra ID, Authentik, Keycloak, …)
1. Create a confidential web client with redirect URI `https://<your-domain>/api/auth/sso/oidc/callback` and scopes `openid email profile`.
2. Enter the issuer URL (discovery must be at `<issuer>/.well-known/openid-configuration`), client ID, secret, and the button name people should see.

## Email
Email is optional. Without it, invites and password resets are shared as links, and email-to-print is unavailable.

**Sending** (invites, password resets, printer alerts), Server admin → Email:
- *Resend*: create an API key with sending access, verify your domain in Resend, then enter the key and a From address on that domain.
- *Cloudflare Email Service* (public beta): onboard your domain for Email Sending, add `"send_email": [{ "name": "EMAIL" }]` to `server/wrangler.jsonc`, redeploy, then choose Cloudflare and a From address on that domain.

**Email to print** is off everywhere by default. Turning it on takes three steps: the server receives mail, a workspace allows it, and each printer gets an address.
1. Receiving, pick one:
   - *Cloudflare Email Routing*: enable Email Routing on your domain, then add a catch-all (or per-address) rule with action *Send to a Worker* → `print-better`. In Server admin → Email choose Cloudflare and enter the domain.
   - *Resend*: add Resend's MX records for a receiving domain, then add a webhook for `email.received` pointing to `https://<your-domain>/api/hooks/resend`. Enter the domain and the webhook signing secret (`whsec_…`) in Server admin → Email.
2. Workspace settings → Email to print: turn it on and choose who may send (workspace members, plus extra addresses or `@domain` entries).
3. Printer → Sharing: give the printer an email address, for example `office@print.example.com`.

Mail that fails DMARC or comes from someone not allowed is dropped. Attachments (PDF, JPEG, PNG, text) print; with no attachments, the message body prints.

## AI assistants (MCP)
The MCP server lives at `https://<your-domain>/mcp`. Claude, ChatGPT, and Claude Code connect with OAuth: add the URL as a custom connector and approve access in the browser. Other tools can use a personal token from Account → Apps and tokens as a Bearer token. The web app's Connect AI page (`/connect`) has step-by-step instructions.

## Backups
```sh
pnpm --dir server exec wrangler d1 export print-better --remote --output print-better.sql
pnpm --dir server exec wrangler d1 time-travel info print-better   # point-in-time restore, last 30 days
```
R2 holds print documents (deleted automatically after the workspace's "keep documents" setting) and client downloads (rebuildable with `scripts/release.sh`), so the database export plus your two secrets are everything worth backing up.

## Updating the server
```sh
git pull && scripts/deploy.sh
```
Deploys are zero-downtime; new migrations apply right after the deploy, and connected devices reconnect on their own.
