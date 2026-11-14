import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { config } from '../../src/config.js';
import { habilitarComitente, resumoDeCredito } from '../../src/credito.js';
import { darLance, type ResultadoLance } from '../../src/lances.js';
import type { Usuario } from '../../src/sessoes.js';
import { fecharLeiloes } from '../../src/transicoes.js';
import { chave, definirTerminos, dormir, encerrar, linha, novoLeilaoAberto, novoUsuario, preparar } from './apoio.js';

let comitente: Usuario;
let ana: Usuario;

before(async () => {
  await preparar();
  comitente = await novoUsuario('Comitente');
  ana = await novoUsuario('Ana');
});

after(encerrar);

const lance = (quem: Usuario, leilaoId: number, valorCentavos: number, k = chave()) =>
  darLance({ usuarioId: quem.id, leilaoId, valorCentavos, chave: k });

// RF13 (Nível 2): o mesmo usuário não pode emendar lances. Respeitamos a janela
// entre dois lances do mesmo usuário para isolar o que estamos testando (RF31).
const esperarLance = () => dormir(config.lances.intervaloMinimoMs + 80);

function aceito(r: ResultadoLance) {
  assert.equal(r.aceito, true, `esperava lance aceito, veio ${JSON.stringify(r)}`);
  return r;
}

function recusado(r: ResultadoLance, motivo: string) {
  assert.equal(r.aceito, false, `esperava recusa por ${motivo}, veio ${JSON.stringify(r)}`);
  assert.equal(r.motivo, motivo);
  return r;
}

// renda R$ 20.000 -> pontuação 50 (só a parcela de renda) -> limite R$ 60.000.
// Cada teste usa um usuário novo para as reservas de um não vazarem no outro.
const novoLimitado = () => novoUsuario('Limitado', 20_000_00);

test('RF31: limite = renda mensal × 6 × pontuação ÷ 100, e disponível desconta a reserva', async () => {
  const c = await resumoDeCredito((await novoLimitado()).id);
  assert.equal(c.pontuacao, 50);
  assert.equal(c.limiteCentavos, 60_000_00);
  assert.equal(c.reservadoCentavos, 0);
  assert.equal(c.disponivelCentavos, 60_000_00);
});

test('RF31: lance acima do crédito disponível é recusado com CREDITO_INSUFICIENTE', async () => {
  const comprador = await novoLimitado();
  const a = await novoLeilaoAberto(comitente, { precoInicialCentavos: 50_000_00 });
  aceito(await lance(comprador, a, 50_000_00)); // reserva R$ 50.000
  assert.equal((await resumoDeCredito(comprador.id)).disponivelCentavos, 10_000_00);

  const b = await novoLeilaoAberto(comitente, { precoInicialCentavos: 10_000_00 });
  await esperarLance();
  recusado(await lance(comprador, b, 15_000_00), 'CREDITO_INSUFICIENTE'); // mais que os R$ 10.000 livres
  await esperarLance();
  aceito(await lance(comprador, b, 10_000_00)); // exatamente o disponível
  assert.equal((await resumoDeCredito(comprador.id)).disponivelCentavos, 0);
});

test('RF31: a reserva é liberada quando o usuário é superado', async () => {
  const comprador = await novoLimitado();
  const a = await novoLeilaoAberto(comitente, { precoInicialCentavos: 50_000_00 });
  aceito(await lance(comprador, a, 50_000_00));
  const b = await novoLeilaoAberto(comitente, { precoInicialCentavos: 10_000_00 });
  await esperarLance();
  aceito(await lance(comprador, b, 10_000_00));
  assert.equal((await resumoDeCredito(comprador.id)).disponivelCentavos, 0);

  // a Ana cobre o lance no leilão A: a reserva do comprador cai para o leilão B
  aceito(await lance(ana, a, 200_000_00));
  const c = await resumoDeCredito(comprador.id);
  assert.equal(c.reservadoCentavos, 10_000_00);
  assert.equal(c.disponivelCentavos, 50_000_00);
});

test('RF31: a reserva é liberada quando o leilão termina, e vira histórico de compras', async () => {
  const comprador = await novoLimitado();
  const b = await novoLeilaoAberto(comitente, { precoInicialCentavos: 10_000_00 });
  aceito(await lance(comprador, b, 10_000_00));
  assert.equal((await resumoDeCredito(comprador.id)).reservadoCentavos, 10_000_00);

  await definirTerminos(b, -1);
  await fecharLeiloes();
  assert.equal((await linha(b)).status, 'VENDIDO');

  const c = await resumoDeCredito(comprador.id);
  assert.equal(c.reservadoCentavos, 0, 'a reserva some quando o leilão sai de Em andamento');
  assert.equal(c.compras, 1, 'vencer vira compra no histórico');
  assert.equal(c.totalCompradoCentavos, 10_000_00);
});

test('RF31: dois lances simultâneos em leilões diferentes nunca passam do limite', async () => {
  const limitado = await novoLimitado(); // limite R$ 60.000
  const x = await novoLeilaoAberto(comitente, { precoInicialCentavos: 40_000_00 });
  const y = await novoLeilaoAberto(comitente, { precoInicialCentavos: 40_000_00 });

  // 40.000 + 40.000 = 80.000 > 60.000: só um entra. Quem perde é barrado pela
  // trava por usuário; dependendo do instante, o RF13 (frequência) age antes.
  const respostas = await Promise.all([lance(limitado, x, 40_000_00), lance(limitado, y, 40_000_00)]);

  assert.equal(respostas.filter((r) => r.aceito).length, 1, JSON.stringify(respostas));
  for (const r of respostas.filter((z) => !z.aceito)) {
    assert.ok(
      ['CREDITO_INSUFICIENTE', 'MUITO_RAPIDO'].includes(r.motivo),
      `recusa inesperada: ${JSON.stringify(r)}`,
    );
  }

  const c = await resumoDeCredito(limitado.id);
  assert.equal(c.reservadoCentavos, 40_000_00, 'só o leilão vencido ficou na reserva');
  assert.ok(c.reservadoCentavos <= c.limiteCentavos, 'a reserva nunca passa do limite');
});

test('RF30: habilitação de comitente exige pontuação mínima de 50', async () => {
  const pobre = await novoUsuario('Pobre', 5_000_00); // R$ 5.000 -> 25 pontos
  const r = await habilitarComitente(pobre.id);
  assert.equal(r.habilitado, false);
  assert.equal(r.pontuacao, 25);
  assert.equal(r.comitenteDesde, null);

  const rica = await novoUsuario('Rica', 10_000_00); // R$ 10.000 -> 50 pontos
  const s = await habilitarComitente(rica.id);
  assert.equal(s.habilitado, true);
  assert.equal(s.pontuacao, 50);
  assert.ok(s.comitenteDesde);
});
