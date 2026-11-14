#!/usr/bin/env bash
# Publica a versão que está na pasta, na própria máquina (roda NA VM).
#
#   ./scripts/deploy.sh             # reconstrói e sobe o que mudou
#   ./scripts/deploy.sh --atualizar # antes, traz o último commit da branch atual
#
# É o que o deploy automático (.github/workflows/ci-cd.yml) executa por SSH a
# cada alteração na main. Pode rodar quantas vezes quiser: o Compose só recria
# o que mudou, as migrações do banco são aplicadas pela API ao subir e quem
# está nas salas reconecta sozinho (RF24).

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Falta o arquivo .env. Comece por: cp .env.vm.example .env" >&2
  exit 1
fi

if [ "${1:-}" = "--atualizar" ]; then
  git pull --ff-only
fi

echo "== Versão: $(git rev-parse --short HEAD 2>/dev/null || echo desconhecida)"
docker compose up -d --build --remove-orphans

echo "== Esperando a API responder pelo proxy"
porta="$(docker compose port web 80 | sed 's/.*://')"
for _ in $(seq 1 60); do
  if saude="$(curl -fsS "http://localhost:${porta}/api/saude" 2>/dev/null)"; then
    echo "$saude"
    docker compose ps --format 'table {{.Name}}\t{{.Status}}'
    docker image prune -f >/dev/null
    echo "== Publicado."
    exit 0
  fi
  sleep 2
done

echo "A API não respondeu em 2 minutos. Últimas linhas:" >&2
docker compose logs --tail 40 api web >&2
exit 1
