#!/usr/bin/env sh
# Restaura um backup gerado por backup.sh. ATENÇÃO: sobrescreve os objetos do banco de destino.
# Uso: DATABASE_URL=postgres://... ./scripts/restore.sh arquivo.dump
set -eu
[ -f "${1:-}" ] || { echo "Informe o arquivo .dump"; exit 1; }
printf "Restaurar %s em %s? (digite SIM) " "$1" "$DATABASE_URL"; read -r ok
[ "$ok" = "SIM" ] || { echo "Cancelado."; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$1"
echo "Restauração concluída."
