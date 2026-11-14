import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { minhasCompras } from '../../src/credito.js';
import { pool } from '../../src/db.js';
import { criarApp } from '../../src/http.js';
import { darLance } from '../../src/lances.js';
import {
  VALIDADE_SEGUNDOS,
  apagarPresencasVencidas,
  contarPresenca,
  marcarPresenca,
  removerPresenca,
  removerPresencasDaInstancia,
  renovarPresencas,
} from '../../src/presenca.js';
import type { Usuario } from '../../src/sessoes.js';
import { fecharLeiloes } from '../../src/transicoes.js';
import { chave, definirTerminos, encerrar, novoLeilaoAberto, novoUsuario, preparar } from './apoio.js';

/**
 * Bônus 7.2 (operação): o que precisa valer com mais de uma instância da API e
 * o que as métricas mostram. Aqui a "outra instância" é simulada trocando a
 * coluna `instancia` direto no banco.
 */

let comitente: Usuario;
let ana: Usuario;
let bia: Usuario;

before(async () => {
  await preparar();
  comitente = await novoUsuario('Comitente');
  ana = await novoUsuario('Ana');
  bia = await novoUsuario('Bia');
});

after(encerrar);

const envelhecer = (socketId: string) =>
  pool.query(`UPDATE presencas SET visto_em = clock_timestamp() - make_interval(secs => $2) WHERE socket_id = $1`, [
    socketId,
    VALIDADE_SEGUNDOS + 5,
  ]);

test('RF25 com várias instâncias: a contagem sai do banco e é de pessoas, não de abas', async () => {
  const leilao = await novoLeilaoAberto(comitente);
  assert.deepEqual(await contarPresenca(leilao), { leilaoId: leilao, participantes: 0, espectadores: 0 });

  await marcarPresenca('aba-ana-1', leilao, ana.id, 'PARTICIPANTE');
  await marcarPresenca('aba-ana-2', leilao, ana.id, 'ESPECTADOR'); // mesma pessoa, outra aba
  await marcarPresenca('aba-bia', leilao, bia.id, 'ESPECTADOR');
  await marcarPresenca('aba-comitente', leilao, comitente.id, 'COMITENTE');
  // a Bia está conectada em OUTRA instância: conta do mesmo jeito
  await pool.query(`UPDATE presencas SET instancia = 'outra-instancia' WHERE socket_id = 'aba-bia'`);

  assert.deepEqual(await contarPresenca(leilao), { leilaoId: leilao, participantes: 1, espectadores: 2 });

  // trocar de papel é regravar a mesma linha
  await marcarPresenca('aba-bia', leilao, bia.id, 'PARTICIPANTE');
  assert.deepEqual(await contarPresenca(leilao), { leilaoId: leilao, participantes: 2, espectadores: 1 });

  await removerPresenca('aba-ana-1');
  assert.deepEqual(await contarPresenca(leilao), { leilaoId: leilao, participantes: 1, espectadores: 2 });

  // sair de uma sala não mexe nas outras salas do mesmo socket
  const outro = await novoLeilaoAberto(comitente);
  await marcarPresenca('aba-bia', outro, bia.id, 'PARTICIPANTE');
  await removerPresenca('aba-bia', leilao);
  assert.equal((await contarPresenca(leilao)).participantes, 0);
  assert.equal((await contarPresenca(outro)).participantes, 1);
});

test('RF25 com várias instâncias: quem estava em uma instância que morreu sai da contagem', async () => {
  const leilao = await novoLeilaoAberto(comitente);
  await marcarPresenca('viva', leilao, ana.id, 'PARTICIPANTE');
  await marcarPresenca('morta', leilao, bia.id, 'PARTICIPANTE');
  await pool.query(`UPDATE presencas SET instancia = 'instancia-que-morreu' WHERE socket_id = 'morta'`);
  await envelhecer('viva');
  await envelhecer('morta');

  // o batimento só renova os sockets ainda conectados NESTA instância
  await renovarPresencas(['viva', 'morta']);
  assert.deepEqual(await contarPresenca(leilao), { leilaoId: leilao, participantes: 1, espectadores: 0 });

  // o worker apaga a sobra e avisa a sala
  const ouvinte = await pool.connect();
  const avisos: string[] = [];
  try {
    ouvinte.on('notification', (m) => avisos.push(m.payload ?? ''));
    await ouvinte.query('LISTEN leilao_eventos');
    assert.equal(await apagarPresencasVencidas(), 1);
    await ouvinte.query('SELECT 1'); // dá a volta para a notificação chegar
    assert.deepEqual(avisos.map((a) => JSON.parse(a)), [{ leilaoId: leilao, tipo: 'PRESENCA' }]);
  } finally {
    ouvinte.removeAllListeners('notification');
    await ouvinte.query('UNLISTEN *');
    ouvinte.release();
  }
  const { rows } = await pool.query('SELECT socket_id FROM presencas WHERE leilao_id = $1', [leilao]);
  assert.deepEqual(rows.map((r) => r.socket_id), ['viva']);

  // desligamento limpo: a instância leva junto os seus
  await removerPresencasDaInstancia();
  assert.deepEqual(await contarPresenca(leilao), { leilaoId: leilao, participantes: 0, espectadores: 0 });
});

test('RF31: o histórico separa compras (vencidos) de reservas (liderando agora)', async () => {
  const comprador = await novoUsuario('Comprador');
  const vencido = await novoLeilaoAberto(comitente, { precoInicialCentavos: 500_00 });
  const disputando = await novoLeilaoAberto(comitente, { precoInicialCentavos: 300_00 });

  const a = await darLance({ usuarioId: comprador.id, leilaoId: vencido, valorCentavos: 500_00, chave: chave() });
  assert.equal(a.aceito, true, JSON.stringify(a));
  await pool.query('UPDATE usuarios SET ultimo_lance_em = NULL WHERE id = $1', [comprador.id]);
  const b = await darLance({ usuarioId: comprador.id, leilaoId: disputando, valorCentavos: 300_00, chave: chave() });
  assert.equal(b.aceito, true, JSON.stringify(b));

  await definirTerminos(vencido, -1);
  await fecharLeiloes();

  const h = await minhasCompras(comprador.id);
  assert.deepEqual(h.compras.map((c) => [c.leilaoId, c.valorCentavos]), [[vencido, 500_00]]);
  assert.deepEqual(h.reservas.map((c) => [c.leilaoId, c.valorCentavos]), [[disputando, 300_00]]);
  assert.equal(h.totalCompradoCentavos, 500_00);
  assert.equal(h.reservadoCentavos, 300_00);
});

test('Métricas: formato do Prometheus, com números do processo e do banco', async () => {
  const app = await criarApp();
  try {
    await app.inject({ method: 'GET', url: '/api/leiloes' });
    await app.inject({ method: 'GET', url: '/api/leiloes/999999' });
    const r = await app.inject({ method: 'GET', url: '/api/metricas' });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers['content-type']), /^text\/plain/);

    const valor = (padrao: RegExp): number => {
      const linha = r.body.split('\n').find((l) => padrao.test(l));
      assert.ok(linha, `não achei ${padrao} nas métricas`);
      return Number(linha.slice(linha.lastIndexOf(' ') + 1));
    };
    // a rota entra como padrão (/api/leiloes/:id), não como URL crua
    assert.equal(valor(/^leilao_http_requisicoes_total\{.*rota="\/api\/leiloes\/:id".*status="404"/), 1);
    assert.ok(valor(/^leilao_http_requisicoes_total\{.*rota="\/api\/leiloes".*status="200"/) >= 1);
    assert.ok(valor(/^leilao_http_duracao_segundos_count\{.*rota="\/api\/leiloes"/) >= 1);
    assert.ok(valor(/^leilao_leiloes\{status="EM_ANDAMENTO"/) >= 1);
    assert.ok(valor(/^leilao_lances_gravados\{/) >= 2);
    assert.equal(valor(/^leilao_banco_no_ar\{/), 1);
    assert.ok(valor(/^leilao_db_conexoes\{estado="abertas"/) >= 1);

    // worker parado: um leilão que já devia ter fechado aparece como atraso
    const atrasado = await novoLeilaoAberto(comitente);
    await definirTerminos(atrasado, -30);
    const depois = await app.inject({ method: 'GET', url: '/api/metricas' });
    const fechar = depois.body.split('\n').find((l) => l.startsWith('leilao_transicoes_atrasadas{tipo="fechar"'));
    assert.ok(fechar && Number(fechar.split(' ').pop()) >= 1, fechar);
    await fecharLeiloes();
  } finally {
    await app.close();
  }
});
