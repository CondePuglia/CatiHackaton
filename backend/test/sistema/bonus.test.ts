import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Cliente, aguardarSistema, banco, chave } from './apoio.js';

/**
 * Bônus (RF32), de ponta a ponta: quem não tem crédito para cobrir o lance
 * mínimo entra na sala como espectador, e quem tem participa normalmente.
 */

const clientes: Cliente[] = [];
const guardar = (c: Cliente): Cliente => {
  clientes.push(c);
  return c;
};

before(async () => {
  await aguardarSistema();
});

after(async () => {
  for (const c of clientes) c.fechar();
  await banco.end();
});

test('RF32: sem crédito suficiente, o usuário entra só como espectador', async () => {
  const comitente = guardar(await Cliente.novo('Comitente Crédito'));
  const rico = guardar(await Cliente.novo('Rico Crédito'));

  const leilao = await comitente.criarLeilao(2, 60, { precoInicialCentavos: 200_000_00 });

  // um usuário com crédito acompanha a abertura
  const salaRico = await rico.entrar(leilao.id);
  await salaRico.aguardar((e) => e.status === 'EM_ANDAMENTO', 10_000, 'abrir');
  assert.equal(salaRico.eu.papel, 'PARTICIPANTE');

  // renda R$ 500 -> limite de ~R$ 90, muito abaixo do lance mínimo de R$ 200.000
  const pobre = guardar(await Cliente.novo('Pobre Crédito', { rendaCentavos: 500_00, comitente: false }));
  const salaPobre = await pobre.entrar(leilao.id);

  assert.equal(salaPobre.eu.papel, 'ESPECTADOR');
  assert.ok((salaPobre.eu as any).aviso, 'o espectador recebe o aviso do motivo');

  const r = await salaPobre.lance(200_000_00, chave());
  assert.equal(r.aceito, false);
  assert.equal(r.motivo, 'SOMENTE_ESPECTADOR');
});
