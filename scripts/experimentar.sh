#!/usr/bin/env bash
# Teste de fumaça do Núcleo · Parte 1, só com curl.
#
#   ./scripts/experimentar.sh                      # sistema em http://localhost:8080
#   ./scripts/experimentar.sh http://IP:PORTA      # sistema em outro endereço
#
# Faz o caminho de um comitente: cadastro, envio de 3 fotos, criação de um
# leilão e acompanhamento. O leilão abre e fecha sozinho (worker), sem ninguém
# intervir. Leva cerca de 2 minutos com os limites padrão.

set -euo pipefail

BASE="${1:-http://localhost:8080}"
BASE="${BASE%/}"
JAR="$(mktemp)"
DIR="$(mktemp -d)"
trap 'rm -rf "$JAR" "$DIR"' EXIT

passo() { printf '\n== %s\n' "$*"; }
numero() { sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -1; }
texto() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

passo "1. A API responde e informa a hora do servidor"
saude="$(curl -fsS "$BASE/api/saude")"
echo "$saude"
agora="$(echo "$saude" | texto agora)"

passo "2. Rota protegida sem login é recusada (esperado: 401)"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "$BASE/api/eu"

email="teste-$(date +%s)-$RANDOM@exemplo.com"
passo "3. Cadastro ($email) — a sessão vem em cookie HttpOnly"
curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d "{\"nome\":\"Teste da VM\",\"email\":\"$email\",\"senha\":\"senha-de-teste\"}" \
  "$BASE/api/usuarios"
echo

passo "4. Três fotos enviadas (vão para o bucket, não para o banco)"
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' \
  | base64 -d > "$DIR/foto.png"
ids=""
for i in 1 2 3; do
  id="$(curl -fsS -b "$JAR" -F "arquivo=@$DIR/foto.png;type=image/png" "$BASE/api/fotos" | numero id)"
  echo "  foto $i -> id $id"
  ids="${ids:+$ids,}$id"
done

passo "5. Arquivo que não é imagem é recusado (esperado: 415)"
echo 'isto nao e uma imagem' > "$DIR/falsa.png"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -b "$JAR" -F "arquivo=@$DIR/falsa.png;type=image/png" "$BASE/api/fotos"

passo "6. Leilão criado: abre em 35 s e dura 60 s"
inicio="$(date -u -d "$agora + 35 seconds" +%Y-%m-%dT%H:%M:%SZ)"
resposta="$(curl -fsS -b "$JAR" -H 'content-type: application/json' \
  -d "{\"nome\":\"Bicicleta de teste\",\"descricao\":\"Leilao criado pelo teste de fumaca.\",\"categoria\":\"esportes\",\"fotoIds\":[$ids],\"precoInicialCentavos\":10000,\"inicioEm\":\"$inicio\",\"duracaoSegundos\":60}" \
  "$BASE/api/leiloes")"
leilao="$(echo "$resposta" | sed -n 's/.*"leilao":{"id":\([0-9][0-9]*\).*/\1/p')"
echo "  leilão $leilao, início agendado para $inicio"

passo "7. Listagem pública (sem login) já mostra o leilão"
curl -fsS "$BASE/api/leiloes" | grep -o "\"total\":[0-9]*"
echo "  veja no navegador: $BASE/api/leiloes/$leilao"

passo "8. Acompanhando: o worker abre e fecha sozinho"
anterior=""
for _ in $(seq 1 60); do
  status="$(curl -fsS "$BASE/api/leiloes/$leilao" | texto status)"
  if [ "$status" != "$anterior" ]; then
    echo "  $(date +%T)  $status"
    anterior="$status"
  fi
  [ "$status" = "ENCERRADO_SEM_LANCES" ] && break
  sleep 3
done

if [ "$anterior" = "ENCERRADO_SEM_LANCES" ]; then
  printf '\nTudo certo: AGENDADO -> EM_ANDAMENTO -> ENCERRADO_SEM_LANCES sem intervenção.\n'
else
  printf '\nO leilão não chegou ao fim no tempo esperado (último estado: %s).\n' "$anterior"
  exit 1
fi
