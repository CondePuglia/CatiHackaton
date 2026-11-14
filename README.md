# Leilão online — Hackathon

Plataforma web de leilão em tempo real: o comitente anuncia um item, compradores disputam lances ao
vivo e o leilão abre e fecha sozinho, com um vencedor.

- **Endereço publicado:** a definir (VM da organização). Nesta máquina, a demonstração está em `http://localhost:8080`.
- **Regras da API:** [docs/API.md](docs/API.md).
- **Estado:** Núcleo, Nível 2 e Bônus 7.1 completos no back-end e nas telas. Bônus 7.2 (nuvem e operação) completo no back-end e na infraestrutura.

## Arquitetura

Tudo sobe com Docker Compose. Só o proxy publica porta.

| Serviço | O que é | Papel |
|---|---|---|
| `web` | Caddy + telas em React | Única porta de entrada. Serve as telas e encaminha `/api` e `/socket.io`. |
| `api` | Node 22, Fastify, Socket.IO | HTTP e sala em tempo real. Não guarda estado em memória; sobem **duas instâncias** por padrão (`API_REPLICAS`) e o Caddy distribui entre elas. |
| `worker` | mesmo código da API | Abre e fecha leilões lendo do banco, duas vezes por segundo. |
| `db` | PostgreSQL 16 | Fonte única da verdade e barramento de eventos (LISTEN/NOTIFY). Pode ser trocado por um banco gerenciado. |
| `minio` | S3 local (perfil `local`) | Só no computador. Na VM, as fotos vão para o serviço de armazenamento da organização. |

## Como recriar do zero

Precisa de Docker com o plugin Compose.

```bash
git clone https://github.com/CondePuglia/CatiHackaton.git
cd CatiHackaton
cp .env.example .env                              # ajuste PORTA_PUBLICA
docker compose up -d --build
docker compose run --rm api node dist/seed.js     # dados de demonstração
```

Abra `http://localhost:8080` (ou `http://IP_DA_VM:PORTA_PUBLICA`).

Para iterar nas telas sem rebuildar o Docker:

```bash
cd frontend
npm install
npm run dev
```

O Vite abre em `http://localhost:5173` e faz proxy de `/api` e `/socket.io` para `http://localhost:8080`.
Use `API_URL=http://IP:PORTA npm run dev` para apontar para outra instância. As decisões de design e a
estrutura do frontend estão em [frontend/DESIGN.md](frontend/DESIGN.md) e [frontend/README.md](frontend/README.md).

Para usar o armazenamento da organização em vez do MinIO, no `.env`: apague `COMPOSE_PROFILES=local`,
deixe `S3_ENDPOINT` vazio para o S3 da AWS, ajuste `S3_BUCKET` e `AWS_REGION`, ponha
`S3_CRIAR_BUCKET=false` e informe as chaves (ou deixe sem chaves para usar o perfil da instância).

Na VM, o ponto de partida é `cp .env.vm.example .env`, que já traz essas escolhas.

## Nuvem e operação (Bônus 7.2)

Tudo é ligado pelo `.env`; o comando continua sendo `docker compose up -d --build`.

| Item | Como está feito | Como mostrar |
|---|---|---|
| Um único comando | `docker compose up -d --build` sobe proxy, API, worker e banco; a API aplica as migrações ao subir. | Recriar do zero pelo README. |
| Mais de uma instância | `API_REPLICAS=2` (padrão) e `WORKER_REPLICAS`. O Caddy descobre as instâncias pelo DNS do Docker e, se uma cai, tenta a outra. | `curl /api/saude` várias vezes: o campo `instancia` alterna. `docker kill leilao-api-1` no meio de um leilão: a sala reconecta na outra em ~1 s. |
| HTTPS com domínio | `SITE_ADDRESS=dominio`, `PORTA_PUBLICA=80`, `PORTA_HTTPS=443`, `COOKIE_SEGURO=true`. O Caddy emite e renova o certificado; ele fica no volume `dados_caddy`. | Abrir `https://dominio`. |
| Banco gerenciado | `COMPOSE_FILE=docker-compose.yml:docker-compose.gerenciado.yml`, `DATABASE_URL` do provedor e `DB_SSL=verificar`. O serviço `db` deixa de subir. | `docker compose ps` sem `db`. |
| Deploy a cada alteração | `.github/workflows/ci-cd.yml`: todo push roda os testes na pilha inteira; na `main`, entra na VM por SSH e roda `scripts/deploy.sh --atualizar`. | Fazer um commit e acompanhar em Actions. |
| Registros e métricas | Registros em JSON de todos os serviços (`docker compose logs -f api worker web`), com uma linha por lance. Métricas em `GET /api/metricas`, formato do Prometheus, e na tela `/metricas`. | Abrir `/metricas` durante a disputa, ou `curl /api/metricas`. |
| Teste de carga | `npm run carga`: dezenas de compradores dando o mesmo lance ao mesmo tempo, com reenvios; no fim confere o que ficou gravado. | Ver abaixo. |

O deploy automático precisa, no GitHub (Settings → Secrets and variables → Actions), das variáveis
`VM_HOST`, `VM_USUARIO`, `VM_PASTA` (e opcionalmente `VM_PORTA` e `URL_PUBLICA`) e do segredo
`VM_CHAVE_SSH`. Sem `VM_HOST`, só os testes rodam. Na VM, o repositório fica clonado em `VM_PASTA`
com o `.env` já preenchido.

Com banco gerenciado, use o endereço direto do banco (não um pooler em modo transação: a API mantém
uma conexão em `LISTEN`) e um usuário que possa criar a extensão `unaccent`.

### Métricas

`GET /api/metricas` (com `Authorization: Bearer $METRICAS_TOKEN`, se a variável estiver preenchida).
Cada coleta cai em uma instância; toda série leva o rótulo `instancia`. A tela `/metricas` (login
necessário) mostra os principais indicadores e as séries brutas para a demo; `curl` e Prometheus
continuam disponíveis.

| Série | O que mostra |
|---|---|
| `leilao_lances_total{resultado}` | Lances recebidos: `ACEITO`, `REENVIO` ou o motivo da recusa. |
| `leilao_lance_duracao_segundos` | Tempo de processamento do lance, incluindo a fila do leilão no banco. |
| `leilao_http_requisicoes_total{metodo,rota,status}` e `leilao_http_duracao_segundos` | Tráfego HTTP por rota. |
| `leilao_sockets_conectados`, `leilao_pessoas_nas_salas` | Conexões nesta instância e pessoas nas salas no sistema todo. |
| `leilao_transicoes_atrasadas{tipo}`, `leilao_transicao_maior_atraso_segundos` | Leilões que já deviam ter aberto ou fechado. Zero com o worker em dia. |
| `leilao_leiloes{status}`, `leilao_lances_gravados` | Estado do negócio, lido do banco. |
| `leilao_db_conexoes{estado}`, `leilao_laco_atraso_segundos` | Saúde do processo: pool do banco e laço de eventos. |

### Teste de carga

```bash
C="docker compose -p leilao-teste --env-file .env.teste -f docker-compose.yml -f docker-compose.teste.yml"
$C up -d --build db minio api worker web
$C run --rm -e CARGA_COMPRADORES=100 -e CARGA_SEGUNDOS=20 testes npm run carga
# contra o sistema publicado (confere pela API, sem acesso ao banco):
$C run --rm --no-deps -e URL_SISTEMA=https://dominio -e DATABASE_URL_SISTEMA= testes npm run carga
```

Resultado em um notebook, com 2 instâncias da API, 100 compradores e 2 leilões por 20 s: 2.843 lances
processados (136/s), 1.464 aceitos, latência p50 8 ms, p95 19 ms, p99 51 ms. A conferência final passou:
sequências sem buraco nem repetição, todo lance acima do mínimo vigente, nenhum reenvio virou segundo
lance e todas as salas terminaram no mesmo estado.

## Contas de demonstração

Senha de todas: `demo1234`.

| E-mail | Papel na demo |
|---|---|
| `carla@demo.dev` | comitente dos sete leilões |
| `ana@demo.dev` | compradora, conta criada há mais de um ano: 70 pontos, crédito de R$ 63.000 |
| `bruno@demo.dev` | comprador: 15 pontos, crédito de R$ 2.700 |
| `caio@demo.dev` | comprador, venceu o leilão já vendido: 4 pontos, crédito de R$ 120 |

O comando cria um leilão em cada situação: agendado, em andamento sem lances, em andamento com
lances, vendido, encerrado sem lances e cancelado, mais um carro com lance mínimo de R$ 50.000, em que
só a Ana tem crédito para participar e os outros entram como espectadores (RF32). `--recriar` apaga tudo e cria de novo.

## Testes

```bash
C="docker compose -p leilao-teste --env-file .env.teste -f docker-compose.yml -f docker-compose.teste.yml"
$C up -d --build db minio api worker web
$C run --rm testes npm run test:unidade     # 15 testes: regras puras
$C run --rm testes npm run test:dominio     # 77 testes: banco e bucket reais, tempo controlado
$C run --rm testes npm run test:sistema     # 16 testes: pilha em pé com 2 APIs e 2 workers, pelo proxy
$C run --rm testes npm run carga            # teste de carga, com conferência no fim
$C down -v
```

`./scripts/experimentar.sh [http://IP:PORTA]` faz um teste de fumaça só com `curl`.

## Decisões da equipe

| Requisito | Decisão | Por quê |
|---|---|---|
| RF02 sessão | Token aleatório em cookie HttpOnly, guardado no banco só como hash. 2 h sem uso, renova a cada uso, teto de 24 h. | Vale em qualquer instância, sobrevive a reinício e dá para encerrar no servidor. |
| RF05 limites | Nome 3–80, descrição 10–2000, 3–8 fotos, antecedência 30 s–30 dias, duração 1 min–7 dias; oito categorias fixas. | Valores de demo. Todos são variáveis de ambiente (RF06) e a tela lê os mesmos números da API. |
| RF07 fotos | JPEG, PNG e WebP até 5 MB, validadas pelos bytes iniciais; enviadas ao bucket pela API, em memória. | O nome e o tipo declarados pelo navegador não são confiáveis; nada toca o disco da VM. |
| RF09 tempo real | Socket.IO; a sala recebe a fotografia completa a cada mudança, com os 10 últimos lances. | Traz salas, confirmação de entrega e reconexão prontas; fotografia inteira dispensa conciliar diferenças. |
| RF09 líder | Cada pessoa é "Participante N" naquele leilão, pela ordem de entrada na disputa. | Dá para acompanhar quem cobre quem sem expor nome. Só o comitente vê o nome do comprador, depois de vendido. |
| RF11 concorrência | Uma transação por lance com `SELECT ... FOR UPDATE` na linha do leilão. | Lances no mesmo leilão formam fila no banco; leilões diferentes não se bloqueiam; funciona com várias instâncias. |
| RF12 reenvio | Chave gerada no navegador por tentativa, única por usuário; a resposta original fica gravada. | Clique duplo e falha de rede devolvem a mesma resposta, inclusive recusas. |
| RF14 lance mínimo | Tabela de referência do documento. | Já atende às três condições e é conhecida da banca. |
| RF15 prorrogação | Regra de referência: janela de 2 min, teto de 30 min acumulados. | Dá chance de resposta e tem fim garantido. |
| RF17/18 automação | Worker separado roda dois `UPDATE` condicionais a cada 500 ms. | Sem timer em memória: reiniciar não perde nada e fechar duas vezes não muda nada. |
| RF20 listagem | Em andamento primeiro (termina antes vem antes), depois agendados; 12 por página; atualiza sozinha. | Mostra primeiro o que está acabando; paginação aguenta muitos leilões. |
| RF26 superado | Evento `lance:superado` para o usuário; aviso inline dentro da sala e toast global fora dela. | Cumpre "avisado na hora" esteja na sala, no catálogo ou na conta. |
| RNF01 organização | Compose com proxy, API, worker e banco; só o proxy publica porta. | Um comando sobe tudo e a superfície exposta é uma porta só. |
| RF29 pontuação | 50·min(renda/10k,1) + 20·min(dias/180,1) + 15·min(compras/10,1) + 15·min(total/20k,1), em centavos, arredondado no fim. | Regra pura e testável; renda e compras já estavam no banco. |
| RF30 comitente | Pontuação ≥ 50 habilita a vender; nada de aprovação manual. | Só a pontuação decide, sem fila de análise. |
| RF31 crédito | Limite = renda × 6 × pontuação ÷ 100; reserva = soma dos leilões em andamento que o usuário lidera, calculada na hora. | Sem tabela de reserva: ser superado ou o leilão terminar libera sozinho; vencer vira histórico. |
| RF31 concorrência | No lance, trava-se o usuário (`FOR NO KEY UPDATE`) antes do leilão, depois confere o crédito. | Dois lances simultâneos do mesmo usuário nunca estouram o limite; a ordem de travas evita impasse. |
| RF32 espectador | Só participa quem tem crédito ≥ lance mínimo atual; os demais entram assistindo. | Evita lance que nasce inválido; o crédito é reavaliado a cada lance. |
| 7.2 várias instâncias | Nada em memória: lances em fila no banco, eventos por LISTEN/NOTIFY e presença das salas em tabela, com batimento por instância. | Qualquer instância pode cair ou subir sem quebrar garantia do Núcleo; não precisa de Redis. |
| 7.2 balanceamento | Caddy com descoberta por DNS; rodízio em `/api`, cookie de afinidade em `/socket.io`. | Escalar é mudar um número no `.env`; a afinidade só importa para quem cair em long-polling. |
| 7.2 métricas | Formato do Prometheus, escrito à mão, com números do processo e do banco. | Sem dependência nova, e o atraso do worker fica visível mesmo com o worker em outro contêiner. |
| 7.2 deploy | GitHub Actions testa a pilha inteira e atualiza a VM por SSH com `git pull` + Compose. | O mesmo comando do README; nada de registro de imagens para manter. |

## O que ficou de fora

- Bônus 7.2 de nuvem/operação (banco gerenciado, HTTPS com domínio, deploy automatizado, várias instâncias, métricas e teste de carga).
- Limpeza de fotos enviadas e nunca usadas em um leilão.
