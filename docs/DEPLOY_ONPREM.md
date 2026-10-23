# On-prem LAN deployment

The app runs on the on-prem server **`192.168.1.23`** (`gitlab.visibilitylive`,
user `voisibilitybots`) as a `docker compose` stack. Every push to `main` is
built and rolled out automatically by a **GitHub Actions self-hosted runner** on
that box — the same pattern used by `retailIQ` and `visibility-vision`.

There is no public URL. Access is LAN-only:

| Service      | URL                          | Notes                              |
|--------------|------------------------------|------------------------------------|
| frontend     | `http://192.168.1.23:3124`   | Next.js UI                         |
| api-gateway  | `http://192.168.1.23:5100`   | Express API (`/api/...`)           |
| ai-backend   | `http://127.0.0.1:8124`      | FastAPI — **localhost-only** on the box |
| mongo        | *(compose network only)*     | dedicated `mongo:8` container      |

## How auto-deploy works

1. `.github/workflows/deploy-onprem.yml` triggers on `push` to `main`
   (or manual `workflow_dispatch`).
2. It runs on the self-hosted runner labelled `visibility-docs`
   (`~/actions-runner-visibility-docs`, systemd service
   `actions.runner.Raza854-visbility-docs.visibility-docs-onprem.service`).
3. The runner syncs the repo into `~/apps/visibility-docs` (preserving the
   server-side `.env` files), builds the images **sequentially** (the box is
   RAM-constrained), then `docker compose -f docker-compose.onprem.yml up -d`.
4. Health gates: `ai-backend /health`, `api-gateway /api/health`, `frontend /`.

No SSH key, webhook, or inbound port is involved — the runner long-polls GitHub
outbound. No extra GitHub secret is needed; checkout uses the built-in
`GITHUB_TOKEN`.

## One-time server setup

### 1. Runner

```bash
cd ~ && mkdir actions-runner-visibility-docs && cd actions-runner-visibility-docs
tar xzf ~/actions-runner-visibility-vision/*.tar.gz 2>/dev/null || \
  { curl -fsSL -o r.tgz https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz && tar xzf r.tgz; }
./config.sh --url https://github.com/Raza854/visbility-docs \
  --token <FRESH_REGISTRATION_TOKEN> \
  --name visibility-docs-onprem --labels visibility-docs --work _work --unattended --replace
sudo ./svc.sh install voisibilitybots
sudo ./svc.sh start
```

Token: `https://github.com/Raza854/visbility-docs/settings/actions/runners/new`
(expires ~1 h).

### 2. Server-side config (never committed)

```
~/apps/visibility-docs/.env                # compose variable substitution
~/apps/visibility-docs/api-gateway/.env    # JWT + internal service key
~/apps/visibility-docs/ai-backend/.env     # Supabase / Groq / Pinecone / SMTP + secrets
```

**`~/apps/visibility-docs/.env`**

```dotenv
MONGO_ROOT_USER=docsadmin
MONGO_ROOT_PASSWORD=<generated>
MONGO_DB=visibility_docs_ai
FRONTEND_URL=http://192.168.1.23:3124
```

**`~/apps/visibility-docs/api-gateway/.env`**

```dotenv
JWT_SECRET=<generated>
JWT_REFRESH_SECRET=<generated>
JWT_EXPIRE=30d
JWT_REFRESH_EXPIRE=7d
JWT_COOKIE_EXPIRE=30
BCRYPT_SALT_ROUNDS=12
AI_INTERNAL_SERVICE_KEY=<generated — must equal ai-backend INTERNAL_SERVICE_KEY>
AI_SERVICE_TIMEOUT_MS=300000
AI_CHAT_TIMEOUT_MS=300000
OPENREMOTE_ENABLED=false
```

**`~/apps/visibility-docs/ai-backend/.env`**

```dotenv
ENVIRONMENT=production
SECRET_KEY=<generated>
INTERNAL_SERVICE_KEY=<same value as AI_INTERNAL_SERVICE_KEY above>
EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
USE_GPU=false
GROQ_API_KEY=<from Groq console>
PINECONE_API_KEY=<from Pinecone console>
PINECONE_INDEX_NAME=<1024-dim index>
SUPABASE_URL=<...>
SUPABASE_KEY=<...>
SUPABASE_JWT_SECRET=<...>
DATABASE_URL=<Supabase Postgres connection string>
# optional
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USERNAME=
EMAIL_PASSWORD=
EMAIL_FROM=
```

Third-party keys can start blank — the stack boots and the UI works; chat / RAG /
vector search / email stay degraded until they are filled in (then just re-run
the deploy workflow).

## Operating it

```bash
cd ~/apps/visibility-docs
docker compose -f docker-compose.onprem.yml ps
docker compose -f docker-compose.onprem.yml logs -f api-gateway
docker compose -f docker-compose.onprem.yml restart frontend
```

- **Redeploy:** push to `main`, or re-run the workflow from the Actions tab.
- **Roll back:** `git -C ~/apps/visibility-docs checkout -f <old-sha>` then
  `docker compose -f docker-compose.onprem.yml up -d --build`.
- **Mongo data** lives in the `visibility-docs_docs_mongo_data` volume; uploads in
  `visibility-docs_docs_ai_uploads`.
- **api-gateway error log** persists across redeploys (unlike `docker logs`,
  which resets when the container is recreated) at
  `docker run --rm -v visibility-docs_docs_api_logs:/log alpine cat /log/error.log`.

## Backups

There is no automatic backup of the box today. Data at risk if it's lost: all
Mongo data and every uploaded document (`docs_mongo_data`, `docs_ai_uploads`,
`docs_shared_storage` volumes).

`scripts/backup-onprem.sh` mongodumps Mongo and tars the uploads / shared-storage
volumes into `./backups/<timestamp>/` (or `$BACKUP_DIR`). Run it manually, or
add it to the runner user's crontab for a daily backup:

```bash
crontab -e
# 0 3 * * * cd ~/apps/visibility-docs && BACKUP_DIR=/var/backups/visibility-docs ./scripts/backup-onprem.sh >> /var/log/visibility-docs-backup.log 2>&1
```

`$BACKUP_DIR` should point somewhere off the box (a mounted NAS share, or
synced elsewhere) — a backup that lives on the same disk as the data it backs
up doesn't survive a disk failure. Restore commands are in the script header.

## Notes on RAM

The box runs several other stacks. `ai-backend` loads a 1024-dim embedding model
plus a reranker (~2–2.5 GB RSS) — it has `mem_limit: 3g` and swap was raised to
8 GB. If builds OOM, build one service at a time by hand, or temporarily stop an
idle stack.
