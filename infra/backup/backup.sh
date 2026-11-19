#!/usr/bin/env bash
# ============================================================
# TROSV - backup du lieu tren may chu Debian (chay trong thu muc repo)
#
#   ./infra/backup/backup.sh              # backup ngay
#   ./infra/backup/backup.sh --verify     # tuong thich lenh cu; luon kiem tra
#
# Backup 3 thu:
#   1. DB       : pg_dump TU CONTAINER db (khong can psql tren host)
#   2. Uploads  : volume trosv-storage (anh tin dang) - ten volume duoc
#                 resolve dong (tien to la ten project compose)
#   3. .env     : APP_KEY + Reverb keys - mat file nay la mat toan phien
#
# Giu: 7 ban gan nhat + 4 ban chu nhat (tu xoa ban cu).
# Cron khuyen nghi (02:30 hang ngay) - xem docs/runbooks/DEPLOY.md muc 6.
# Restore: xem infra/backup/RESTORE.md. Rollback code: docs/runbooks/ROLLBACK.md.
# ============================================================
set -euo pipefail
umask 077

# Mot file compose duy nhat; TLS profile de khop dung stack dang chay.
# Docker hoac Podman - tu dong chon runtime co san (may chu bat ky).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER="docker"
elif command -v podman >/dev/null 2>&1; then
    DOCKER="podman"
else
    echo "LOI: khong tim thay docker hoac podman." >&2
    exit 1
fi
DC="$DOCKER compose --profile tls"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Mac dinh: ./backups trong repo (da gitignore). Co the ghi de:
#   BACKUP_DIR=/mnt/backup-drive/trosv ./infra/backup/backup.sh
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
KEEP_DAILY=7
KEEP_WEEKLY=4

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec 9> "$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo "LOI: mot tien trinh backup khac dang chay." >&2; exit 1; }
[ -s .env ] || { echo "LOI: thieu file .env de khoi phuc cau hinh." >&2; exit 1; }

STAGING="$(mktemp -d "$BACKUP_DIR/.incomplete-$TS.XXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Ten volume co tien to ten project (ten thu muc repo) - resolve, dung doan.
VOL_STORAGE="$($DOCKER volume ls -q | grep -E 'trosv-storage$' | head -1)"
[ -n "$VOL_STORAGE" ] || { echo "LOI: khong thay volume trosv-storage - stack chua chay lan nao?" >&2; exit 1; }

echo ">> [$(date '+%F %T')] backup bat dau (TS=$TS, dir=$BACKUP_DIR)"

# ------------------------------------------------------------
# 1. Database (pg_dump tu container db)
# ------------------------------------------------------------
$DC exec -T db pg_dump -U rental -d rental --no-owner \
  | gzip > "$STAGING/db-$TS.sql.gz"

DB_SIZE="$(du -h "$STAGING/db-$TS.sql.gz" | cut -f1)"
echo "   db dump: db-$TS.sql.gz ($DB_SIZE)"

# Dump rong (< 1KB) gan nhu chac la loi - that bai som de cron bao do.
[ "$(stat -c%s "$STAGING/db-$TS.sql.gz")" -ge 1024 ] \
  || { echo "   LOI: dump qua nho - postgres co the chua san sang." >&2; exit 1; }

# ------------------------------------------------------------
# 2. Uploads (volume trosv-storage) - stream tar qua stdout, khong bind
#    mount ra host: chay duoc ca rootless (podman) lan rootful (docker).
# ------------------------------------------------------------
$DOCKER run --rm -v "$VOL_STORAGE":/data:ro alpine:3.20 \
    tar cz -C /data . > "$STAGING/uploads-$TS.tar.gz"

echo "   uploads: uploads-$TS.tar.gz ($(du -h "$STAGING/uploads-$TS.tar.gz" | cut -f1))"

# ------------------------------------------------------------
# 3. Cau hinh - bat buoc de bo backup co the khoi phuc day du
# ------------------------------------------------------------
cp .env "$STAGING/env-$TS.bak"
chmod 600 "$STAGING"/*

# ------------------------------------------------------------
# 4. Kiem tra truoc khi cong nhan thanh cong va xoa ban cu
# ------------------------------------------------------------
gunzip -t "$STAGING/db-$TS.sql.gz"
TABLES="$(gunzip -c "$STAGING/db-$TS.sql.gz" | awk '/CREATE TABLE/ {count++} END {print count+0}')"
[ "$TABLES" -gt 0 ] || { echo "LOI: dump khong co CREATE TABLE." >&2; exit 1; }
tar -tzf "$STAGING/uploads-$TS.tar.gz" > /dev/null
[ -s "$STAGING/env-$TS.bak" ] || { echo "LOI: ban sao .env rong." >&2; exit 1; }

for name in "db-$TS.sql.gz" "uploads-$TS.tar.gz" "env-$TS.bak" "complete-$TS"; do
    [ ! -e "$BACKUP_DIR/$name" ] || { echo "LOI: timestamp backup da ton tai: $TS." >&2; exit 1; }
done
mv -- "$STAGING"/* "$BACKUP_DIR/"
# Chi dau nay moi cho phep retention dem bo backup; tao sau khi du 3 tep.
: > "$BACKUP_DIR/complete-$TS"
echo "   OK: dump co $TABLES bang, uploads doc duoc, da luu cau hinh."

# ------------------------------------------------------------
# 5. Xoa ban cu: giu KEEP_DAILY ban gan nhat + KEEP_WEEKLY ban chu nhat
# ------------------------------------------------------------
daily_count=0
weekly_count=0
ls -1t -- "$BACKUP_DIR"/complete-* 2>/dev/null | while read -r f; do
    ts="${f##*/complete-}"
    [[ "$ts" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
    [ -s "$BACKUP_DIR/db-$ts.sql.gz" ] &&
        [ -s "$BACKUP_DIR/uploads-$ts.tar.gz" ] &&
        [ -s "$BACKUP_DIR/env-$ts.bak" ] || continue
    dow="$(date -d "${ts:0:8}" +%u 2>/dev/null || echo 0)"
    daily_count=$((daily_count + 1))
    if [ "$dow" = "7" ]; then weekly_count=$((weekly_count + 1)); fi
    if [ "$daily_count" -gt "$KEEP_DAILY" ] &&
        { [ "$dow" != "7" ] || [ "$weekly_count" -gt "$KEEP_WEEKLY" ]; }; then
        rm -f -- "$f" "$BACKUP_DIR/db-$ts.sql.gz" "$BACKUP_DIR/uploads-$ts.tar.gz" "$BACKUP_DIR/env-$ts.bak"
    fi
done

# ------------------------------------------------------------
# 6. Hoan tat
# ------------------------------------------------------------
echo ">> [$(date '+%F %T')] backup hoan tat: $BACKUP_DIR"
