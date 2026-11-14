# Leilão online — Hackathon

Plataforma web de leilão em tempo real: o comitente anuncia um item, compradores disputam lances ao
vivo e o leilão abre e fecha sozinho, com um vencedor.

- **Endereço publicado:** a definir (VM da organização).
- **Regras da API:** [docs/API.md](docs/API.md).
- **Estado:** Núcleo completo. Nível 2 pronto no back-end; as telas do Nível 2 estão em aberto. Bônus não começou.

## Arquitetura

Tudo sobe com Docker Compose. Só o proxy publica porta.

| Serviço | O que é | Papel |
|---|---|---|
| `web` | Caddy + telas em React | Única porta de entrada. Serve as telas e encaminha `/api` e `/socket.io`. |
| `api` | Node 22, Fastify, Socket.IO | HTTP e sala em tempo real. Não guarda estado em memória. |
| `worker` | mesmo código da API | Abre e fecha leilões lendo do banco, duas vezes por segundo. |
| `db` | PostgreSQL 16 | Fonte única da verdade e barramento de eventos (LISTEN/NOTIFY). |
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

Para usar o armazenamento da organização em vez do MinIO, no `.env`: apague `COMPOSE_PROFILES=local`,
deixe `S3_ENDPOINT` vazio para o S3 da AWS, ajuste `S3_BUCKET` e `AWS_REGION`, ponha
`S3_CRIAR_BUCKET=false` e informe as chaves (ou deixe sem chaves para usar o perfil da instância).

## Contas de demonstração

Senha de todas: `demo1234`.

| E-mail | Papel na demo |
|---|---|
| `carla@demo.dev` | comitente dos seis leilões |
| `ana@demo.dev` | compradora (conta criada há mais de um ano) |
| `bruno@demo.dev` | comprador |
| `caio@demo.dev` | comprador, venceu o leilão já vendido |

O comando cria um leilão em cada situação: agendado, em andamento sem lances, em andamento com
lances, vendido, encerrado sem lances e cancelado. `--recriar` apaga tudo e cria de novo.

## Testes

```bash
C="docker compose -p leilao-teste --env-file .env.teste -f docker-compose.yml -f docker-compose.teste.yml"
$C up -d --build db minio api worker web
$C run --rm testes npm run test:unidade     # 13 testes: regras puras
$C run --rm testes npm run test:dominio     # 58 testes: banco e bucket reais, tempo controlado
$C run --rm testes npm run test:sistema     #  9 testes: pilha em pé, tempo real, pelo proxy
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
| RNF01 organização | Compose com proxy, API, worker e banco; só o proxy publica porta. | Um comando sobe tudo e a superfície exposta é uma porta só. |

## O que ficou de fora

- Nível 2 (busca, perfil do comitente, edição, espectador, aviso de lance superado, limite de
  frequência, "Minhas participações", relistagem) e Bônus.
- Limpeza de fotos enviadas e nunca usadas em um leilão.
