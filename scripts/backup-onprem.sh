#!/usr/bin/env bash
# Backs up the on-prem stack's durable state: Mongo data (mongodump) and the
# shared uploads volume (tar). Run from the server, from ~/apps/visibility-docs.
#
# There was previously no backup story at all for this deployment — losing the
# box meant losing every uploaded document and all Mongo data with no way back.
#
# Usage:
#   ./scripts/backup-onprem.sh                # backs up to ./backups/<timestamp>/
#   BACKUP_DIR=/mnt/nas/docs-backups ./scripts/backup-onprem.sh
#
# Restore:
#   Mongo:   docker compose -f docker-compose.onprem.yml exec -T mongo \
#              mongorestore --archive --gzip --drop -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" \
#              --authenticationDatabase admin < backups/<ts>/mongo.archive.gz
#   Uploads: docker run --rm -v visibility-docs_docs_ai_uploads:/data -v "$(pwd)/backups/<ts>":/backup \
#              alpine tar xzf /backup/uploads.tar.gz -C /data
#
# Suggested cron (daily at 03:00, keep 14 days):
#   0 3 * * * cd ~/apps/visibility-docs && BACKUP_DIR=/var/backups/visibility-docs ./scripts/backup-onprem.sh >> /var/log/visibility-docs-backup.log 2>&1

set -euo pipefail

COMPOSE_FILE="docker-compose.onprem.yml"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$TS"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Run this from the visibility-docs deploy directory (docker-compose.onprem.yml not found here)." >&2
    exit 1
fi
if [ ! -f ".env" ]; then
    echo ".env not found — needed for MONGO_ROOT_USER / MONGO_ROOT_PASSWORD." >&2
    exit 1
fi
# shellcheck disable=SC1091
set -a; source .env; set +a

mkdir -p "$DEST"

echo "[backup] mongo -> $DEST/mongo.archive.gz"
docker compose -f "$COMPOSE_FILE" exec -T mongo \
    mongodump --archive --gzip -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
    > "$DEST/mongo.archive.gz"

echo "[backup] uploads volume -> $DEST/uploads.tar.gz"
docker run --rm \
    -v "visibility-docs_docs_ai_uploads:/data:ro" \
    -v "$(pwd)/$DEST:/backup" \
    alpine tar czf /backup/uploads.tar.gz -C /data .

echo "[backup] shared-storage volume -> $DEST/shared-storage.tar.gz"
docker run --rm \
    -v "visibility-docs_docs_shared_storage:/data:ro" \
    -v "$(pwd)/$DEST:/backup" \
    alpine tar czf /backup/shared-storage.tar.gz -C /data .

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETAIN_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "[backup] done: $DEST"
