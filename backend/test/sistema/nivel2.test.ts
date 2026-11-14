import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Cliente, aguardarSistema, banco, dormir, lancesGravados } from './apoio.js';

const clientes: Cliente[] = [];
async function novo(nome: string): Promise<Cliente> {
  const c = await Cliente.novo(nome);
  clientes.push(c);
  return c;
}

before(() => aguardarSistema());
after(async () => {
  for (const c of clientes) c.fechar();
  await banco.end();
});

const ultima = (lista: any[]) => lista[lista.length - 1];

test('RF25: espectador assiste, vira participante sem sair da sala, e a sala conta quem está nela', async () => {
  const carla = await novo('Carla Papel');
  const ana = await novo('Ana Papel');
  const bia = await novo('Bia Papel');
  const leilao = await carla.criarLeilao(1.2, 60);

  const sa = await ana.entrar(leilao.id);
  const presencas: any[] = [];
  sa.socket.on('sala:presenca', (p) => presencas.push(p));
  await sa.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');

  // Bia entra só para assistir; o comitente também assiste o próprio leilão
  const sb = await bia.conectar();
  const entrada = await sb.timeout(5000).emitWithAck('sala:entrar', { leilaoId: leilao.id, papel: 'ESPECTADOR' });
  assert.equal(entrada.ok, true);
  assert.equal(entrada.eu.papel, 'ESPECTADOR');
  const sc = await carla.entrar(leilao.id);
  assert.equal(sc.eu.papel, 'COMITENTE');
  await dormir(300);
  assert.deepEqual(ultima(presencas), { leilaoId: leilao.id, participantes: 1, espectadores: 2 });

  const recusado = await sb.timeout(5000).emitWithAck('lance:enviar', { leilaoId: leilao.id, valorCentavos: 100_00, chave: 'chave-espectador-1' });
  assert.equal(recusado.motivo, 'SOMENTE_ESPECTADOR');
  assert.equal(recusado.lanceMinimoCentavos, 100_00);

  // vira participante sem sair
  const troca = await sb.timeout(5000).emitWithAck('sala:papel', { leilaoId: leilao.id, papel: 'PARTICIPANTE' });
  assert.equal(troca.ok, true);
  await dormir(300);
  assert.deepEqual(ultima(presencas), { leilaoId: leilao.id, participantes: 2, espectadores: 1 });
  const aceito = await sb.timeout(5000).emitWithAck('lance:enviar', { leilaoId: leilao.id, valorCentavos: 100_00, chave: 'chave-participante-1' });
  assert.equal(aceito.aceito, true, JSON.stringify(aceito));

  // o comitente não vira participante
  const doComitente = await sc.socket.timeout(5000).emitWithAck('sala:papel', { leilaoId: leilao.id, papel: 'PARTICIPANTE' });
  assert.equal(doComitente.ok, false);

  // quem sai deixa de ser contado
  sb.close();
  await dormir(500);
  assert.deepEqual(ultima(presencas), { leilaoId: leilao.id, participantes: 1, espectadores: 1 });
});

test('RF26: quem é superado é avisado na hora, mesmo fora da sala', async () => {
  const carla = await novo('Carla Aviso');
  const ana = await novo('Ana Aviso');
  const bia = await novo('Bia Aviso');
  const leilao = await carla.criarLeilao(1.2, 60, { nome: 'Relógio de bolso' });
  const sa = await ana.entrar(leilao.id);
  const sb = await bia.entrar(leilao.id);
  await sa.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');

  // outra aba da Ana, em outra página (conectada, fora da sala)
  const outraAba = await ana.conectar();
  const avisos: any[] = [];
  const avisosBia: any[] = [];
  outraAba.on('lance:superado', (a) => avisos.push(a));
  sb.socket.on('lance:superado', (a) => avisosBia.push(a));

  assert.equal((await sa.lance(100_00)).aceito, true);
  await dormir(300);
  assert.equal(avisos.length, 0, 'primeiro lance não supera ninguém');

  assert.equal((await sb.lance(120_00)).aceito, true);
  await dormir(400);
  assert.deepEqual(avisos, [{ leilaoId: leilao.id, itemNome: 'Relógio de bolso', valorCentavos: 120_00 }]);
  assert.equal(avisosBia.length, 0, 'só quem foi superado é avisado');
});

test('RF24: a conexão cai, volta sozinha, e a sala reaparece com o estado atualizado', async () => {
  const carla = await novo('Carla Queda');
  const ana = await novo('Ana Queda');
  const bia = await novo('Bia Queda');
  const leilao = await carla.criarLeilao(1.2, 60);
  const sa = await ana.entrar(leilao.id, { reconectar: true });
  const sb = await bia.entrar(leilao.id);
  await sa.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');
  assert.equal((await sa.lance(100_00)).aceito, true);

  // derruba a rede da Ana por alguns instantes; a disputa continua sem ela
  const voltou = new Promise<void>((resolve) => sa.socket.once('connect', () => resolve()));
  sa.socket.io.engine.close();
  assert.equal(sa.socket.connected, false);
  assert.equal((await sb.lance(150_00)).aceito, true);

  await voltou;
  const r = await sa.reentrar();
  assert.equal(r.estado.totalLances, 2);
  assert.equal(r.estado.precoAtualCentavos, 150_00);
  assert.equal(r.estado.lanceMinimoCentavos, 155_00);
  assert.equal(r.eu.numero, 1, 'ela continua sendo a mesma participante');

  // e segue disputando sem recomeçar nada
  await dormir(520);
  assert.equal((await sa.lance(155_00)).aceito, true);
  await sb.aguardar((e) => e.totalLances === 3, 3000, '3 lances');
  assert.equal((await lancesGravados(leilao.id)).length, 3);
});

test('RF13: rajada de lances do mesmo usuário é barrada na sala', async () => {
  const carla = await novo('Carla Rajada');
  const ana = await novo('Ana Rajada');
  const bia = await novo('Bia Rajada');
  const um = await carla.criarLeilao(1.2, 60);
  const dois = await carla.criarLeilao(1.2, 60);
  const s1 = await ana.entrar(um.id);
  const s2 = await ana.entrar(dois.id);
  const sb = await bia.entrar(dois.id);
  await Promise.all([s1, s2].map((s) => s.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir')));

  const [a, b] = await Promise.all([s1.lance(100_00), s2.lance(100_00)]);
  const motivos = [a, b].map((r) => (r.aceito ? 'ACEITO' : r.motivo)).sort();
  assert.deepEqual(motivos, ['ACEITO', 'MUITO_RAPIDO']);
  // outra pessoa, no mesmo instante, não é afetada
  assert.notEqual((await sb.lance(900_00)).motivo, 'MUITO_RAPIDO');
});
