import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  Cliente,
  type Estado,
  type Sala,
  URL_BASE,
  agoraNoServidor,
  aguardarSistema,
  banco,
  chave,
  configDoSistema,
  dormir,
  expirarSessoes,
  lancesGravados,
  linha,
} from './apoio.js';

/**
 * Núcleo, de ponta a ponta, contra a pilha em pé: proxy, API, worker, banco e
 * bucket. Aqui o tempo é de verdade — ninguém mexe no relógio; os leilões são
 * curtos porque a pilha de teste sobe com limites curtos (RF06).
 */

let cfg: any;
const clientes: Cliente[] = [];

async function novo(nome: string): Promise<Cliente> {
  const c = await Cliente.novo(nome);
  clientes.push(c);
  return c;
}

before(async () => {
  await aguardarSistema();
  cfg = await configDoSistema();
  assert.ok(
    cfg.limites.antecedenciaSegundos.min <= 1 && cfg.limites.duracaoSegundos.min <= 2,
    'os testes de sistema precisam da pilha de teste (.env.teste), que permite leilões de poucos segundos',
  );
});

after(async () => {
  for (const c of clientes) c.fechar();
  await banco.end();
});

const semDadosPessoais = (estados: Estado[], pessoas: Cliente[]) => {
  const texto = JSON.stringify(estados);
  for (const p of pessoas) {
    assert.ok(!texto.includes(p.usuario.nome), `o nome de ${p.usuario.nome} não aparece na sala`);
    assert.ok(!texto.includes(p.usuario.email), 'nenhum e-mail aparece na sala');
  }
};

test('RNF01: o sistema responde pela porta de entrada e usa o relógio do servidor em UTC', async () => {
  const r = await fetch(`${URL_BASE}/api/saude`);
  assert.equal(r.status, 200);
  const corpo = (await r.json()) as any;
  assert.equal(corpo.ok, true);
  assert.match(corpo.agora, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('RF04: visitante vê a listagem e o detalhe, mas não entra na sala', async () => {
  const comitente = await novo('Comitente Visita');
  const leilao = await comitente.criarLeilao(120, 120);

  const visitante = new Cliente();
  const lista = await visitante.req('GET', '/api/leiloes');
  assert.equal(lista.status, 200);
  assert.ok(Array.isArray(lista.corpo.leiloes) && lista.corpo.total >= 1);

  const detalhe = await visitante.req('GET', `/api/leiloes/${leilao.id}`);
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.corpo.leilao.eu, null);
  assert.equal(detalhe.corpo.leilao.item.fotos.length, 3);

  // as fotos vêm do bucket, pela API
  const foto = await fetch(URL_BASE + detalhe.corpo.leilao.item.fotos[0].url);
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get('content-type'), 'image/png');
  assert.ok((await foto.arrayBuffer()).byteLength > 50);

  // a sala exige login: sem sessão, a conexão em tempo real é recusada
  await assert.rejects(visitante.conectar(), /NAO_AUTENTICADO/);
  visitante.cookie = 'sessao=token-inventado';
  await assert.rejects(visitante.conectar(), /NAO_AUTENTICADO/);
});

test('RF09/RF15/RF17: a sala abre sozinha, mostra cada lance na hora, prorroga e fecha sozinha com o vencedor', async () => {
  const janelaMs = cfg.prorrogacao.janelaSegundos * 1000;
  const comitente = await novo('Carla Comitente');
  const ana = await novo('Ana Compradora');
  const bia = await novo('Bia Compradora');

  const leilao = await comitente.criarLeilao(3, 8);
  assert.equal(leilao.status, 'AGENDADO');

  const [sc, sa, sb] = await Promise.all([comitente.entrar(leilao.id), ana.entrar(leilao.id), bia.entrar(leilao.id)]);
  const salas: Sala[] = [sc, sa, sb];
  assert.equal(sa.atual.status, 'AGENDADO');
  assert.equal(sc.eu.papel, 'COMITENTE');
  assert.equal(sa.eu.papel, 'PARTICIPANTE');
  assert.equal(sa.eu.numero, null);

  const cedo = await sa.lance(100_00);
  assert.equal(cedo.aceito, false);
  assert.equal(cedo.motivo, 'LEILAO_NAO_INICIADO');

  // --- abre no horário, sem ninguém intervir e sem recarregar nada ---------
  const abertos = await Promise.all(salas.map((s) => s.aguardar((e) => e.status === 'EM_ANDAMENTO', 10_000, 'abrir')));
  for (const e of abertos) {
    const atraso = new Date(e.agora).getTime() - new Date(leilao.inicioEm).getTime();
    assert.ok(atraso >= 0 && atraso < 1500, `abriu ${atraso} ms depois do horário agendado`);
    assert.equal(e.lanceMinimoCentavos, 100_00);
    assert.equal(e.totalLances, 0);
    assert.equal(e.lider, null);
  }

  // --- o comitente nunca dá lance no próprio leilão ------------------------
  const doComitente = await sc.lance(100_00);
  assert.equal(doComitente.aceito, false);
  assert.equal(doComitente.motivo, 'COMITENTE_NAO_PODE_DAR_LANCE');
  assert.equal(doComitente.lanceMinimoCentavos, 100_00);

  // --- primeiro lance: todos veem na hora ----------------------------------
  const r1 = await sa.lance(100_00);
  assert.equal(r1.aceito, true, JSON.stringify(r1));
  assert.equal(r1.meuNumero, 1);
  for (const e of await Promise.all(salas.map((s) => s.aguardar((x) => x.totalLances === 1, 3000, '1 lance')))) {
    assert.equal(e.precoAtualCentavos, 100_00);
    assert.equal(e.lanceMinimoCentavos, 105_00);
    assert.deepEqual(e.lider, { numero: 1, apelido: 'Participante 1' });
    assert.deepEqual(
      e.ultimosLances.map((u) => [u.sequencia, u.apelido, u.valorCentavos]),
      [[1, 'Participante 1', 100_00]],
    );
  }

  // --- lance abaixo do mínimo: recusado, com motivo e mínimo; a sala não muda
  const baixo = await sb.lance(104_99);
  assert.equal(baixo.aceito, false);
  assert.equal(baixo.motivo, 'VALOR_ABAIXO_DO_MINIMO');
  assert.equal(baixo.lanceMinimoCentavos, 105_00);

  await dormir(520); // RF13: intervalo mínimo entre lances do mesmo usuário
  const r2 = await sb.lance(150_00);
  assert.equal(r2.aceito, true, JSON.stringify(r2));
  assert.equal(r2.meuNumero, 2);
  for (const e of await Promise.all(salas.map((s) => s.aguardar((x) => x.totalLances === 2, 3000, '2 lances')))) {
    assert.equal(e.precoAtualCentavos, 150_00);
    assert.equal(e.lanceMinimoCentavos, 155_00);
    assert.deepEqual(e.lider, { numero: 2, apelido: 'Participante 2' });
    assert.equal(e.prorrogado, false);
  }
  assert.ok(!salas.some((s) => s.estados.some((e) => e.precoAtualCentavos === 104_99)), 'a recusa não apareceu na sala');

  await dormir(520);
  const lider = await sb.lance(900_00);
  assert.equal(lider.motivo, 'JA_E_LIDER');

  // --- prorrogação: lance nos instantes finais dá tempo de resposta ---------
  const fimAgendado = new Date(sa.atual.terminoEm).getTime();
  const espera = fimAgendado - (janelaMs - 800) - (await agoraNoServidor());
  await dormir(Math.max(0, espera));
  const r3 = await sa.lance(155_00);
  assert.equal(r3.aceito, true, JSON.stringify(r3));
  assert.equal(r3.prorrogou, true);
  assert.equal(new Date(r3.terminoEm).getTime(), new Date(r3.lance.em).getTime() + janelaMs);
  for (const e of await Promise.all(salas.map((s) => s.aguardar((x) => x.totalLances === 3, 3000, '3 lances')))) {
    assert.equal(e.terminoEm, r3.terminoEm, 'todos veem o novo horário de término');
    assert.equal(e.prorrogado, true);
    assert.ok(new Date(e.terminoEm).getTime() > fimAgendado);
    assert.deepEqual(e.lider, { numero: 1, apelido: 'Participante 1' });
  }

  // --- fecha no término vigente, sozinho ------------------------------------
  const finais = await Promise.all(salas.map((s) => s.aguardar((e) => e.status === 'VENDIDO', 15_000, 'vender')));
  for (const e of finais) {
    assert.deepEqual(e.resultado, {
      tipo: 'VENDIDO',
      vencedor: { numero: 1, apelido: 'Participante 1' },
      valorCentavos: 155_00,
    });
    assert.equal(e.lanceMinimoCentavos, null);
    const atraso = new Date(e.encerradoEm!).getTime() - new Date(e.terminoEm).getTime();
    assert.ok(atraso >= 0 && atraso < 1500, `fechou ${atraso} ms depois do término`);
    assert.equal(e.terminoEm, r3.terminoEm, 'fechou no término prorrogado, não no original');
  }

  const tarde = await sb.lance(900_00);
  assert.equal(tarde.aceito, false);
  assert.equal(tarde.motivo, 'LEILAO_ENCERRADO');

  // --- o que ficou gravado ---------------------------------------------------
  const l = await linha(leilao.id);
  assert.equal(l.status, 'VENDIDO');
  assert.equal(l.lider_id, ana.usuario.id);
  assert.equal(l.preco_atual_centavos, 155_00);
  assert.equal((await lancesGravados(leilao.id)).length, 3);

  // a sala nunca expôs nome nem e-mail
  semDadosPessoais([...sc.estados, ...sa.estados, ...sb.estados], [comitente, ana, bia]);
  // todos terminaram vendo exatamente o mesmo estado
  const { agora: _a, ...referencia } = sc.atual;
  for (const s of [sa, sb]) {
    const { agora: _b, ...visto } = s.atual;
    assert.deepEqual(visto, referencia);
  }

  // só o comitente fica sabendo o nome de quem comprou; quem venceu sabe que venceu
  const visaoComitente = (await comitente.req('GET', `/api/leiloes/${leilao.id}`)).corpo.leilao;
  assert.equal(visaoComitente.eu.vencedorNome, ana.usuario.nome);
  const visaoAna = (await ana.req('GET', `/api/leiloes/${leilao.id}`)).corpo.leilao;
  assert.equal(visaoAna.eu.venci, true);
  const visaoBia = await bia.req('GET', `/api/leiloes/${leilao.id}`);
  assert.equal(visaoBia.corpo.leilao.eu.venci, false);
  assert.ok(!JSON.stringify(visaoBia.corpo).includes(ana.usuario.nome));
});

test('RF17: leilão que chega ao fim sem lances encerra sozinho como Encerrado sem lances', async () => {
  const comitente = await novo('Comitente Sem Lances');
  const ana = await novo('Ana Espera');
  const leilao = await comitente.criarLeilao(1.5, 2);
  const sala = await ana.entrar(leilao.id);

  await sala.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');
  const fim = await sala.aguardar((e) => e.status === 'ENCERRADO_SEM_LANCES', 8000, 'encerrar');
  assert.deepEqual(fim.resultado, { tipo: 'ENCERRADO_SEM_LANCES' });
  assert.equal(fim.totalLances, 0);
  assert.ok(new Date(fim.encerradoEm!).getTime() >= new Date(fim.terminoEm).getTime());

  // some da listagem de ativos, continua consultável
  const detalhe = await new Cliente().req('GET', `/api/leiloes/${leilao.id}`);
  assert.equal(detalhe.corpo.leilao.status, 'ENCERRADO_SEM_LANCES');
});

test('RF10: só dá lance quem está na sala, com dados válidos', async () => {
  const comitente = await novo('Comitente Sala');
  const ana = await novo('Ana Fora');
  const leilao = await comitente.criarLeilao(1.2, 60);
  const dentro = await ana.entrar(leilao.id);
  await dentro.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');

  // outra aba do mesmo usuário, conectada mas sem entrar na sala
  const fora = await ana.conectar();
  const r = await fora.timeout(5000).emitWithAck('lance:enviar', { leilaoId: leilao.id, valorCentavos: 100_00, chave: chave() });
  assert.equal(r.aceito, false);
  assert.equal(r.motivo, 'FORA_DA_SALA');
  assert.equal(r.lanceMinimoCentavos, 100_00);

  for (const invalido of [
    { leilaoId: leilao.id, valorCentavos: 100.5, chave: chave() },
    { leilaoId: leilao.id, valorCentavos: -100, chave: chave() },
    { leilaoId: leilao.id, valorCentavos: '10000', chave: chave() },
    { leilaoId: leilao.id, valorCentavos: 100_00, chave: 'curta' },
    { leilaoId: leilao.id, valorCentavos: 100_00 },
    { leilaoId: 'abc', valorCentavos: 100_00, chave: chave() },
    null,
  ]) {
    const resposta = await dentro.socket.timeout(5000).emitWithAck('lance:enviar', invalido);
    assert.equal(resposta.aceito, false, JSON.stringify(invalido));
    assert.equal(resposta.motivo, 'DADOS_INVALIDOS');
  }

  const inexistente = await fora.timeout(5000).emitWithAck('sala:entrar', { leilaoId: 99_999_999 });
  assert.equal(inexistente.ok, false);
  assert.equal(inexistente.erro.codigo, 'NAO_ENCONTRADO');

  // depois de sair da sala, não dá mais lance
  await dentro.socket.timeout(5000).emitWithAck('sala:sair', { leilaoId: leilao.id });
  assert.equal((await dentro.lance(100_00)).motivo, 'FORA_DA_SALA');
  assert.equal((await lancesGravados(leilao.id)).length, 0);
});

test('RF02/RF12: com a sessão expirada o lance é recusado; depois do novo login, reenviar a mesma tentativa grava um lance só', async () => {
  const comitente = await novo('Comitente Sessão');
  const ana = await novo('Ana Sessão');
  const leilao = await comitente.criarLeilao(1.2, 60);
  const sala = await ana.entrar(leilao.id);
  await sala.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');

  await expirarSessoes(ana.usuario.id);
  const tentativa = chave();
  const recusado = await sala.lance(100_00, tentativa);
  assert.equal(recusado.aceito, false);
  assert.equal(recusado.motivo, 'SESSAO_EXPIRADA');
  assert.equal(recusado.lanceMinimoCentavos, 100_00);
  assert.equal((await lancesGravados(leilao.id)).length, 0);

  // o servidor desliga o socket de quem perdeu a sessão, e o HTTP também recusa
  for (let i = 0; i < 40 && sala.socket.connected; i++) await dormir(50);
  assert.equal(sala.socket.connected, false);
  assert.equal((await ana.req('GET', '/api/eu')).status, 401);
  await assert.rejects(ana.conectar(), /NAO_AUTENTICADO/);

  // entra de novo e reenvia a MESMA tentativa
  const anaDeVolta = await ana.outroNavegador();
  clientes.push(anaDeVolta);
  const novaSala = await anaDeVolta.entrar(leilao.id);
  const aceito = await novaSala.lance(100_00, tentativa);
  assert.equal(aceito.aceito, true, JSON.stringify(aceito));
  assert.equal(aceito.reenvio, false);

  const repetido = await novaSala.lance(100_00, tentativa);
  assert.equal(repetido.aceito, true);
  assert.equal(repetido.reenvio, true);
  assert.equal(repetido.lance.id, aceito.lance.id);
  assert.equal((await lancesGravados(leilao.id)).length, 1);
});

test('RF11: dez pessoas na sala dão o mesmo lance ao mesmo tempo — uma vence, e todas veem o mesmo estado', async () => {
  const comitente = await novo('Comitente Disputa');
  const pessoas = await Promise.all(Array.from({ length: 10 }, (_, i) => novo(`Disputa ${i + 1}`)));
  const leilao = await comitente.criarLeilao(2.5, 60, { precoInicialCentavos: 10_00 });
  const salas = await Promise.all(pessoas.map((p) => p.entrar(leilao.id)));
  await Promise.all(salas.map((s) => s.aguardar((e) => e.status === 'EM_ANDAMENTO', 10_000, 'abrir')));

  const respostas = await Promise.all(salas.map((s) => s.lance(10_00)));
  assert.equal(respostas.filter((r) => r.aceito).length, 1, 'exatamente um lance aceito');
  for (const r of respostas.filter((x) => !x.aceito)) {
    assert.equal(r.motivo, 'VALOR_ABAIXO_DO_MINIMO');
    assert.equal(r.lanceMinimoCentavos, 11_00, 'quem perdeu já recebe o mínimo novo');
  }
  await Promise.all(salas.map((s) => s.aguardar((e) => e.totalLances === 1, 3000, '1 lance')));

  // rajada: cada um cobre o mínimo que está vendo, cinco vezes, todos juntos
  const rajada: any[] = [];
  await Promise.all(
    salas.map(async (s, n) => {
      for (let i = 0; i < 5; i++) {
        rajada.push(await s.lance(s.atual.lanceMinimoCentavos! + ((n + i) % 3) * 1_00));
        await dormir(520); // respeita o intervalo mínimo entre lances do mesmo usuário
      }
    }),
  );

  const gravados = await lancesGravados(leilao.id);
  assert.equal(gravados.length, 1 + rajada.filter((r) => r.aceito).length);
  assert.ok(gravados.length > 5, `disputa de verdade: ${gravados.length} lances`);
  gravados.forEach((g, i) => {
    assert.equal(g.sequencia, i + 1);
    if (i > 0) {
      assert.ok(g.valor_centavos > gravados[i - 1].valor_centavos, 'valores sempre crescentes');
      assert.notEqual(g.usuario_id, gravados[i - 1].usuario_id);
    }
  });

  const ultimo = gravados[gravados.length - 1];
  const finais = await Promise.all(salas.map((s) => s.aguardar((e) => e.totalLances === gravados.length, 5000, 'estado final')));
  for (const e of finais) {
    assert.equal(e.precoAtualCentavos, ultimo.valor_centavos, 'todos veem o mesmo preço');
    assert.equal(e.versao, finais[0].versao);
    assert.deepEqual(e.lider, finais[0].lider);
    assert.deepEqual(e.ultimosLances, finais[0].ultimosLances);
  }
  // cada sala recebeu os estados em ordem: a versão nunca volta
  for (const s of salas) {
    const versoes = s.estados.map((e) => e.versao);
    assert.deepEqual(versoes, [...versoes].sort((a, b) => a - b));
  }
});

test('RF08: o cancelamento chega à sala na hora; com lances, não cancela', async () => {
  const comitente = await novo('Comitente Cancela');
  const ana = await novo('Ana Cancela');

  const semLances = await comitente.criarLeilao(1.2, 60);
  const sala = await ana.entrar(semLances.id);
  await sala.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');
  const alheio = await ana.req('POST', `/api/leiloes/${semLances.id}/cancelar`);
  assert.equal(alheio.status, 403);
  const ok = await comitente.req('POST', `/api/leiloes/${semLances.id}/cancelar`);
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  const cancelado = await sala.aguardar((e) => e.status === 'CANCELADO', 3000, 'cancelar');
  assert.deepEqual(cancelado.resultado, { tipo: 'CANCELADO' });
  assert.equal((await sala.lance(100_00)).motivo, 'LEILAO_ENCERRADO');
  assert.equal((await linha(semLances.id)).status, 'CANCELADO', 'o leilão continua registrado');

  const comLances = await comitente.criarLeilao(1.2, 60);
  const outraSala = await ana.entrar(comLances.id);
  await outraSala.aguardar((e) => e.status === 'EM_ANDAMENTO', 8000, 'abrir');
  assert.equal((await outraSala.lance(100_00)).aceito, true);
  const negado = await comitente.req('POST', `/api/leiloes/${comLances.id}/cancelar`);
  assert.equal(negado.status, 409);
  assert.equal(negado.corpo.erro.codigo, 'CANCELAMENTO_NAO_PERMITIDO');
  assert.equal((await linha(comLances.id)).status, 'EM_ANDAMENTO');
});

test('RF20: a listagem acompanha o ciclo de vida', async () => {
  const comitente = await novo('Comitente Lista');
  const leilao = await comitente.criarLeilao(1.2, 3);
  const visitante = new Cliente();

  const procurar = async (status: string) => {
    for (let pagina = 1; pagina < 200; pagina++) {
      const r = await visitante.req('GET', `/api/leiloes?status=${status}&pagina=${pagina}`);
      const achado = r.corpo.leiloes.find((l: any) => l.id === leilao.id);
      if (achado) return achado;
      if (pagina * r.corpo.porPagina >= r.corpo.total) return null;
    }
    return null;
  };

  assert.ok(await procurar('AGENDADO'));
  await dormir(2200);
  const aberto = await procurar('EM_ANDAMENTO');
  assert.ok(aberto, 'depois do horário de início aparece como em andamento');
  assert.equal(aberto.lanceMinimoCentavos, 100_00);
  await dormir(3200);
  assert.equal(await procurar('EM_ANDAMENTO'), null);
  assert.equal(await procurar('AGENDADO'), null);
  assert.ok(await procurar('ENCERRADO_SEM_LANCES'));
});
