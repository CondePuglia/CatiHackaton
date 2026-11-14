import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { config } from '../../src/config.js';
import { pool } from '../../src/db.js';
import { CANAL, type EventoLeilao } from '../../src/eventos.js';
import { darLance, type LanceAceito, type LanceRecusado, type Motivo, type ResultadoLance } from '../../src/lances.js';
import { cancelarLeilao, estadoDaSala } from '../../src/leiloes.js';
import { incremento } from '../../src/regras.js';
import type { Usuario } from '../../src/sessoes.js';
import { fecharLeiloes, rodada } from '../../src/transicoes.js';
import {
  chave,
  definirTerminos,
  dormir,
  encerrar,
  lancesDe,
  linha,
  novoLeilao,
  novoLeilaoAberto,
  novoUsuario,
  preparar,
} from './apoio.js';

let comitente: Usuario;
let ana: Usuario;
let bia: Usuario;
let multidao: Usuario[];

before(async () => {
  await preparar();
  comitente = await novoUsuario('Comitente');
  ana = await novoUsuario('Ana');
  bia = await novoUsuario('Bia');
  multidao = [];
  for (let i = 0; i < 25; i++) multidao.push(await novoUsuario('Multidão'));
});

after(encerrar);

const lance = (quem: Usuario, leilaoId: number, valorCentavos: number, k = chave()) =>
  darLance({ usuarioId: quem.id, leilaoId, valorCentavos, chave: k });

function aceito(r: ResultadoLance): LanceAceito {
  assert.equal(r.aceito, true, `esperava lance aceito, veio ${JSON.stringify(r)}`);
  return r as LanceAceito;
}

function recusado(r: ResultadoLance, motivo: Motivo): LanceRecusado {
  assert.equal(r.aceito, false, `esperava recusa por ${motivo}, veio ${JSON.stringify(r)}`);
  const rec = r as LanceRecusado;
  assert.equal(rec.motivo, motivo);
  assert.ok(rec.mensagem.length > 0, 'a recusa traz mensagem para o usuário');
  return rec;
}

// ---------------------------------------------------------------------------
// RF10 — condições do lance
// ---------------------------------------------------------------------------

test('RF10: cada recusa informa o motivo e o lance mínimo atual', async () => {
  const agendado = await novoLeilao(comitente);
  assert.equal(recusado(await lance(ana, agendado, 100_00), 'LEILAO_NAO_INICIADO').lanceMinimoCentavos, null);

  const id = await novoLeilaoAberto(comitente); // preço inicial R$ 100,00

  assert.equal(recusado(await lance(comitente, id, 100_00), 'COMITENTE_NAO_PODE_DAR_LANCE').lanceMinimoCentavos, 100_00);
  assert.equal(recusado(await lance(ana, id, 99_99), 'VALOR_ABAIXO_DO_MINIMO').lanceMinimoCentavos, 100_00);

  const primeiro = aceito(await lance(ana, id, 100_00)); // igual ao preço inicial vale
  assert.equal(primeiro.lance.sequencia, 1);
  assert.equal(primeiro.lanceMinimoCentavos, 105_00);
  assert.equal(primeiro.reenvio, false);

  assert.equal(recusado(await lance(ana, id, 500_00), 'JA_E_LIDER').lanceMinimoCentavos, 105_00);
  assert.equal(recusado(await lance(bia, id, 104_99), 'VALOR_ABAIXO_DO_MINIMO').lanceMinimoCentavos, 105_00);

  const segundo = aceito(await lance(bia, id, 105_00));
  assert.equal(segundo.lance.sequencia, 2);

  recusado(await lance(ana, 99_999_999, 100_00), 'LEILAO_INEXISTENTE');

  const l = await linha(id);
  assert.equal(l.total_lances, 2);
  assert.equal(l.preco_atual_centavos, 105_00);
  assert.equal(l.lider_id, bia.id);
  assert.equal((await lancesDe(id)).length, 2, 'recusas não viram lance');
});

test('RF10: valor acima do mínimo é aceito e vira o novo preço', async () => {
  const id = await novoLeilaoAberto(comitente);
  const r = aceito(await lance(ana, id, 1_234_56));
  assert.equal(r.lanceMinimoCentavos, 1_234_56 + 50_00);
  assert.equal((await linha(id)).preco_atual_centavos, 1_234_56);
});

test('RF10: leilão cancelado não recebe lance', async () => {
  const id = await novoLeilaoAberto(comitente);
  await cancelarLeilao(comitente, id);
  assert.equal(recusado(await lance(ana, id, 100_00), 'LEILAO_ENCERRADO').lanceMinimoCentavos, null);
});

test('RF16: lance depois do término é recusado mesmo antes de o worker fechar o leilão', async () => {
  const id = await novoLeilaoAberto(comitente);
  aceito(await lance(ana, id, 100_00));

  await definirTerminos(id, -1); // o término passou há 1 s e ninguém fechou ainda
  assert.equal((await linha(id)).status, 'EM_ANDAMENTO');

  recusado(await lance(bia, id, 900_00), 'LEILAO_ENCERRADO');
  assert.equal((await linha(id)).total_lances, 1);

  const fechados = await fecharLeiloes();
  assert.ok(fechados.some((f) => f.id === id && f.status === 'VENDIDO'));
  const final = await linha(id);
  assert.equal(final.lider_id, ana.id);
  assert.equal(final.preco_atual_centavos, 100_00);

  recusado(await lance(bia, id, 900_00), 'LEILAO_ENCERRADO');
  assert.equal((await lancesDe(id)).length, 1, 'nunca existe lance aceito depois do fechamento');
});

// ---------------------------------------------------------------------------
// RF14 — lance mínimo
// ---------------------------------------------------------------------------

test('RF14: o lance mínimo cresce a cada lance aceito, seguindo a tabela', async () => {
  const id = await novoLeilaoAberto(comitente, { precoInicialCentavos: 98_00 });
  let minimo = 98_00;
  const vez = [ana, bia];
  for (let i = 0; i < 9; i++) {
    const antes = await estadoDaSala(id);
    assert.equal(antes?.lanceMinimoCentavos, minimo, `mínimo antes do lance ${i + 1}`);
    const r = aceito(await lance(vez[i % 2], id, minimo));
    assert.equal(r.lanceMinimoCentavos, minimo + incremento(minimo));
    assert.ok(r.lanceMinimoCentavos > minimo);
    minimo = r.lanceMinimoCentavos;
  }
  // 98 -> 99 -> 100 -> 105 -> 110 -> 115 -> 120 -> 125 -> 130 -> próximo 135
  assert.equal(minimo, 135_00);
});

// ---------------------------------------------------------------------------
// RF12 — reenvio
// ---------------------------------------------------------------------------

test('RF12: reenviar o mesmo lance devolve o resultado original e não cria outro', async () => {
  const id = await novoLeilaoAberto(comitente);
  const k = chave();
  const original = aceito(await lance(ana, id, 100_00, k));
  const versao = (await linha(id)).versao;

  const reenvio = aceito(await lance(ana, id, 100_00, k));
  assert.equal(reenvio.reenvio, true);
  assert.deepEqual({ ...reenvio, reenvio: false }, original);
  assert.equal((await lancesDe(id)).length, 1);
  assert.equal((await linha(id)).versao, versao, 'o reenvio não muda o leilão');

  // O leilão segue; a resposta daquela tentativa continua sendo a original.
  aceito(await lance(bia, id, 105_00));
  const tardio = aceito(await lance(ana, id, 100_00, k));
  assert.equal(tardio.lance.id, original.lance.id);
  assert.equal((await lancesDe(id)).length, 2);
});

test('RF12: a recusa também é devolvida igual no reenvio', async () => {
  const id = await novoLeilaoAberto(comitente);
  aceito(await lance(bia, id, 100_00));
  const k = chave();
  const original = recusado(await lance(ana, id, 1_00, k), 'VALOR_ABAIXO_DO_MINIMO');
  assert.equal(original.lanceMinimoCentavos, 105_00);

  aceito(await lance(ana, id, 105_00)); // agora a Ana lidera: reprocessar daria JA_E_LIDER
  const reenvio = recusado(await lance(ana, id, 1_00, k), 'VALOR_ABAIXO_DO_MINIMO');
  assert.equal(reenvio.reenvio, true);
  assert.equal(reenvio.lanceMinimoCentavos, 105_00);
});

test('RF12: clique duplo — dez envios simultâneos da mesma tentativa viram um lance só', async () => {
  const id = await novoLeilaoAberto(comitente);
  const k = chave();
  const respostas = await Promise.all(Array.from({ length: 10 }, () => lance(ana, id, 100_00, k)));

  const aceitos = respostas.map(aceito);
  assert.equal(new Set(aceitos.map((r) => r.lance.id)).size, 1, 'todas as respostas apontam para o mesmo lance');
  assert.equal(aceitos.filter((r) => !r.reenvio).length, 1, 'só uma delas processou de verdade');
  assert.equal((await lancesDe(id)).length, 1);
  assert.equal((await linha(id)).total_lances, 1);
});

test('RF12: a chave vale por usuário e não pode ser reaproveitada com outros dados', async () => {
  const id = await novoLeilaoAberto(comitente);
  const k = chave();
  aceito(await lance(ana, id, 100_00, k));
  recusado(await lance(ana, id, 300_00, k), 'CHAVE_REUTILIZADA');
  // a mesma chave, vinda de outra pessoa, é outra tentativa
  aceito(await lance(bia, id, 105_00, k));
  assert.equal((await lancesDe(id)).length, 2);
});

test('RF12: tentativa em leilão inexistente não fica gravada', async () => {
  const k = chave();
  recusado(await lance(ana, 88_888_888, 100_00, k), 'LEILAO_INEXISTENTE');
  const { rowCount } = await pool.query('SELECT 1 FROM tentativas_lance WHERE chave = $1', [k]);
  assert.equal(rowCount, 0);
});

// ---------------------------------------------------------------------------
// RF11 — concorrência
// ---------------------------------------------------------------------------

test('RF11: 25 pessoas dão o mesmo lance ao mesmo tempo — exatamente uma é aceita', async () => {
  const id = await novoLeilaoAberto(comitente);
  const respostas = await Promise.all(multidao.map((p) => lance(p, id, 100_00)));

  const aceitos = respostas.filter((r) => r.aceito);
  assert.equal(aceitos.length, 1);
  for (const r of respostas.filter((x) => !x.aceito)) {
    const rec = recusado(r, 'VALOR_ABAIXO_DO_MINIMO');
    assert.equal(rec.lanceMinimoCentavos, 105_00, 'quem perdeu já recebe o mínimo novo');
  }
  const l = await linha(id);
  assert.equal(l.total_lances, 1);
  assert.equal(l.preco_atual_centavos, 100_00);
  assert.equal((await lancesDe(id)).length, 1);
});

test('RF11: tempestade de lances — a disputa gravada nunca viola a regra do valor', async () => {
  const id = await novoLeilaoAberto(comitente, { precoInicialCentavos: 10_00 });
  const respostas: ResultadoLance[] = [];

  await Promise.all(
    multidao.slice(0, 12).map(async (pessoa, n) => {
      for (let i = 0; i < 15; i++) {
        // cada pessoa olha o mínimo (que já pode estar velho quando o lance chegar) e cobre
        const estado = await estadoDaSala(id);
        const folga = ((n * 7 + i * 13) % 4) * 50;
        respostas.push(await lance(pessoa, id, estado!.lanceMinimoCentavos! + folga));
      }
    }),
  );

  const gravados = await lancesDe(id);
  const l = await linha(id);
  assert.ok(gravados.length >= 12, `esperava uma disputa de verdade, vieram ${gravados.length} lances`);
  assert.equal(respostas.filter((r) => r.aceito).length, gravados.length, 'aceitos = gravados');

  gravados.forEach((atual, i) => {
    assert.equal(atual.sequencia, i + 1, 'sequência contínua, sem buraco nem repetição');
    if (i === 0) {
      assert.ok(atual.valor_centavos >= 10_00);
      return;
    }
    const anterior = gravados[i - 1];
    assert.ok(
      atual.valor_centavos >= anterior.valor_centavos + incremento(anterior.valor_centavos),
      `lance ${i + 1} (${atual.valor_centavos}) respeita o mínimo sobre ${anterior.valor_centavos}`,
    );
    assert.notEqual(atual.usuario_id, anterior.usuario_id, 'o líder nunca cobre o próprio lance');
    assert.ok(atual.criado_em.getTime() >= anterior.criado_em.getTime(), 'ordem de chegada preservada');
  });

  const ultimo = gravados[gravados.length - 1];
  assert.equal(l.total_lances, gravados.length);
  assert.equal(l.preco_atual_centavos, ultimo.valor_centavos);
  assert.equal(l.lider_id, ultimo.usuario_id);

  for (const r of respostas) {
    if (r.aceito) continue;
    assert.ok(['VALOR_ABAIXO_DO_MINIMO', 'JA_E_LIDER'].includes(r.motivo), r.motivo);
    assert.equal(typeof r.lanceMinimoCentavos, 'number');
  }
});

test('RF11: leilões diferentes não se bloqueiam', async () => {
  const ids = await Promise.all([1, 2, 3, 4].map(() => novoLeilaoAberto(comitente)));
  const respostas = await Promise.all(ids.flatMap((id) => [lance(ana, id, 100_00), lance(bia, id, 100_00)]));
  assert.equal(respostas.filter((r) => r.aceito).length, ids.length, 'um aceito por leilão');
});

// ---------------------------------------------------------------------------
// RF15 — prorrogação
// ---------------------------------------------------------------------------

test('RF15: lance perto do fim leva o término para janela depois dele; longe do fim, não mexe', async () => {
  const janela = config.prorrogacao.janelaSegundos;
  const id = await novoLeilaoAberto(comitente);
  const inicial = (await linha(id)).termino_em as Date;

  const longe = aceito(await lance(ana, id, 100_00));
  assert.equal(longe.prorrogou, false);
  assert.equal(longe.terminoEm, inicial.toISOString());

  await definirTerminos(id, janela - 1); // falta menos que a janela
  const perto = aceito(await lance(bia, id, 105_00));
  assert.equal(perto.prorrogou, true);
  assert.equal(new Date(perto.terminoEm).getTime(), new Date(perto.lance.em).getTime() + janela * 1000);

  const l = await linha(id);
  assert.equal(l.termino_em.toISOString(), perto.terminoEm);
  assert.ok(l.termino_original_em.getTime() < l.termino_em.getTime(), 'o término original fica registrado');
  assert.equal((await estadoDaSala(id))?.prorrogado, true);
});

test('RF15: a prorrogação acumulada tem teto, e o leilão não se estende para sempre', async () => {
  const maximo = config.prorrogacao.maximoSegundos;
  const id = await novoLeilaoAberto(comitente);

  // término original há (máximo - 2) s: o teto é daqui a 2 s; hoje falta 1 s
  await definirTerminos(id, -(maximo - 2), 1);
  const teto = ((await linha(id)).termino_original_em as Date).getTime() + maximo * 1000;

  const r1 = aceito(await lance(ana, id, 100_00));
  assert.equal(r1.prorrogou, true);
  assert.equal(new Date(r1.terminoEm).getTime(), teto, 'ganhou só o que faltava até o teto');

  const r2 = aceito(await lance(bia, id, 105_00));
  assert.equal(r2.prorrogou, false, 'no teto, lance não prorroga mais');
  assert.equal(new Date(r2.terminoEm).getTime(), teto);
  assert.equal((await linha(id)).termino_em.getTime(), teto);
});

// ---------------------------------------------------------------------------
// RF17 / RF18 — abertura e fechamento
// ---------------------------------------------------------------------------

test('RF17: no término, com lances vira Vendido para o maior lance; sem lances, Encerrado sem lances', async () => {
  const comLances = await novoLeilaoAberto(comitente);
  aceito(await lance(ana, comLances, 100_00));
  aceito(await lance(bia, comLances, 180_00));
  const semLances = await novoLeilaoAberto(comitente);
  const emCurso = await novoLeilaoAberto(comitente);

  await definirTerminos(comLances, -1);
  await definirTerminos(semLances, -1);
  const fechados = await fecharLeiloes();

  assert.ok(fechados.some((f) => f.id === comLances && f.status === 'VENDIDO'));
  assert.ok(fechados.some((f) => f.id === semLances && f.status === 'ENCERRADO_SEM_LANCES'));
  assert.ok(!fechados.some((f) => f.id === emCurso), 'quem não chegou ao término continua aberto');

  const vendido = await linha(comLances);
  assert.equal(vendido.status, 'VENDIDO');
  assert.equal(vendido.lider_id, bia.id);
  assert.equal(vendido.preco_atual_centavos, 180_00);
  assert.ok(vendido.encerrado_em.getTime() >= vendido.termino_em.getTime());

  const estado = await estadoDaSala(comLances);
  assert.deepEqual(estado?.resultado, {
    tipo: 'VENDIDO',
    vencedor: { numero: 2, apelido: 'Participante 2' },
    valorCentavos: 180_00,
  });
  assert.equal(estado?.lanceMinimoCentavos, null);
  assert.deepEqual((await estadoDaSala(semLances))?.resultado, { tipo: 'ENCERRADO_SEM_LANCES' });
});

test('RF18: fechar duas vezes não duplica nem altera o resultado', async () => {
  const id = await novoLeilaoAberto(comitente);
  aceito(await lance(ana, id, 100_00));
  await definirTerminos(id, -1);

  await fecharLeiloes();
  const primeira = await linha(id);
  const [a, b, c] = await Promise.all([fecharLeiloes(), fecharLeiloes(), rodada()]);
  assert.ok(![...a, ...b, ...c.fechados].some((f) => f.id === id), 'rodadas seguintes não encontram nada para fechar');
  assert.deepEqual(await linha(id), primeira);
});

test('RF18: depois de um reinício, uma rodada coloca em dia o que venceu com o sistema parado', async () => {
  // em andamento, com lance, cujo término passou (criado primeiro: o apoio roda a abertura)
  const emCurso = await novoLeilaoAberto(comitente);
  aceito(await lance(ana, emCurso, 100_00));
  await definirTerminos(emCurso, -30);
  // agendado cujo início E término passaram enquanto ninguém estava olhando
  const perdido = await novoLeilao(comitente);
  await pool.query(
    `UPDATE leiloes SET inicio_em = clock_timestamp() - interval '2 hours',
                        termino_original_em = clock_timestamp() - interval '1 hour',
                        termino_em = clock_timestamp() - interval '1 hour'
      WHERE id = $1`,
    [perdido],
  );
  // agendado cujo início passou, mas ainda está no prazo
  const atrasado = await novoLeilao(comitente);
  await pool.query(
    `UPDATE leiloes SET inicio_em = clock_timestamp() - interval '10 minutes' WHERE id = $1`,
    [atrasado],
  );
  const futuro = await novoLeilao(comitente);

  const r = await rodada(); // primeira rodada depois de "voltar"

  assert.ok(r.abertos.includes(perdido) && r.abertos.includes(atrasado));
  assert.equal((await linha(perdido)).status, 'ENCERRADO_SEM_LANCES');
  assert.ok((await linha(perdido)).aberto_em instanceof Date, 'passou por Em andamento antes de encerrar');
  assert.equal((await linha(atrasado)).status, 'EM_ANDAMENTO');
  assert.equal((await linha(emCurso)).status, 'VENDIDO');
  assert.equal((await linha(emCurso)).lider_id, ana.id);
  assert.equal((await linha(futuro)).status, 'AGENDADO');

  const segunda = await rodada();
  for (const id of [perdido, atrasado, emCurso, futuro]) {
    assert.ok(!segunda.abertos.includes(id) && !segunda.fechados.some((f) => f.id === id));
  }
});

test('RF18: fechamento e lance disputando o último instante nunca deixam estado incoerente', async (t) => {
  let entraram = 0;
  let perderam = 0;
  for (let i = 0; i < 30; i++) {
    const id = await novoLeilaoAberto(comitente);
    if (i % 2 === 0) aceito(await lance(ana, id, 100_00));
    await definirTerminos(id, 0.03 + (i % 5) * 0.01); // termina em 30–70 ms

    const [resposta] = await Promise.all([
      (async () => {
        await dormir(15 + (i % 7) * 9);
        return lance(bia, id, 300_00);
      })(),
      (async () => {
        for (let k = 0; k < 14; k++) {
          await fecharLeiloes();
          await dormir(8);
        }
      })(),
    ]);
    await fecharLeiloes();

    const l = await linha(id);
    const gravados = await lancesDe(id);
    for (const g of gravados) {
      assert.ok(g.criado_em.getTime() < l.termino_em.getTime(), 'todo lance gravado é anterior ao término');
    }

    if (resposta.aceito) {
      entraram++;
      // entrou antes do fim: prorrogou, e o fechamento que esperava a trava desistiu
      assert.equal(l.status, 'EM_ANDAMENTO');
      assert.equal(l.lider_id, bia.id);
      assert.equal(gravados[gravados.length - 1].usuario_id, bia.id);
      assert.ok(l.termino_em.getTime() > gravados[gravados.length - 1].criado_em.getTime());
    } else {
      perderam++;
      recusado(resposta, 'LEILAO_ENCERRADO');
      assert.ok(!gravados.some((g) => g.usuario_id === bia.id));
      assert.equal(l.status, i % 2 === 0 ? 'VENDIDO' : 'ENCERRADO_SEM_LANCES');
      assert.ok(l.encerrado_em.getTime() >= l.termino_em.getTime(), 'não fecha antes do término');
      if (l.status === 'VENDIDO') assert.equal(l.lider_id, ana.id);
    }
    assert.equal(l.total_lances, gravados.length);
  }
  t.diagnostic(`lance entrou antes do fim: ${entraram}; chegou tarde: ${perderam}`);
});

// ---------------------------------------------------------------------------
// Demais garantias
// ---------------------------------------------------------------------------

test('RF10: lance é irrevogável — o banco recusa alterar ou apagar', async () => {
  const id = await novoLeilaoAberto(comitente);
  const r = aceito(await lance(ana, id, 100_00));
  await assert.rejects(pool.query('UPDATE lances SET valor_centavos = 1 WHERE id = $1', [r.lance.id]), /irrevogaveis/);
  await assert.rejects(pool.query('DELETE FROM lances WHERE id = $1', [r.lance.id]), /irrevogaveis/);
  assert.equal((await lancesDe(id))[0].valor_centavos, 100_00);
});

test('RF09: cada pessoa é "Participante N" naquele leilão, e a sala não expõe nome nem e-mail', async () => {
  const id = await novoLeilaoAberto(comitente);
  assert.equal(aceito(await lance(ana, id, 100_00)).meuNumero, 1);
  assert.equal(aceito(await lance(bia, id, 105_00)).meuNumero, 2);
  assert.equal(aceito(await lance(ana, id, 110_00)).meuNumero, 1, 'o número não muda durante a disputa');
  assert.equal(aceito(await lance(multidao[0], id, 115_00)).meuNumero, 3);

  const estado = await estadoDaSala(id);
  assert.ok(estado);
  assert.equal(estado.status, 'EM_ANDAMENTO');
  assert.equal(estado.precoAtualCentavos, 115_00);
  assert.equal(estado.lanceMinimoCentavos, 120_00);
  assert.equal(estado.totalLances, 4);
  assert.deepEqual(estado.lider, { numero: 3, apelido: 'Participante 3' });
  assert.deepEqual(
    estado.ultimosLances.map((u) => [u.sequencia, u.apelido, u.valorCentavos]),
    [
      [4, 'Participante 3', 115_00],
      [3, 'Participante 1', 110_00],
      [2, 'Participante 2', 105_00],
      [1, 'Participante 1', 100_00],
    ],
  );

  const texto = JSON.stringify(estado);
  for (const pessoa of [ana, bia, multidao[0], comitente]) {
    assert.ok(!texto.includes(pessoa.nome) && !texto.includes(pessoa.email), 'sem dado pessoal na sala');
  }
  assert.ok(!/usuario|lider_id|email/i.test(texto), 'sem identificador de usuário na sala');
  assert.match(estado.agora, /Z$/);

  // outro leilão, outra numeração
  const outro = await novoLeilaoAberto(comitente);
  assert.equal(aceito(await lance(bia, outro, 100_00)).meuNumero, 1);
});

test('RF09: a sala mostra só os últimos lances configurados', async () => {
  const id = await novoLeilaoAberto(comitente, { precoInicialCentavos: 1_00 });
  const total = config.lances.recentes + 4;
  for (let i = 0; i < total; i++) aceito(await lance(i % 2 ? ana : bia, id, 1_00 + i * 1_00));
  const estado = await estadoDaSala(id);
  assert.equal(estado?.totalLances, total);
  assert.equal(estado?.ultimosLances.length, config.lances.recentes);
  assert.equal(estado?.ultimosLances[0].sequencia, total);
});

test('RF11: o evento da sala só sai para o que foi gravado, e na ordem dos commits', async () => {
  const ouvinte = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await ouvinte.connect();
  await ouvinte.query(`LISTEN ${CANAL}`);
  const recebidos: EventoLeilao[] = [];
  const visiveis: Array<Promise<void>> = [];
  let id = 0;
  ouvinte.on('notification', (msg) => {
    const evento = JSON.parse(msg.payload!) as EventoLeilao;
    if (evento.leilaoId !== id) return;
    recebidos.push(evento);
    if (evento.tipo === 'LANCE') {
      // quando o aviso chega, o lance já está visível para qualquer leitura
      visiveis.push(
        estadoDaSala(id).then((estado) => {
          assert.ok(estado!.ultimosLances.some((u) => u.valorCentavos === evento.valorCentavos));
        }),
      );
    }
  });

  try {
    id = await novoLeilao(comitente);
    await pool.query(`UPDATE leiloes SET inicio_em = clock_timestamp() - interval '1 second' WHERE id = $1`, [id]);
    await rodada();

    recusado(await lance(ana, id, 1_00), 'VALOR_ABAIXO_DO_MINIMO');
    recusado(await lance(comitente, id, 100_00), 'COMITENTE_NAO_PODE_DAR_LANCE');
    aceito(await lance(ana, id, 100_00));
    aceito(await lance(bia, id, 105_00));
    await definirTerminos(id, -1);
    await rodada();
    await dormir(150);
    await Promise.all(visiveis);

    assert.deepEqual(recebidos, [
      { leilaoId: id, tipo: 'ABERTO' },
      { leilaoId: id, tipo: 'LANCE', liderAnteriorId: null, valorCentavos: 100_00 },
      { leilaoId: id, tipo: 'LANCE', liderAnteriorId: ana.id, valorCentavos: 105_00 },
      { leilaoId: id, tipo: 'ENCERRADO' },
    ]);
  } finally {
    await ouvinte.end();
  }
});

test('RF19: dinheiro é inteiro em centavos do banco até a resposta', async () => {
  const id = await novoLeilaoAberto(comitente, { precoInicialCentavos: 33 * 100 + 33 });
  const r = aceito(await lance(ana, id, 33_33));
  assert.ok(Number.isSafeInteger(r.lance.valorCentavos) && Number.isSafeInteger(r.lanceMinimoCentavos));
  const { rows } = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE column_name LIKE '%centavos' AND table_name IN ('leiloes', 'lances', 'tentativas_lance')`,
  );
  assert.ok(rows.length >= 4 && rows.every((c) => c.data_type === 'bigint'), 'nenhuma coluna de dinheiro é decimal ou float');
  const tempo = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'leiloes' AND column_name LIKE '%\\_em'`,
  );
  assert.ok(tempo.rows.every((c) => c.data_type === 'timestamp with time zone'), 'todo horário carrega fuso');
});
