# Leilão online — Hackathon

Plataforma web de leilão em tempo real. Este README é provisório: descreve o que
já está no repositório e como rodar. A versão final (endereço publicado, contas
de demonstração e decisões da equipe) entra junto com as telas.

## O que já existe (Núcleo · Parte 1 de 3 — Domínio)

- Contas e sessão: cadastro, login, logout, sessão no banco que expira e se renova com o uso.
- Leilões: criação com pelo menos 3 fotos, cancelamento, listagem pública paginada e detalhe.
- Fotos: validadas pelo conteúdo e guardadas em serviço compatível com S3 (MinIO no ambiente local).
- Ciclo de vida: cinco estados e cinco transições, garantidos também por restrições no banco.
- Worker: abre e fecha leilões sozinho, lendo do banco; sobrevive a reinício.
- Regra do lance: transação única com trava por leilão, idempotência por chave, lance mínimo
  por tabela e prorrogação. Está implementada e testada, mas ainda não tem porta de entrada.

## O que ainda não existe

- Parte 2 — sala em tempo real (Socket.IO): é por ela que os lances entram.
- Parte 3 — telas (React), proxy (Caddy), dados de demonstração e README final.

Por enquanto o sistema responde só pela API HTTP em `/api`.

## Como rodar

Precisa de Docker com o plugin Compose.

```bash
cp .env.example .env        # ajuste PORTA_PUBLICA se precisar
docker compose up -d --build
docker compose ps           # db, minio, api e worker devem estar "running"
```

A API fica em `http://localhost:8080` (ou na porta definida em `PORTA_PUBLICA`).

## Como testar

No navegador:

- `/api/saude` — a API está no ar e mostra a hora do servidor
- `/api/config` — categorias e limites em vigor
- `/api/leiloes` — listagem pública

Fluxo completo, só com `curl` (cadastro, fotos, criação, abertura e fechamento automáticos):

```bash
./scripts/experimentar.sh                    # ou: ./scripts/experimentar.sh http://IP:PORTA
```

Testes automatizados (71 testes: regras puras e domínio contra Postgres e bucket reais):

```bash
C="docker compose -p leilao-teste --env-file .env.teste -f docker-compose.yml -f docker-compose.teste.yml"
$C up -d db minio
$C run --rm testes npm run test:unidade
$C run --rm testes npm run test:dominio
$C down -v
```

## Limites configuráveis

Todos os limites de negócio são variáveis de ambiente, listadas em `.env.example`
(antecedência e duração do leilão, quantidade e tamanho das fotos, prorrogação,
duração da sessão). Mudou o `.env`, vale no próximo `docker compose up -d`.
