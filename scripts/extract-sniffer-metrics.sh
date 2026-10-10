#!/usr/bin/env bash
# Arquivo: scripts/extract-sniffer-metrics.sh
#
# Roda o opportunitySniffer localmente, grava a saída em logs/ com
# timestamp legível e resume quantas ineficiências líquidas de taxa foram
# encontradas. Precisa de acesso de rede real à Binance — não roda em
# sandboxes com egress restrito (ver README, seção "Medindo a oportunidade
# real"). NÃO builda (`npm run sniff` roda via ts-node direto do source,
# nunca toca dist/ — buildar antes seria tempo gasto à toa).
#
# Uso:
#   npm install   # se ainda não rodou
#   ./scripts/extract-sniffer-metrics.sh
#   # deixe rodando por pelo menos algumas horas antes de tirar conclusões,
#   # depois Ctrl+C — o sniffer fecha a conexão de forma graciosa sozinho.
set -euo pipefail

LOG_DIR="./logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/sniffer_$(date +%Y%m%d_%H%M%S).log"

echo "[SYS] Iniciando coleta empírica local. Log: $LOG_FILE"
echo "[SYS] Ctrl+C para interromper quando quiser — o sniffer encerra de forma graciosa."
echo "------------------------------------------------------------------"

npm run sniff 2>&1 | tee "$LOG_FILE"

echo "------------------------------------------------------------------"
echo "[SYS] Coleta encerrada. Resumo:"
echo "  Ineficiências líquidas encontradas: $(grep -c 'Ineficiência líquida encontrada' "$LOG_FILE" || echo 0)"
# Campo real do logger estruturado é "ticksProcessados" (ver printReport em opportunitySniffer.ts).
echo "  Último relatório periódico: $(grep 'Relatório periódico' "$LOG_FILE" | tail -n 1 || echo 'nenhum ainda — deixe rodar por mais tempo')"
echo "[SYS] Log completo salvo em: $LOG_FILE"
