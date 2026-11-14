import { lanceMinimo } from '../../src/regras.js';
import { Cliente, Sala, aguardarSistema, banco, chave, configDoSistema, dormir, URL_BASE } from '../sistema/apoio.js';

/**
 * Bônus 7.2 — teste de carga: muitos compradores dando lances ao mesmo tempo,
 * pela mesma porta de entrada do navegador (proxy -> instâncias da API -> banco).
 *
 *   npm run carga                                   # dentro do contêiner `testes`
 *   CARGA_COMPRADORES=200 CARGA_SEGUNDOS=30 npm run carga
 *   URL_SISTEMA=https://leilao.exemplo.com npm run carga     # contra a VM
 *
 * Todos miram o lance mínimo que acabaram de ver, então a cada rodada dezenas
 * de lances de mesmo valor chegam juntos no mesmo leilão: é o pior caso do
 * RF11. Uma parte é reenviada com a mesma chave (RF12).
 *
 * No fim, além de vazão e latência, o teste CONFERE o que ficou gravado: se
 * alguma garantia do Núcleo quebrou sob carga, sai com código 1.
 */

const numero = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome] ?? '');
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

const COMPRADORES = numero('CARGA_COMPRADORES', 60);
const LEILOES = numero('CARGA_LEILOES', 2);
const SEGUNDOS = numero('CARGA_SEGUNDOS', 20);
/** de cada 100 lances, quantos são reenviados com a mesma chave */
const REENVIOS_POR_CENTO = numero('CARGA_REENVIOS_POR_CENTO', 10);

const reais = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function percentil(ordenados: number[], p: number): number {
  if (ordenados.length === 0) return 0;
  return ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)];
}

/** Cria `quantidade` coisas, no máximo `emParalelo` de cada vez. */
async function emLotes<T>(quantidade: number, emParalelo: number, criar: (i: number) => Promise<T>): Promise<T[]> {
  const prontos: T[] = [];
  for (let i = 0; i < quantidade; i += emParalelo) {
    const lote = Array.from({ length: Math.min(emParalelo, quantidade - i) }, (_, j) => criar(i + j));
    prontos.push(...(await Promise.all(lote)));
  }
  return prontos;
}

type Aceito = { leilaoId: number; usuarioId: number; sequencia: number; valorCentavos: number };

async function principal(): Promise<number> {
  await aguardarSistema();
  const cfg = await configDoSistema();
  const intervaloMs: number = cfg.lances.intervaloMinimoMs;
  const antecedencia: number = cfg.limites.antecedenciaSegundos.min + 2;
  const duracao: number = Math.max(cfg.limites.duracaoSegundos.min, SEGUNDOS + 30);

  console.log(`Alvo: ${URL_BASE}`);
  console.log(`${COMPRADORES} compradores, ${LEILOES} leilões, ${SEGUNDOS} s de disputa, ${REENVIOS_POR_CENTO}% de reenvios`);

  // quantas instâncias da API respondem atrás do proxy
  const instancias = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const r = (await (await fetch(`${URL_BASE}/api/saude`)).json()) as { instancia?: string };
    if (r.instancia) instancias.add(r.instancia);
  }
  console.log(`Instâncias da API respondendo: ${instancias.size || '?'}`);

  // ---- preparação -----------------------------------------------------------
  console.log('\nCriando contas e leilões…');
  const comitente = await Cliente.novo('Comitente Carga');
  // renda de R$ 10 milhões -> limite de R$ 30 milhões: o crédito não é o gargalo aqui
  const compradores = await emLotes(COMPRADORES, 10, (i) =>
    Cliente.novo(`Comprador Carga ${i}`, { comitente: false, rendaCentavos: 10_000_000_00 }),
  );

  const leiloes: Array<{ id: number }> = [];
  for (let i = 0; i < LEILOES; i++) {
    leiloes.push(await comitente.criarLeilao(antecedencia, duracao, { nome: `Item do teste de carga ${i + 1}`, precoInicialCentavos: 10_00 }));
  }

  // cada comprador abre UM socket e entra em todas as salas
  const salas = await emLotes(COMPRADORES, 20, async (i) => {
    const socket = await compradores[i].conectar();
    const doComprador: Sala[] = [];
    for (const l of leiloes) doComprador.push(await Sala.entrar(socket, l.id));
    return doComprador;
  });

  console.log(`Esperando os leilões abrirem (até ${antecedencia + 10} s)…`);
  await Promise.all(salas[0].map((s) => s.aguardar((e) => e.status === 'EM_ANDAMENTO', (antecedencia + 10) * 1000, 'abrir')));

  // ---- disputa --------------------------------------------------------------
  const latencias: number[] = [];
  const porResultado = new Map<string, number>();
  const aceitos: Aceito[] = [];
  const falhas: string[] = [];
  let enviados = 0;
  let reenviados = 0;
  let semResposta = 0;
  const contar = (resultado: string) => porResultado.set(resultado, (porResultado.get(resultado) ?? 0) + 1);

  const inicio = Date.now();
  const fim = inicio + SEGUNDOS * 1000;

  async function disputar(i: number): Promise<void> {
    await dormir(Math.random() * intervaloMs); // não começam todos no mesmo milissegundo
    while (Date.now() < fim) {
      const sala = salas[i][Math.floor(Math.random() * salas[i].length)];
      const valor = sala.atual.lanceMinimoCentavos;
      if (valor === null) break; // o leilão terminou
      const k = chave();
      const antes = performance.now();
      enviados++;
      try {
        const reenviar = Math.random() * 100 < REENVIOS_POR_CENTO;
        // o reenvio sai junto com o original: os dois disputam a mesma chave no banco
        const [primeira, segunda] = await Promise.all([sala.lance(valor, k), reenviar ? sala.lance(valor, k) : null]);
        latencias.push(performance.now() - antes);
        // qual das duas chegou antes ao banco não importa: vale a que foi aceita, se houver
        const r = segunda?.aceito && !primeira.aceito ? segunda : primeira;
        contar(r.aceito ? 'ACEITO' : r.motivo);
        if (r.aceito) {
          aceitos.push({ leilaoId: sala.leilaoId, usuarioId: compradores[i].usuario.id, sequencia: r.lance.sequencia, valorCentavos: valor });
        }
        if (segunda) {
          reenviados++;
          // RF12: as duas respostas contam a mesma história. A exceção é MUITO_RAPIDO,
          // que não fica gravado na chave (a tentativa nem chegou a ser avaliada).
          const rapido = primeira.motivo === 'MUITO_RAPIDO' || segunda.motivo === 'MUITO_RAPIDO';
          const iguais =
            primeira.aceito === segunda.aceito &&
            (primeira.aceito ? primeira.lance.id === segunda.lance.id : primeira.motivo === segunda.motivo);
          if (!iguais && !rapido) {
            falhas.push(`RF12: reenvio com resposta diferente da original (${JSON.stringify(primeira)} x ${JSON.stringify(segunda)})`);
          }
        }
      } catch {
        semResposta++;
      }
      // respeita o limite de frequência (RF13), com folga aleatória
      await dormir(intervaloMs + 20 + Math.random() * intervaloMs);
    }
  }

  console.log('Disputa em andamento…');
  await Promise.all(compradores.map((_, i) => disputar(i)));
  const duracaoReal = (Date.now() - inicio) / 1000;
  await dormir(1000); // últimas fotografias chegarem às salas

  // ---- conferência ----------------------------------------------------------
  const temBanco = Boolean(process.env.DATABASE_URL_SISTEMA);
  for (const l of leiloes) {
    const daqui = aceitos.filter((a) => a.leilaoId === l.id).sort((a, b) => a.sequencia - b.sequencia);
    const detalhe = (await comitente.req('GET', `/api/leiloes/${l.id}`)).corpo.leilao;
    const total: number = detalhe.totalLances ?? detalhe.estado?.totalLances;
    const preco: number | null = detalhe.precoAtualCentavos ?? detalhe.estado?.precoAtualCentavos ?? null;

    if (total !== daqui.length) falhas.push(`leilão ${l.id}: ${daqui.length} lances confirmados aos clientes, ${total} no sistema`);
    if (daqui.length && preco !== daqui[daqui.length - 1].valorCentavos) {
      falhas.push(`leilão ${l.id}: preço atual ${preco} difere do último lance confirmado ${daqui[daqui.length - 1].valorCentavos}`);
    }
    daqui.forEach((a, i) => {
      if (a.sequencia !== i + 1) falhas.push(`leilão ${l.id}: sequência ${a.sequencia} na posição ${i + 1} (duplicada ou pulada)`);
      const anterior = daqui[i - 1];
      const minimo = lanceMinimo({ totalLances: i, precoInicialCentavos: 10_00, precoAtualCentavos: anterior?.valorCentavos ?? null });
      if (a.valorCentavos < minimo) falhas.push(`leilão ${l.id}: lance ${a.sequencia} de ${a.valorCentavos} abaixo do mínimo ${minimo} (RF11)`);
      if (anterior && anterior.usuarioId === a.usuarioId) falhas.push(`leilão ${l.id}: o líder cobriu o próprio lance na sequência ${a.sequencia}`);
    });

    if (temBanco) {
      const { rows } = await banco.query(
        'SELECT sequencia, valor_centavos, usuario_id FROM lances WHERE leilao_id = $1 ORDER BY sequencia',
        [l.id],
      );
      if (rows.length !== daqui.length) falhas.push(`leilão ${l.id}: ${rows.length} lances no banco, ${daqui.length} confirmados`);
      rows.forEach((r, i) => {
        const a = daqui[i];
        if (!a || a.sequencia !== r.sequencia || a.valorCentavos !== r.valor_centavos || a.usuarioId !== r.usuario_id) {
          falhas.push(`leilão ${l.id}: o lance ${r.sequencia} gravado não bate com o confirmado ao cliente`);
        }
      });
    }

    // todas as salas terminaram vendo o mesmo estado
    const versoes = new Set(salas.map((s) => s.find((x) => x.leilaoId === l.id)!.atual.versao));
    if (versoes.size !== 1) falhas.push(`leilão ${l.id}: as salas terminaram em versões diferentes (${[...versoes].join(', ')})`);

    console.log(`  leilão ${l.id}: ${daqui.length} lances aceitos, de ${reais(10_00)} a ${preco === null ? '—' : reais(preco)}`);
  }

  // ---- relatório ------------------------------------------------------------
  latencias.sort((a, b) => a - b);
  const totalAceitos = porResultado.get('ACEITO') ?? 0;
  console.log('\n== Resultado');
  console.log(`Lances enviados:      ${enviados} (+ ${reenviados} reenvios da mesma chave)`);
  console.log(`Vazão:                ${((enviados + reenviados) / duracaoReal).toFixed(1)} lances/s processados, ${(totalAceitos / duracaoReal).toFixed(1)} aceitos/s`);
  console.log(`Latência (ms):        p50 ${percentil(latencias, 50).toFixed(0)} · p95 ${percentil(latencias, 95).toFixed(0)} · p99 ${percentil(latencias, 99).toFixed(0)} · máx ${(latencias[latencias.length - 1] ?? 0).toFixed(0)}`);
  console.log('Por resultado:');
  for (const [resultado, n] of [...porResultado.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${resultado.padEnd(28)} ${n}`);
  }
  if (semResposta) console.log(`  ${'(sem resposta em 8 s)'.padEnd(28)} ${semResposta}`);
  if (semResposta) falhas.push(`${semResposta} lances ficaram sem resposta`);
  if (totalAceitos === 0) falhas.push('nenhum lance foi aceito');

  console.log(`\nConferência${temBanco ? ' (clientes x API x banco)' : ' (clientes x API)'}:`);
  if (falhas.length === 0) {
    console.log('  OK — sequências sem buraco nem repetição, todo lance respeitou o mínimo vigente,');
    console.log('       nenhum reenvio virou segundo lance e todas as salas viram o mesmo estado final.');
  } else {
    for (const f of falhas.slice(0, 20)) console.log(`  FALHA — ${f}`);
    if (falhas.length > 20) console.log(`  … e mais ${falhas.length - 20}`);
  }

  for (const c of [comitente, ...compradores]) c.fechar();
  await banco.end();
  return falhas.length === 0 ? 0 : 1;
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((erro) => {
    console.error('[carga] falhou:', erro);
    process.exit(1);
  });
