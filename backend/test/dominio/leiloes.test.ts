import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import { pool } from '../../src/db.js';
import { criarApp } from '../../src/http.js';
import { darLance } from '../../src/lances.js';
import { gerarPng } from '../../src/png.js';
import { criarSessao, type Usuario } from '../../src/sessoes.js';
import {
  abrirAgora,
  chave,
  dadosDeLeilao,
  emSegundos,
  encerrar,
  habilitarComitente,
  linha,
  multipart,
  novasFotos,
  novoLeilao,
  novoLeilaoAberto,
  novoUsuario,
  pngValido,
  preparar,
} from './apoio.js';

let app: FastifyInstance;
let comitente: Usuario;
let comprador: Usuario;
let cookieComitente: Record<string, string>;
let cookieComprador: Record<string, string>;

before(async () => {
  await preparar();
  app = await criarApp();
  comitente = await novoUsuario('Comitente');
  comprador = await novoUsuario('Comprador');
  await habilitarComitente(comitente);
  cookieComitente = { [config.sessao.cookie]: await criarSessao(comitente.id) };
  cookieComprador = { [config.sessao.cookie]: await criarSessao(comprador.id) };
});

after(async () => {
  await app.close();
  await encerrar();
});

const lim = config.limites;

// ---------------------------------------------------------------------------
// Fotos (RF07)
// ---------------------------------------------------------------------------

const enviar = (dados: Buffer, nome = 'foto.png', tipo = 'image/png', cookies = cookieComitente) =>
  app.inject({ method: 'POST', url: '/api/fotos', cookies, ...multipart(dados, nome, tipo) });

test('RF07: a foto enviada vai para o bucket e volta idêntica, com o tipo certo', async () => {
  const original = gerarPng(32, 24, (x, y) => [x * 8, y * 10, 200]);
  const r = await enviar(original);
  assert.equal(r.statusCode, 201);
  const { id, url } = r.json().foto;
  assert.equal(url, `/api/fotos/${id}`);

  // sem cookie: fotos são públicas, como a listagem
  const baixada = await app.inject({ method: 'GET', url });
  assert.equal(baixada.statusCode, 200);
  assert.equal(baixada.headers['content-type'], 'image/png');
  assert.ok(Buffer.compare(baixada.rawPayload, original) === 0, 'os bytes são os mesmos');
  assert.match(String(baixada.headers['cache-control']), /immutable/);

  // no banco fica só a referência
  const { rows } = await pool.query('SELECT * FROM fotos WHERE id = $1', [id]);
  assert.equal(rows[0].tipo, 'image/png');
  assert.equal(rows[0].tamanho_bytes, original.length);
  assert.match(rows[0].chave, /^fotos\/[0-9a-f-]{36}\.png$/);
  const colunasBinarias = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'fotos' AND data_type = 'bytea'`,
  );
  assert.equal(colunasBinarias.rowCount, 0, 'nenhuma coluna guarda bytes de imagem');
});

test('RF07: o arquivo é validado pelo conteúdo, não pelo nome', async () => {
  const falso = await enviar(Buffer.from('#!/bin/sh\necho oi\n'), 'foto.png', 'image/png');
  assert.equal(falso.statusCode, 415);
  assert.equal(falso.json().erro.codigo, 'TIPO_NAO_ACEITO');

  const gif = await enviar(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'foto.gif', 'image/gif');
  assert.equal(gif.statusCode, 415);

  // nome e tipo declarados errados, conteúdo certo: aceita e grava o tipo real
  const disfarcado = await enviar(pngValido(), 'documento.txt', 'text/plain');
  assert.equal(disfarcado.statusCode, 201);
  const { rows } = await pool.query('SELECT tipo FROM fotos WHERE id = $1', [disfarcado.json().foto.id]);
  assert.equal(rows[0].tipo, 'image/png');
});

test('RF07: foto acima do tamanho máximo é recusada', async () => {
  const grande = Buffer.concat([pngValido(), Buffer.alloc(lim.fotos.tamanhoMaxBytes + 1)]);
  const r = await enviar(grande);
  assert.equal(r.statusCode, 413);
  assert.equal(r.json().erro.codigo, 'ARQUIVO_GRANDE');
});

test('RF07: requisição sem arquivo é recusada com erro claro', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/fotos', cookies: cookieComitente, payload: { x: 1 } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().erro.codigo, 'ARQUIVO_AUSENTE');
  const inexistente = await app.inject({ method: 'GET', url: '/api/fotos/999999' });
  assert.equal(inexistente.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Criação (RF05)
// ---------------------------------------------------------------------------

const criar = (dados: Record<string, unknown>, cookies = cookieComitente) =>
  app.inject({ method: 'POST', url: '/api/leiloes', cookies, payload: dados });

test('RF05: criar leilão com todos os dados gera um leilão Agendado', async () => {
  const dados = await dadosDeLeilao(comitente, { precoInicialCentavos: 250_00, duracaoSegundos: 600 });
  const r = await criar(dados);
  assert.equal(r.statusCode, 201, r.body);
  const l = r.json().leilao;

  assert.equal(l.status, 'AGENDADO');
  assert.equal(l.item.nome, dados.nome);
  assert.equal(l.item.categoria, 'esportes');
  assert.equal(l.item.fotos.length, 3);
  assert.deepEqual(
    l.item.fotos.map((f: { id: number }) => f.id),
    dados.fotoIds,
    'as fotos ficam na ordem enviada',
  );
  assert.equal(l.precoInicialCentavos, 250_00);
  assert.equal(l.precoAtualCentavos, null);
  assert.equal(l.lanceMinimoCentavos, 250_00);
  assert.equal(l.totalLances, 0);
  assert.equal(l.inicioEm, dados.inicioEm);
  assert.equal(new Date(l.terminoEm).getTime() - new Date(l.inicioEm).getTime(), 600_000);
  assert.equal(l.comitente.id, comitente.id);
  assert.equal(l.eu.souComitente, true);
  assert.equal(l.eu.podeCancelar, true);
});

test('RF03/RF30: só quem se habilitou como comitente pode anunciar', async () => {
  const negado = await criar(await dadosDeLeilao(comprador), cookieComprador);
  assert.equal(negado.statusCode, 403);
  assert.equal(negado.json().erro.codigo, 'NAO_HABILITADO');

  await habilitarComitente(comprador);
  const r = await criar(await dadosDeLeilao(comprador), cookieComprador);
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().leilao.comitente.id, comprador.id);
});

test('RF05: cada limite é validado e o erro aponta o campo', async () => {
  const base = await dadosDeLeilao(comitente);
  const casos: Array<[string, Record<string, unknown>, string]> = [
    ['menos fotos que o mínimo', { fotoIds: base.fotoIds.slice(0, lim.fotos.min - 1) }, 'fotos'],
    ['fotos repetidas não contam em dobro', { fotoIds: [base.fotoIds[0], base.fotoIds[0], base.fotoIds[0]] }, 'fotos'],
    ['categoria fora da lista', { categoria: 'armas' }, 'categoria'],
    ['nome curto', { nome: 'ab' }, 'nome'],
    ['nome longo', { nome: 'x'.repeat(lim.nomeItem.max + 1) }, 'nome'],
    ['descrição curta', { descricao: 'curta' }, 'descricao'],
    ['preço zero', { precoInicialCentavos: 0 }, 'precoInicialCentavos'],
    ['preço com fração de centavo', { precoInicialCentavos: 100.5 }, 'precoInicialCentavos'],
    ['preço como texto', { precoInicialCentavos: '10000' }, 'precoInicialCentavos'],
    ['preço acima do teto', { precoInicialCentavos: lim.precoInicialCentavos.max + 1 }, 'precoInicialCentavos'],
    ['início no passado', { inicioEm: emSegundos(-60) }, 'inicioEm'],
    ['início perto demais', { inicioEm: emSegundos(lim.antecedenciaSegundos.min - 0.9) }, 'inicioEm'],
    ['início longe demais', { inicioEm: emSegundos(lim.antecedenciaSegundos.max + 60) }, 'inicioEm'],
    ['início sem fuso', { inicioEm: '2030-01-01T10:00:00' }, 'inicioEm'],
    ['duração curta', { duracaoSegundos: lim.duracaoSegundos.min - 1 }, 'duracaoSegundos'],
    ['duração longa', { duracaoSegundos: lim.duracaoSegundos.max + 1 }, 'duracaoSegundos'],
  ];
  for (const [nome, mudanca, campo] of casos) {
    const r = await criar({ ...base, ...mudanca });
    assert.equal(r.statusCode, 422, `${nome}: ${r.body}`);
    assert.ok(r.json().erro.campos[campo], `${nome}: esperava erro no campo ${campo}, veio ${r.body}`);
  }
  // nenhum desses pedidos criou leilão nem prendeu as fotos
  const ok = await criar(base);
  assert.equal(ok.statusCode, 201, 'os mesmos dados, sem a mudança inválida, são aceitos');
});

test('RF05: os limites exatos são aceitos', async () => {
  const noMinimo = await criar(
    await dadosDeLeilao(comitente, {
      inicioEm: emSegundos(lim.antecedenciaSegundos.min + 2),
      duracaoSegundos: lim.duracaoSegundos.min,
      precoInicialCentavos: lim.precoInicialCentavos.min,
    }),
  );
  assert.equal(noMinimo.statusCode, 201, noMinimo.body);
});

test('RF05: só valem fotos enviadas por quem anuncia e ainda não usadas', async () => {
  const deOutro = await novasFotos(comprador);
  const comFotoAlheia = await criar(await dadosDeLeilao(comitente, { fotoIds: deOutro }));
  assert.equal(comFotoAlheia.statusCode, 422);
  assert.ok(comFotoAlheia.json().erro.campos.fotos);

  const dados = await dadosDeLeilao(comitente);
  assert.equal((await criar(dados)).statusCode, 201);
  const reuso = await criar({ ...(await dadosDeLeilao(comitente)), fotoIds: dados.fotoIds });
  assert.equal(reuso.statusCode, 422, 'a mesma foto não entra em dois itens');
});

// ---------------------------------------------------------------------------
// Listagem e detalhe (RF04, RF20)
// ---------------------------------------------------------------------------

test('RF04/RF20: a listagem é pública e traz agendados e em andamento', async () => {
  const agendado = await novoLeilao(comitente);
  const aberto = await novoLeilaoAberto(comitente);
  const cancelado = await novoLeilao(comitente);
  await app.inject({ method: 'POST', url: `/api/leiloes/${cancelado}/cancelar`, cookies: cookieComitente });

  const r = await app.inject({ method: 'GET', url: '/api/leiloes?pagina=1' }); // sem cookie
  assert.equal(r.statusCode, 200);
  const corpo = r.json();
  const status = new Set(corpo.leiloes.map((l: { status: string }) => l.status));
  assert.deepEqual([...status].sort(), ['AGENDADO', 'EM_ANDAMENTO']);
  assert.match(corpo.agora, /Z$/);

  const todos: Array<{ id: number; status: string }> = [];
  for (let p = 1; p <= Math.ceil(corpo.total / corpo.porPagina); p++) {
    todos.push(...(await app.inject({ method: 'GET', url: `/api/leiloes?pagina=${p}` })).json().leiloes);
  }
  const ids = todos.map((l) => l.id);
  assert.ok(ids.includes(agendado) && ids.includes(aberto));
  assert.ok(!ids.includes(cancelado), 'cancelado sai da listagem pública');
  assert.equal(new Set(ids).size, ids.length, 'paginação não repete leilão');

  // em andamento vem antes de agendado
  const ultimoAberto = todos.map((l) => l.status).lastIndexOf('EM_ANDAMENTO');
  const primeiroAgendado = todos.map((l) => l.status).indexOf('AGENDADO');
  assert.ok(ultimoAberto < primeiroAgendado);

  const card = todos.find((l) => l.id === aberto) as Record<string, any>;
  assert.match(card.item.fotoUrl, /^\/api\/fotos\/\d+$/);
  assert.equal(typeof card.precoInicialCentavos, 'number');
  assert.equal(card.comitente.nome, comitente.nome);
});

test('RF20: a listagem é paginada e ordenada por quem termina ou começa antes', async () => {
  const outro = await novoUsuario('Paginador');
  const esperados: number[] = [];
  for (let i = 0; i < config.listagem.porPagina + 3; i++) {
    esperados.push(await novoLeilao(outro, { inicioEm: emSegundos(7200 + i * 60) }));
  }
  const p1 = (await app.inject({ method: 'GET', url: '/api/leiloes' })).json();
  assert.equal(p1.leiloes.length, config.listagem.porPagina);
  assert.ok(p1.total >= esperados.length);

  const agendados: Array<{ inicioEm: string }> = [];
  for (let p = 1; p <= Math.ceil(p1.total / p1.porPagina); p++) {
    const pagina = (await app.inject({ method: 'GET', url: `/api/leiloes?pagina=${p}&status=AGENDADO` })).json();
    agendados.push(...pagina.leiloes);
  }
  const inicios = agendados.map((l) => new Date(l.inicioEm).getTime());
  assert.deepEqual(inicios, [...inicios].sort((a, b) => a - b), 'agendados em ordem de início');

  const alem = (await app.inject({ method: 'GET', url: '/api/leiloes?pagina=9999' })).json();
  assert.equal(alem.leiloes.length, 0);
  const invalido = await app.inject({ method: 'GET', url: '/api/leiloes?status=INVENTADO' });
  assert.equal(invalido.statusCode, 422);
});

test('RF04: o detalhe é público; dados pessoais de quem lidera não aparecem', async () => {
  const id = await novoLeilaoAberto(comitente);
  const r1 = await darLance({ usuarioId: comprador.id, leilaoId: id, valorCentavos: 100_00, chave: chave() });
  assert.equal(r1.aceito, true);

  const visitante = await app.inject({ method: 'GET', url: `/api/leiloes/${id}` });
  assert.equal(visitante.statusCode, 200);
  const l = visitante.json().leilao;
  assert.equal(l.eu, null);
  assert.deepEqual(l.lider, { numero: 1, apelido: 'Participante 1' });
  assert.ok(!visitante.body.includes(comprador.nome), 'o nome do líder não vaza');
  assert.ok(!visitante.body.includes(comprador.email), 'o e-mail do líder não vaza');
  assert.ok(!visitante.body.includes(comitente.email), 'o e-mail do comitente não vaza');

  const doLider = await app.inject({ method: 'GET', url: `/api/leiloes/${id}`, cookies: cookieComprador });
  assert.equal(doLider.json().leilao.eu.souLider, true);
  assert.equal(doLider.json().leilao.eu.numero, 1);

  assert.equal((await app.inject({ method: 'GET', url: '/api/leiloes/987654' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/leiloes/abc' })).statusCode, 404);
});

// ---------------------------------------------------------------------------
// Cancelamento (RF08)
// ---------------------------------------------------------------------------

const cancelar = (id: number, cookies = cookieComitente) =>
  app.inject({ method: 'POST', url: `/api/leiloes/${id}/cancelar`, cookies });

test('RF08: o comitente cancela um leilão agendado; nada é apagado', async () => {
  const id = await novoLeilao(comitente);
  const r = await cancelar(id);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().leilao.status, 'CANCELADO');
  assert.deepEqual(r.json().leilao.resultado, { tipo: 'CANCELADO' });

  const l = await linha(id);
  assert.equal(l.status, 'CANCELADO');
  assert.ok(l.encerrado_em instanceof Date);
  const itens = await pool.query('SELECT count(*) AS n FROM fotos WHERE item_id = $1', [l.item_id]);
  assert.equal(itens.rows[0].n, 3, 'item e fotos continuam registrados');

  const meus = (await app.inject({ method: 'GET', url: '/api/eu/leiloes', cookies: cookieComitente })).json();
  assert.ok(meus.total >= 1);
  const detalhe = await app.inject({ method: 'GET', url: `/api/leiloes/${id}` });
  assert.equal(detalhe.statusCode, 200, 'o leilão cancelado continua consultável');
});

test('RF08: em andamento sem lances pode cancelar; com lances, não', async () => {
  const semLances = await novoLeilaoAberto(comitente);
  assert.equal((await cancelar(semLances)).statusCode, 200);
  assert.equal((await linha(semLances)).status, 'CANCELADO');

  const comLances = await novoLeilaoAberto(comitente);
  await darLance({ usuarioId: comprador.id, leilaoId: comLances, valorCentavos: 100_00, chave: chave() });
  const r = await cancelar(comLances);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().erro.codigo, 'CANCELAMENTO_NAO_PERMITIDO');
  assert.equal((await linha(comLances)).status, 'EM_ANDAMENTO');
});

test('RF08: só o comitente cancela, e só uma vez', async () => {
  const id = await novoLeilao(comitente);
  const alheio = await cancelar(id, cookieComprador);
  assert.equal(alheio.statusCode, 403);
  assert.equal((await linha(id)).status, 'AGENDADO');

  assert.equal((await cancelar(id)).statusCode, 200);
  const deNovo = await cancelar(id);
  assert.equal(deNovo.statusCode, 409, 'cancelado é estado final');
  assert.equal((await cancelar(424242)).statusCode, 404);
});

test('RF08 × RF10: cancelamento e primeiro lance ao mesmo tempo — só um dos dois vale', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await novoLeilaoAberto(comitente);
    const [c, l] = await Promise.all([
      cancelar(id),
      darLance({ usuarioId: comprador.id, leilaoId: id, valorCentavos: 100_00, chave: chave() }),
    ]);
    const final = await linha(id);
    if (c.statusCode === 200) {
      assert.equal(final.status, 'CANCELADO');
      assert.equal(final.total_lances, 0);
      assert.equal(l.aceito, false, 'o lance perdeu a corrida e foi recusado');
    } else {
      assert.equal(c.statusCode, 409);
      assert.equal(final.status, 'EM_ANDAMENTO');
      assert.equal(final.total_lances, 1);
      assert.equal(l.aceito, true);
    }
  }
});

// ---------------------------------------------------------------------------
// Ciclo de vida garantido pelo banco (RN01)
// ---------------------------------------------------------------------------

const tentar = async (sql: string, parametros: unknown[]): Promise<string | null> => {
  try {
    await pool.query(sql, parametros);
    return null;
  } catch (erro) {
    return (erro as Error).message;
  }
};

test('RN01: só as cinco transições existem — o banco recusa as demais', async () => {
  const agendado = await novoLeilao(comitente);
  for (const destino of ['VENDIDO', 'ENCERRADO_SEM_LANCES', 'INVENTADO']) {
    const erro = await tentar('UPDATE leiloes SET status = $2 WHERE id = $1', [agendado, destino]);
    assert.ok(erro, `AGENDADO -> ${destino} deveria falhar`);
  }

  const aberto = await novoLeilaoAberto(comitente);
  assert.ok(await tentar(`UPDATE leiloes SET status = 'AGENDADO' WHERE id = $1`, [aberto]), 'não volta a agendado');

  // estados finais: nenhuma mudança, de status ou de qualquer outra coisa
  const cancelado = await novoLeilao(comitente);
  await cancelar(cancelado);
  for (const destino of ['AGENDADO', 'EM_ANDAMENTO', 'VENDIDO', 'ENCERRADO_SEM_LANCES']) {
    assert.ok(await tentar('UPDATE leiloes SET status = $2 WHERE id = $1', [cancelado, destino]));
  }
  assert.ok(await tentar('UPDATE leiloes SET preco_inicial_centavos = 1 WHERE id = $1', [cancelado]));
  assert.equal((await linha(cancelado)).status, 'CANCELADO');
});

test('RN01: em andamento com lances só pode terminar Vendido', async () => {
  const id = await novoLeilaoAberto(comitente);
  await darLance({ usuarioId: comprador.id, leilaoId: id, valorCentavos: 100_00, chave: chave() });
  for (const destino of ['ENCERRADO_SEM_LANCES', 'CANCELADO']) {
    const erro = await tentar('UPDATE leiloes SET status = $2 WHERE id = $1', [id, destino]);
    assert.ok(erro, `com lances -> ${destino} deveria falhar`);
    assert.match(erro, /leiloes_sem_lances_nao_vende/);
  }
  const semLances = await novoLeilaoAberto(comitente);
  const erro = await tentar(`UPDATE leiloes SET status = 'VENDIDO' WHERE id = $1`, [semLances]);
  assert.match(String(erro), /leiloes_vendido_tem_lances/);
});

test('RF04: o banco não deixa o comitente liderar o próprio leilão', async () => {
  const id = await novoLeilaoAberto(comitente);
  const erro = await tentar(
    'UPDATE leiloes SET lider_id = $2, preco_atual_centavos = 10000, total_lances = 1 WHERE id = $1',
    [id, comitente.id],
  );
  assert.match(String(erro), /leiloes_comitente_nao_lidera/);
});

test('RF28: um item nunca tem dois leilões ativos ao mesmo tempo', async () => {
  const id = await novoLeilao(comitente);
  const { item_id } = await linha(id);
  const erro = await tentar(
    `INSERT INTO leiloes (item_id, comitente_id, preco_inicial_centavos, inicio_em, termino_original_em, termino_em)
     VALUES ($1, $2, 100, now() + interval '1 hour', now() + interval '2 hours', now() + interval '2 hours')`,
    [item_id, comitente.id],
  );
  assert.match(String(erro), /leiloes_um_ativo_por_item/);
});

test('RF17: abrir é idempotente e só abre o que chegou na hora', async () => {
  const futuro = await novoLeilao(comitente);
  const naHora = await novoLeilao(comitente);
  await abrirAgora(naHora);
  assert.equal((await linha(naHora)).status, 'EM_ANDAMENTO');
  assert.ok((await linha(naHora)).aberto_em instanceof Date);
  assert.equal((await linha(futuro)).status, 'AGENDADO');

  const versao = (await linha(naHora)).versao;
  await abrirAgora(futuro); // roda a abertura de novo
  assert.equal((await linha(naHora)).versao, versao, 'reabrir não mexe no que já estava aberto');
});

test('RF06: os limites vêm da configuração e a tela lê os mesmos valores', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(r.statusCode, 200);
  const c = r.json();
  assert.deepEqual(c.limites.antecedenciaSegundos, lim.antecedenciaSegundos);
  assert.deepEqual(c.limites.duracaoSegundos, lim.duracaoSegundos);
  assert.equal(c.limites.fotos.min, lim.fotos.min);
  assert.deepEqual(c.prorrogacao, config.prorrogacao);
  assert.equal(c.incrementos.length, 6);
  assert.ok(c.categorias.some((x: { id: string }) => x.id === 'outros'));
  assert.match(c.agora, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'RF19: horário em UTC, com Z');
});
