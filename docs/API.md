# Regras da API

Tudo responde na mesma origem do site: HTTP em `/api`, tempo real em `/socket.io`.

## Convenções

| Assunto | Regra |
|---|---|
| Formato | JSON em UTF-8. Corpo de envio com `content-type: application/json` (fotos: `multipart/form-data`). |
| Dinheiro | Sempre inteiro, em centavos, em campos terminados em `Centavos`. Nunca decimal. |
| Horário | ISO 8601 em UTC (`2026-11-14T18:25:40.719Z`). Envio exige fuso explícito. A tela converte para o fuso de quem vê. |
| Relógio | Vale o do servidor (banco). Toda resposta relevante traz `agora`. |
| Sessão | Cookie `sessao`, HttpOnly, SameSite=Lax. Expira com 2 h sem uso; cada uso renova; teto de 24 h. |
| Erro | `{ "erro": { "codigo", "mensagem", "campos"? } }`. `campos` traz a mensagem de cada campo inválido. |
| Paginação | `?pagina=N`; a resposta traz `pagina`, `porPagina` e `total`. |

Status HTTP usados: 200, 201, 204, 400 (requisição malformada), 401 (sem sessão), 403 (não é o dono),
404, 409 (regra de negócio impede), 413 (foto grande), 415 (não é imagem), 422 (validação), 500.

## Rotas HTTP

| Método e rota | Login | O que faz |
|---|---|---|
| `GET /api/saude` | não | Diz se está no ar e a hora do servidor. |
| `GET /api/config` | não | Categorias, limites, tabela de incrementos e regra de prorrogação em vigor. |
| `POST /api/usuarios` | não | Cadastro: `nome`, `email`, `senha`. Já abre a sessão. `409 EMAIL_JA_CADASTRADO`. |
| `POST /api/sessao` | não | Login: `email`, `senha`. `401 CREDENCIAIS_INVALIDAS`. |
| `DELETE /api/sessao` | — | Logout: apaga a sessão no servidor. |
| `GET /api/eu` | sim | Usuário da sessão. |
| `POST /api/fotos` | sim | Envia uma foto no campo `arquivo`. Devolve `{ foto: { id, url } }`. |
| `GET /api/fotos/:id` | não | Bytes da foto, vindos do bucket. |
| `GET /api/leiloes` | não | Listagem. `?status=` (lista separada por vírgula ou `TODOS`; padrão: agendados e em andamento), `?categoria=`, `?pagina=`. |
| `POST /api/leiloes` | sim | Cria item e leilão: `nome`, `descricao`, `categoria`, `fotoIds[]`, `precoInicialCentavos`, `inicioEm`, `duracaoSegundos`. |
| `GET /api/leiloes/:id` | não | Detalhe. Com login, traz `eu` (sou comitente, sou líder, posso cancelar, venci). |
| `POST /api/leiloes/:id/cancelar` | sim | Só o comitente. `409 CANCELAMENTO_NAO_PERMITIDO` se houver lances ou já tiver terminado. |
| `GET /api/eu/leiloes` | sim | Leilões que eu anunciei, em qualquer estado. |

## Tempo real (Socket.IO)

A conexão só é aceita com sessão válida (`connect_error: NAO_AUTENTICADO`).

| Evento | Sentido | Dados | Resposta (ack) |
|---|---|---|---|
| `sala:entrar` | cliente → servidor | `{ leilaoId }` | `{ ok, estado, eu: { papel, numero } }` |
| `sala:sair` | cliente → servidor | `{ leilaoId }` | `{ ok }` |
| `lance:enviar` | cliente → servidor | `{ leilaoId, valorCentavos, chave }` | resultado do lance |
| `sala:estado` | servidor → sala | fotografia completa da sala | — |

`estado` traz: `versao`, `status`, `agora`, `inicioEm`, `terminoEm`, `terminoOriginalEm`, `prorrogado`,
`precoInicialCentavos`, `precoAtualCentavos`, `lanceMinimoCentavos`, `totalLances`, `lider`, `ultimosLances`
(os 10 mais recentes) e `resultado`. Pessoas aparecem só como `Participante N`. `versao` cresce a cada
mudança; a tela ignora estado com versão menor que a que já tem.

## Regras do lance

O lance só existe pelo evento `lance:enviar`, vindo de um socket que entrou na sala. É aceito se, no
momento em que é processado:

1. a sessão ainda é válida (conferida no banco a cada lance) e o autor está na sala;
2. o leilão está Em andamento e o horário de término não passou, pelo relógio do servidor;
3. o autor não é o comitente nem o líder atual;
4. o valor é maior ou igual ao lance mínimo vigente naquele instante.

`chave` é gerada no navegador, uma por tentativa (8 a 64 caracteres `A-Z a-z 0-9 _ -`). Reenviar a mesma
chave devolve a resposta original com `reenvio: true` e nunca cria outro lance.

Resposta aceita: `{ aceito: true, lance: { id, sequencia, valorCentavos, em }, meuNumero, lanceMinimoCentavos, terminoEm, prorrogou, reenvio }`.

Resposta recusada: `{ aceito: false, motivo, mensagem, lanceMinimoCentavos, reenvio }`.

| Motivo | Quando | Fica gravado na chave? |
|---|---|---|
| `DADOS_INVALIDOS` | valor não é inteiro positivo, ou chave fora do formato | não |
| `SESSAO_EXPIRADA` | sessão não vale mais; o socket é desligado em seguida | não |
| `FORA_DA_SALA` | o socket não entrou na sala deste leilão | não |
| `LEILAO_INEXISTENTE` | leilão não existe | não |
| `LEILAO_NAO_INICIADO` | ainda Agendado | sim |
| `LEILAO_ENCERRADO` | término passou, ou estado final | sim |
| `COMITENTE_NAO_PODE_DAR_LANCE` | autor é o comitente | sim |
| `JA_E_LIDER` | autor já lidera | sim |
| `VALOR_ABAIXO_DO_MINIMO` | valor menor que o mínimo vigente | sim |
| `CHAVE_REUTILIZADA` | mesma chave com outro leilão ou valor | não |
| `ERRO_INTERNO` | falha ao confirmar; o cliente reenvia a mesma chave | não |

## Lance mínimo e prorrogação

Primeiro lance: pode ser igual ao preço inicial. Depois: preço atual mais o incremento da faixa.

| Preço atual | Incremento |
|---|---|
| até R$ 99,99 | R$ 1,00 |
| R$ 100,00 a R$ 499,99 | R$ 5,00 |
| R$ 500,00 a R$ 999,99 | R$ 10,00 |
| R$ 1.000,00 a R$ 4.999,99 | R$ 50,00 |
| R$ 5.000,00 a R$ 24.999,99 | R$ 100,00 |
| a partir de R$ 25.000,00 | R$ 500,00 |

Lance aceito com menos de 2 minutos no relógio leva o término para 2 minutos depois do lance, até o
limite de 30 minutos de prorrogação acumulada. Os dois valores são configuráveis.

## Estados

`AGENDADO` → `EM_ANDAMENTO` (chega o início) → `VENDIDO` (término com lances) ou `ENCERRADO_SEM_LANCES`
(término sem lances). `AGENDADO` → `CANCELADO` e `EM_ANDAMENTO` sem lances → `CANCELADO`, pelo comitente.
Os três últimos são finais. O banco recusa qualquer outra transição.

## Limites padrão (todos configuráveis no `.env`)

| Campo | Limite |
|---|---|
| Nome do item | 3 a 80 caracteres |
| Descrição | 10 a 2000 caracteres |
| Fotos | 3 a 8; JPEG, PNG ou WebP; até 5 MB cada; validadas pelo conteúdo |
| Preço inicial | R$ 1,00 a R$ 1.000.000.000,00 |
| Antecedência do início | 30 segundos a 30 dias |
| Duração | 1 minuto a 7 dias |
| Senha | 8 caracteres ou mais |
