#!/usr/bin/env sh
# Backup lógico do PostgreSQL (formato custom, comprimido).
# Uso: DATABASE_URL=postgres://... ./scripts/backup.sh [diretorio]
# Recomendações: agendar (cron) diariamente, manter cópia fora do servidor e criptografada,
# e testar a restauração periodicamente (scripts/restore.sh em ambiente de teste).
set -eu
DIR="${1:-./backups}"
mkdir -p "$DIR"
FILE="$DIR/saude-gestao-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$FILE"
echo "Backup gerado: $FILE"
# Retenção: remove backups com mais de 30 dias
find "$DIR" -name 'saude-gestao-*.dump' -mtime +30 -delete 2>/dev/null || true
