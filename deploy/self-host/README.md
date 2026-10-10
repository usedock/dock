# Self-hosting Dock

This stack runs the whole Dock control plane on one machine with Docker Compose:

| Service | Role |
|---|---|
| `db` (Postgres 16), `redis` | durable state, rate limits |
| `restate` | durable dock workflows (internal only) |
| `minio` + `minio-init` | snapshot generations, bucket created on start |
| `migrate` | applies database migrations, then exits |
| `backend` | REST API, fleet API, GitHub webhooks, workflow endpoint (`9080`) |
| `restate-register` | registers the workflow endpoint with Restate on every start |
| `dashboard` | web UI |
| `caddy` | one public origin: `/v1/*`, `/api/auth/*`, `/openapi.json` to the API, the rest to the dashboard |

Hosts (where docks actually run) are separate machines that dial out to this
control plane; see [Add hosts](#add-hosts).

## Requirements

- Docker with Compose v2.
- For a public instance: a DNS name pointing at the machine (for example
  `dock.example.com`) and ports 80 and 443 free. Caddy then gets a publicly
  trusted certificate automatically. Plain HTTP works for trying Dock, but GitHub
  webhooks and confined GitHub runs need HTTPS on 443 (see
  [Network notes](#network-notes)).
- To run docks on the same machine: Linux with Docker (`gvisor` runtime, installed for
  you) or `/dev/kvm` (`microvm` runtime, Firecracker). Nothing else: missing Go or Bun toolchains
  are run in containers.

## Quick start

From this directory:

```sh
./setup.sh --host                           # local: http://localhost:8088, docks on this machine
./setup.sh --url https://dock.example.com   # public instance, automatic HTTPS
```

`setup.sh` writes `.env` with fresh secrets on the first run (your git email
becomes the instance admin), builds and starts the stack, and waits until the
API is healthy. `--host` then enrolls this machine as a `gvisor` host
through `bootstrap-host.sh` (asks for sudo; the first run builds the dock image).
It expects a `usedock/docklet` checkout next to this repository (`../docklet`): clone https://github.com/usedock/docklet there, or set `DOCKLET_DIR` to another location.
Re-running it keeps `.env` and restarts the stack.

To configure by hand instead: `cp .env.example .env`, fill `DOCK_SITE_ADDRESS`,
`DOCK_PUBLIC_URL`, and each secret (`openssl rand -hex 32`), then
`docker compose up -d --build`. `DOCK_HTTP_PORT` / `DOCK_HTTPS_PORT` move Caddy
off 80/443 when the site address carries that port (for example
`http://localhost:8088` with `DOCK_HTTP_PORT=8088`).

Open `DOCK_PUBLIC_URL` and sign up. Then:

- **Billing**: there is none on a self-hosted instance. Telemetry is off by default.
- **SSH** listens on `DOCK_SSH_PORT` (default 2222; open it in your
  firewall). Add a public key under Developers > SSH keys, then
  `ssh -p 2222 <dockId>@<your host>`. The host key is derived from
  `BETTER_AUTH_SECRET`, so it survives rebuilds. Shells and single commands
  work; SCP, SFTP, and port forwarding do not yet.
- **Hosted ports** work out of the box on a local install at
  `http://<port>-<random>.ports.localhost:8088` (browsers resolve
  `*.localhost` to this machine). On a public install, run
  `./setup.sh --ports-domain ports.example.com` with a wildcard DNS record
  `*.ports.example.com` pointing here. Exposing a port on a dock's Ports tab
  gives it a URL like `https://3000-k7x2m9q4w8r3t5yz.ports.example.com`; Caddy
  issues each certificate on first use, only for exposed names. Services bound to
  `localhost` inside the dock are reachable. The random name is the only
  credential, so treat port URLs as public.
- **Mail** is optional. With `SMTP_HOST` empty, every message (password reset
  links, sign-in codes) is written to the API log instead of being delivered:
  `docker compose logs backend | grep -A2 "mail not delivered"`. Email
  verification is not enforced for sign-in, so sign-up works without mail; only
  instance admin access needs a verified email (see below).
- **Google / GitHub sign-in** is optional. A provider appears on the login page
  only when both its client id and secret are set. The OAuth callback URL is
  `<DOCK_PUBLIC_URL>/api/auth/callback/<google|github>`.

Upgrade with `git pull && docker compose up -d --build`; migrations run
automatically before the API starts. Back up the `pgdata` and `minio-data`
volumes and keep `.env` (losing `SECRETS_ENCRYPTION_KEY` makes stored provider
keys and environment secrets unreadable).

Installs created before the single baseline migration (October 2026) cannot
upgrade in place: `migrate` fails with `relation "users" already exists` and
the API never starts. Reset the stack with `docker compose down -v` (this
deletes all docks, snapshots, and accounts), run `./setup.sh` again, and
re-enroll each host with `bootstrap-host.sh`.

## Register the GitHub App (issue-to-PR runs)

Every instance needs its own GitHub App. Dock creates it for you through
GitHub's App Manifest flow:

1. Put your email in `INSTANCE_ADMIN_EMAILS` in `.env` and run
   `docker compose up -d backend`. The admin email must be verified: sign up
   with it, then open the verification link (use **Send verification email** in
   the dashboard to resend). With `SMTP_HOST` unset the link is in
   `docker compose logs backend`.
2. In the dashboard open **Developers > GitHub App > Register App**. Optionally
   enter a GitHub organization to own the App, then continue on GitHub.
3. GitHub sends you back with the App's id, slug, private key, and webhook
   secret. They are shown once and not stored by Dock. Paste them into `.env`
   and run `docker compose up -d backend`.
4. On **Developers > GitHub App** click **Link installation**, install the App on
   your repositories, and GitHub sends you back to link it to the workspace.
   Dock confirms through GitHub OAuth that you own the account the App is
   installed on (or administer the organization). This needs, on the App:
   - first **Callback URL** `<DOCK_PUBLIC_URL>/developers/github/installed`
     (the Setup URL is not used);
   - **Request user authorization (OAuth) during installation** enabled;
   - organization permission **Members: read**, approved on the installation;
   - `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` in `.env` (Client ID and
     a client secret from the App's settings page).

   Apps registered by Dock already have all of this. For an App created by hand,
   or before this change, set it on GitHub and add the two env values.
5. Add a model provider key under **Developers > Provider keys**.

Mention `@dock` in an issue comment to start a run.

## Add hosts

Hosts only make outbound connections to `DOCK_PUBLIC_URL`; they need no
inbound port. `./setup.sh --host` enrolls the control plane machine itself. On
any other Linux machine, from a checkout of `usedock/docklet` (`FLEET_TOKEN` is
in `.env`):

```sh
sudo bash scripts/bootstrap-host.sh \
  --fleet-url https://dock.example.com \
  --fleet-token "$FLEET_TOKEN" \
  --runtime microvm
```

`FLEET_TOKEN` only enrolls new machines: each host receives its own credential
(kept in `/var/lib/docklet/fleet-credential`) and the token is not stored on it.
Re-running the installer on an enrolled host keeps its credential; if a host
loses it, an instance admin resets it with `POST /v1/hosts/<id>/reset-credential`.

`--runtime` is `microvm` or `gvisor`; the host, not the dock, determines the
runtime:

- **`microvm`** (bare metal or nested virtualization with `/dev/kvm`): runs
  Firecracker microVMs. The whole disk persists across stop and resume. The
  installer builds the image (several minutes, about 20 GB).
- **`gvisor`** (any Linux machine with Docker): runs `runsc` containers. Only
  `/home/user/work` persists across stop and resume; everything else resets to
  the image.

See the `usedock/docklet` repository for the full host guide and troubleshooting.

## Network notes

- **GitHub webhooks** go to `<DOCK_PUBLIC_URL>/v1/github/webhooks`, so the API
  must be reachable from github.com.
- **Confined runs.** Agent docks for GitHub runs reach the internet only
  through each host's egress proxy, which allows HTTPS (port 443) to an
  allowlist that always includes the control plane's host. Two consequences:
  - The control plane must serve HTTPS on 443 with a certificate the guest
    trusts (a public CA such as the one Caddy obtains automatically; Caddy's
    internal CA is not trusted inside guests).
  - The proxy refuses private addresses by default. If `DOCK_PUBLIC_URL`
    resolves to a private IP (control plane on a LAN or VPN), allow that range
    on each host: `--egress-allow-private 10.0.0.0/24` (written to
    `DOCKLET_EGRESS_ALLOW_PRIVATE`). Keep the range as narrow as possible.
- **Snapshot transfers** go through the API's object proxy by default. Set
  `SNAPSHOT_STORE_PUBLIC_ENDPOINT` only if hosts can reach the object store
  directly.
- **Object store image.** Upstream MinIO no longer publishes container images.
  The stack uses `pgsty/minio` and `pgsty/mc`, maintained builds of the same
  server; override with `MINIO_IMAGE` / `MINIO_CLIENT_IMAGE`, or point
  `SNAPSHOT_STORE_ENDPOINT` and its credentials at any S3-compatible bucket.
