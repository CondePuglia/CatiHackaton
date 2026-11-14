import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import { pool } from '../../src/db.js';
import { criarApp } from '../../src/http.js';
import { darLance } from '../../src/lances.js';
import { modoDeEdicao } from '../../src/regras.js';
import { criarSessao, type Usuario } from '../../src/sessoes.js';
import { fecharLeiloes } from '../../src/transicoes.js';
import {
  chave,
  dadosDeLeilao,
  definirTerminos,
  dormir,
  encerrar,
  linha,
  novoLeilao,
  novoLeilaoAberto,
  novoUsuario,
  preparar,
} from './apoio.js';

let app: FastifyInstance;
let carla: Usuario;
let ana: Usuario;
let bia: Usuario;
const cookies = new Map<number, Record<string, string>>();

before(async () => {
  await preparar();
  app = await criarApp();
  carla = await novoUsuario('Carla Antônia');
  ana = await novoUsuario('Ana');
  bia = await novoUsuario('Bia');
  for (const u of [carla, ana, bia]) cookies.set(u.id, { [config.sessao.cookie]: await criarSessao(u.id) });
});

after(async () => {
  await app.close();
  await encerrar();
});

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, quem?: Usuario, payload?: unknown) =>
  app.inject({ method, url, cookies: quem ? cookies.get(quem.id) : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
const lance = (quem: Usuario, leilaoId: number, valorCentavos: number, k = chave()) =>
  darLance({ usuarioId: quem.id, leilaoId, valorCentavos, chave: k });

test('RF21: busca por trecho do nome, sem diferenciar acento nem maiúscula, combinada com categoria e estado', async () => {
  const camera = await novoLeilao(carla, { nome: 'Câmera Fotográfica Raríssima', categoria: 'eletronicos' });
  const outra = await novoLeilaoAberto(carla, { nome: 'camera de segurança rarissima', categoria: 'casa' });
  await novoLeilao(carla, { nome: 'Violão rarissimo', categoria: 'arte' });

  const ids = async (consulta: string) =>
    (await req('GET', `/api/leiloes?${consulta}`)).json().leiloes.map((l: { id: number }) => l.id).sort();

  assert.deepEqual(await ids('q=CAMERA&status=TODOS'), [camera, outra].sort());
  assert.deepEqual(await ids(`q=${encodeURIComponent('fotográf')}&status=TODOS`), [camera]);
  assert.deepEqual(await ids('q=rarissim&categoria=casa&status=TODOS'), [outra]);
  assert.deepEqual(await ids('q=rarissim&status=EM_ANDAMENTO'), [outra]);
  assert.deepEqual(await ids('q=rarissim&categoria=arte&status=EM_ANDAMENTO'), []);
  assert.deepEqual(await ids(`q=${encodeURIComponent('100%')}&status=TODOS`), [], 'curinga digitado não vira curinga');
});

test('RF22: qualquer pessoa busca comitentes pelo nome e vê o perfil público', async () => {
  const cancelado = await novoLeilao(carla);
  await req('POST', `/api/leiloes/${cancelado}/cancelar`, carla);

  const busca = (await req('GET', '/api/comitentes?q=antonia')).json(); // sem login, sem acento
  const achada = busca.comitentes.find((c: { id: number }) => c.id === carla.id);
  assert.ok(achada);
  assert.equal(achada.nome, carla.nome);
  assert.ok(!busca.comitentes.some((c: { id: number }) => c.id === ana.id), 'quem nunca anunciou não é comitente');

  const perfil = await req('GET', `/api/comitentes/${carla.id}`);
  assert.equal(perfil.statusCode, 200);
  const p = perfil.json();
  assert.equal(p.comitente.nome, carla.nome);
  assert.match(p.comitente.desde, /Z$/);
  assert.ok(p.agendados.length >= 1 && p.emAndamento.length >= 1);
  assert.ok(p.passados.leiloes.some((l: { id: number }) => l.id === cancelado));
  assert.ok(!perfil.body.includes(carla.email), 'o e-mail não aparece no perfil');
  assert.ok(!/avalia|reputa/i.test(perfil.body));
  assert.equal((await req('GET', '/api/comitentes/999999')).statusCode, 404);
});

test('RF23: agendado com folga edita tudo; perto do início, nada', async () => {
  const id = await novoLeilao(carla);
  assert.equal((await req('GET', `/api/leiloes/${id}`, carla)).json().leilao.eu.edicao, 'TUDO');

  const novos = await dadosDeLeilao(carla, { nome: 'Nome novo', precoInicialCentavos: 777_00, duracaoSegundos: 900 });
  const r = await req('PATCH', `/api/leiloes/${id}`, carla, novos);
  assert.equal(r.statusCode, 200, r.body);
  const l = r.json().leilao;
  assert.equal(l.item.nome, 'Nome novo');
  assert.equal(l.precoInicialCentavos, 777_00);
  assert.equal(new Date(l.terminoEm).getTime() - new Date(l.inicioEm).getTime(), 900_000);
  assert.deepEqual(l.item.fotos.map((f: { id: number }) => f.id), novos.fotoIds);

  assert.equal((await req('PATCH', `/api/leiloes/${id}`, ana, novos)).statusCode, 403);
  assert.equal((await req('PATCH', `/api/leiloes/${id}`, carla, { ...novos, nome: 'x' })).statusCode, 422);

  // dentro do bloqueio: nenhuma edição, mas ainda cancela
  await pool.query(`UPDATE leiloes SET inicio_em = clock_timestamp() + make_interval(secs => $2) WHERE id = $1`, [
    id, config.edicao.bloqueioSegundos - 1,
  ]);
  const travado = await req('PATCH', `/api/leiloes/${id}`, carla, novos);
  assert.equal(travado.statusCode, 409);
  assert.equal(travado.json().erro.codigo, 'EDICAO_NAO_PERMITIDA');
  const detalhe = (await req('GET', `/api/leiloes/${id}`, carla)).json().leilao;
  assert.equal(detalhe.eu.edicao, 'NADA');
  assert.equal(detalhe.eu.podeCancelar, true);
});

test('RF23: em andamento só dá para acrescentar texto à descrição, e quem deu lance não é prejudicado', async () => {
  const id = await novoLeilaoAberto(carla);
  assert.equal((await lance(ana, id, 100_00)).aceito, true);
  const antes = (await req('GET', `/api/leiloes/${id}`)).json().leilao;

  const completo = await req('PATCH', `/api/leiloes/${id}`, carla, await dadosDeLeilao(carla, { precoInicialCentavos: 1_00 }));
  assert.equal(completo.statusCode, 422, 'campos de edição completa são ignorados: falta o complemento');

  const r = await req('PATCH', `/api/leiloes/${id}`, carla, { acrescimoDescricao: 'Acompanha nota fiscal.' });
  assert.equal(r.statusCode, 200, r.body);
  const depois = r.json().leilao;
  assert.equal(depois.item.descricao, `${antes.item.descricao}\n\nAcompanha nota fiscal.`);
  assert.equal(depois.precoInicialCentavos, antes.precoInicialCentavos);
  assert.equal(depois.terminoEm, antes.terminoEm);
  assert.equal(depois.item.nome, antes.item.nome);
  assert.equal(depois.eu.edicao, 'ACRESCENTAR_DESCRICAO');
  assert.equal(depois.eu.podeCancelar, false);

  const longo = await req('PATCH', `/api/leiloes/${id}`, carla, { acrescimoDescricao: 'x'.repeat(config.limites.descricao.max) });
  assert.equal(longo.statusCode, 422);

  await definirTerminos(id, -1);
  await fecharLeiloes();
  const final = await req('PATCH', `/api/leiloes/${id}`, carla, { acrescimoDescricao: 'tarde demais' });
  assert.equal(final.statusCode, 409);
});

test('RF23: a política é uma função pura que cobre as cinco linhas da tabela', () => {
  const t = (s: number) => new Date(1_800_000_000_000 + s * 1000);
  const base = { inicioEm: t(3600), terminoEm: t(7200), totalLances: 0 };
  assert.equal(modoDeEdicao({ ...base, status: 'AGENDADO' }, t(0), 1800), 'TUDO');
  assert.equal(modoDeEdicao({ ...base, status: 'AGENDADO' }, t(1800), 1800), 'NADA');
  assert.equal(modoDeEdicao({ ...base, status: 'EM_ANDAMENTO' }, t(4000), 1800), 'ACRESCENTAR_DESCRICAO');
  assert.equal(modoDeEdicao({ ...base, status: 'EM_ANDAMENTO', totalLances: 3 }, t(4000), 1800), 'ACRESCENTAR_DESCRICAO');
  for (const status of ['VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO'] as const) {
    assert.equal(modoDeEdicao({ ...base, status }, t(4000), 1800), 'NADA');
  }
});

test('RF28: relistar cria novo leilão para o mesmo item, e o item nunca tem dois ativos', async () => {
  const original = await novoLeilao(carla);
  const dados = await dadosDeLeilao(carla, { nome: 'Item relistado', precoInicialCentavos: 50_00 });

  const cedo = await req('POST', `/api/leiloes/${original}/relistar`, carla, dados);
  assert.equal(cedo.statusCode, 409);
  assert.equal(cedo.json().erro.codigo, 'RELISTAGEM_NAO_PERMITIDA');

  await req('POST', `/api/leiloes/${original}/cancelar`, carla);
  assert.equal((await req('GET', `/api/leiloes/${original}`, carla)).json().leilao.eu.podeRelistar, true);
  assert.equal((await req('POST', `/api/leiloes/${original}/relistar`, ana, dados)).statusCode, 403);

  const r = await req('POST', `/api/leiloes/${original}/relistar`, carla, dados);
  assert.equal(r.statusCode, 201, r.body);
  const novo = r.json().leilao;
  assert.notEqual(novo.id, original);
  assert.equal(novo.status, 'AGENDADO');
  assert.equal(novo.item.id, (await linha(original)).item_id, 'é o mesmo item');
  assert.equal(novo.item.nome, 'Item relistado');
  assert.equal(novo.precoInicialCentavos, 50_00);
  assert.equal((await linha(original)).status, 'CANCELADO', 'o leilão antigo continua como estava');

  const deNovo = await req('POST', `/api/leiloes/${original}/relistar`, carla, await dadosDeLeilao(carla));
  assert.equal(deNovo.statusCode, 409);
  assert.equal(deNovo.json().erro.codigo, 'ITEM_JA_TEM_LEILAO_ATIVO');

  // vendido não relista
  const vendido = await novoLeilaoAberto(carla);
  await lance(ana, vendido, 100_00);
  await definirTerminos(vendido, -1);
  await fecharLeiloes();
  assert.equal((await req('POST', `/api/leiloes/${vendido}/relistar`, carla, await dadosDeLeilao(carla))).statusCode, 409);
});

test('RF27: "Minhas participações" mostra líder, superado e vencedor', async () => {
  const dana = await novoUsuario('Dana');
  cookies.set(dana.id, { [config.sessao.cookie]: await criarSessao(dana.id) });
  const lidero = await novoLeilaoAberto(carla);
  const superada = await novoLeilaoAberto(carla);
  const venci = await novoLeilaoAberto(carla);
  const perdi = await novoLeilaoAberto(carla);
  const alheio = await novoLeilaoAberto(carla);

  await lance(dana, lidero, 100_00);
  await lance(dana, superada, 100_00);
  await lance(bia, superada, 105_00);
  await lance(dana, venci, 100_00);
  await lance(dana, perdi, 100_00);
  await lance(bia, perdi, 105_00);
  await lance(bia, alheio, 100_00);
  for (const id of [venci, perdi]) await definirTerminos(id, -1);
  await fecharLeiloes();

  const r = await req('GET', '/api/eu/participacoes', dana);
  assert.equal(r.statusCode, 200);
  const situacao = new Map(r.json().participacoes.map((p: any) => [p.leilaoId, p]));
  assert.equal((situacao.get(lidero) as any).situacao, 'LIDER');
  assert.equal((situacao.get(superada) as any).situacao, 'SUPERADO');
  assert.equal((situacao.get(venci) as any).situacao, 'VENCEDOR');
  assert.equal((situacao.get(perdi) as any).situacao, 'NAO_VENCEU');
  assert.ok(!situacao.has(alheio));
  assert.equal((situacao.get(superada) as any).meuMaiorLanceCentavos, 100_00);
  assert.equal((situacao.get(superada) as any).precoAtualCentavos, 105_00);
  assert.equal((await req('GET', '/api/eu/participacoes')).statusCode, 401);
});

test('RF13: rajada do mesmo usuário é barrada, sem punir reenvio nem bloquear outras pessoas', async () => {
  config.lances.intervaloMinimoMs = 500;
  try {
    const a = await novoLeilaoAberto(carla);
    const b = await novoLeilaoAberto(carla);
    const eva = await novoUsuario('Eva');
    const k1 = chave();
    const primeiro = await lance(eva, a, 100_00, k1);
    assert.equal(primeiro.aceito, true);

    const k2 = chave();
    const rapido = await lance(eva, b, 100_00, k2); // outro leilão, mesmo usuário
    assert.equal(rapido.aceito, false);
    assert.equal(!rapido.aceito && rapido.motivo, 'MUITO_RAPIDO');
    assert.equal(!rapido.aceito && rapido.lanceMinimoCentavos, 100_00);

    const reenvio = await lance(eva, a, 100_00, k1); // RF12: reenvio legítimo passa
    assert.equal(reenvio.aceito, true);
    assert.equal(reenvio.reenvio, true);

    const outra = await novoUsuario('Outra');
    const deOutra = await lance(outra, b, 100_00); // outra pessoa não é afetada
    assert.equal(deOutra.aceito, true);

    await dormir(520);
    const depois = await lance(eva, b, 105_00, k2 + 'x');
    assert.equal(depois.aceito, true, JSON.stringify(depois));
    // a tentativa barrada não ficou gravada
    const { rowCount } = await pool.query('SELECT 1 FROM tentativas_lance WHERE usuario_id = $1 AND chave = $2', [eva.id, k2]);
    assert.equal(rowCount, 0);
  } finally {
    config.lances.intervaloMinimoMs = 0;
  }
});
