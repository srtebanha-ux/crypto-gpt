#!/usr/bin/env bash
# Arquivo: scripts/extract-sniffer-metrics.sh
#
# Roda o opportunitySniffer localmente, grava a saída num log com timestamp
# e resume quantas ineficiências líquidas de taxa foram encontradas.
# Precisa de acesso de rede real à Binance — não roda em sandboxes com
# egress restrito (ver README, seção "Medindo a oportunidade real").
#
# Uso:
#   npm install   # se ainda não rodou
#   ./scripts/extract-sniffer-metrics.sh
#   # deixe rodando por pelo menos algumas horas antes de tirar conclusões,
#   # depois Ctrl+C — o sniffer fecha a conexão de forma graciosa sozinho.
set -euo pipefail

LOG_FILE="hft_sniffer_$(date +%s).log"

echo "[SYS] Iniciando coleta empírica local. Log: $LOG_FILE"
echo "[SYS] Ctrl+C para interromper quando quiser — o sniffer encerra de forma graciosa."
echo "------------------------------------------------------------------"

npm run sniff 2>&1 | tee "$LOG_FILE"

echo "------------------------------------------------------------------"
echo "[SYS] Coleta encerrada. Resumo:"
echo "  Ineficiências líquidas encontradas: $(grep -c 'Ineficiência líquida encontrada' "$LOG_FILE" || echo 0)"
echo "  Rejeições por dado obsoleto seriam contadas no relatório periódico do próprio sniffer (a cada 10s no log)."
echo "[SYS] Log completo salvo em: $LOG_FILE"
