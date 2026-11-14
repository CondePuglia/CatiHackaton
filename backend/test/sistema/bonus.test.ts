import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Cliente, URL_BASE, aguardarSistema, banco, chave, dormir } from './apoio.js';

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

// ---------------------------------------------------------------------------
// Bônus 7.2: várias instâncias e métricas, pela porta de entrada do navegador
// ---------------------------------------------------------------------------

/** Chama /api/saude várias vezes e devolve as instâncias que responderam. */
async function instanciasNoAr(): Promise<Set<string>> {
  const vistas = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const r = (await (await fetch(`${URL_BASE}/api/saude`)).json()) as { instancia: string };
    vistas.add(r.instancia);
  }
  return vistas;
}

test('Várias instâncias: sala, lances e contagem de presença são os mesmos em todas', async (t) => {
  const instancias = await instanciasNoAr();
  if (instancias.size < 2) return t.skip(`só ${instancias.size} instância no ar (API_REPLICAS=1)`);

  const comitente = guardar(await Cliente.novo('Comitente Instâncias'));
  const leilao = await comitente.criarLeilao(2, 60);

  // 8 pessoas, cada uma com a sua conexão: o proxy espalha entre as instâncias
  const pessoas: Cliente[] = [];
  for (let i = 0; i < 8; i++) pessoas.push(guardar(await Cliente.novo(`Pessoa Instâncias ${i}`, { comitente: false })));
  const salas = [];
  for (const p of pessoas) salas.push(await p.entrar(leilao.id));
  const presencas: any[][] = salas.map((s) => {
    const lista: any[] = [];
    s.socket.on('sala:presenca', (p: any) => lista.push(p));
    return lista;
  });

  // as conexões de fato caíram em instâncias diferentes
  const { rows } = await banco.query('SELECT DISTINCT instancia FROM presencas WHERE leilao_id = $1', [leilao.id]);
  assert.ok(rows.length >= 2, `esperava sockets em 2 instâncias, vieram em ${rows.length}`);

  await Promise.all(salas.map((s) => s.aguardar((e) => e.status === 'EM_ANDAMENTO', 10_000, 'abrir')));

  // um lance feito em uma instância aparece para quem está na outra
  const r = await salas[0].lance(100_00, chave());
  assert.equal(r.aceito, true, JSON.stringify(r));
  await Promise.all(salas.map((s) => s.aguardar((e) => e.totalLances === 1, 5000, 'ver o lance')));

  // dois lances de mesmo valor, ao mesmo tempo, por instâncias diferentes: só um entra (RF11)
  const minimo = salas[1].atual.lanceMinimoCentavos!;
  const simultaneos = await Promise.all(salas.slice(1).map((s) => s.lance(minimo, chave())));
  assert.equal(simultaneos.filter((x) => x.aceito).length, 1, JSON.stringify(simultaneos));

  // alguém sai: todas as salas, em qualquer instância, passam a ver 7 participantes
  pessoas[7].fechar();
  await dormir(800);
  for (const lista of presencas.slice(0, 7)) {
    assert.deepEqual(lista[lista.length - 1], { leilaoId: leilao.id, participantes: 7, espectadores: 0 });
  }
});

test('Métricas: /api/metricas mostra lances, sockets e o worker em dia', async () => {
  const cabecalhos: Record<string, string> = process.env.METRICAS_TOKEN
    ? { authorization: `Bearer ${process.env.METRICAS_TOKEN}` }
    : {};
  // cada coleta cai em uma instância; juntamos algumas para ver todas
  let texto = '';
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${URL_BASE}/api/metricas`, { headers: cabecalhos });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/plain/);
    texto += await r.text();
  }
  const linhas = texto.split('\n');
  const soma = (prefixo: string) =>
    linhas.filter((l) => l.startsWith(prefixo)).reduce((total, l) => total + Number(l.split(' ').pop()), 0);

  assert.ok(soma('leilao_lances_total{resultado="ACEITO"') >= 1, 'os lances aceitos deste arquivo aparecem');
  assert.ok(soma('leilao_lances_total{resultado="SOMENTE_ESPECTADOR"') >= 1, 'as recusas aparecem pelo motivo');
  assert.ok(soma('leilao_lance_duracao_segundos_count') >= 1);
  assert.ok(soma('leilao_http_requisicoes_total{') >= 1);
  assert.ok(linhas.some((l) => l.startsWith('leilao_sockets_conectados{')));
  assert.ok(linhas.some((l) => l.startsWith('leilao_leiloes{status="EM_ANDAMENTO"')));

  // com o worker rodando, nada fica esperando para abrir ou fechar por mais de alguns segundos
  const atraso = linhas.filter((l) => l.startsWith('leilao_transicao_maior_atraso_segundos{')).map((l) => Number(l.split(' ').pop()));
  assert.ok(Math.max(...atraso) < 5, `transição atrasada em ${Math.max(...atraso)} s`);
});
