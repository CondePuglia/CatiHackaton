import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pool } from './db.js';
import { INSTANCIA, VALIDADE_SEGUNDOS } from './presenca.js';

/**
 * Bônus 7.2 — métricas no formato de texto do Prometheus, em `GET /api/metricas`.
 *
 * Dois tipos de número:
 *  - do PROCESSO (contadores e histogramas em memória): requisições, lances,
 *    sockets, fila do banco. Cada instância tem os seus, e toda série leva o
 *    rótulo `instancia` para dar para somar ou comparar;
 *  - do SISTEMA (lidos do banco na hora da coleta): leilões por estado, lances
 *    gravados, pessoas nas salas e, principalmente, transições atrasadas — se o
 *    worker parar, `leilao_transicoes_atrasadas` sai de zero.
 *
 * Feito à mão para não trazer dependência: são três estruturas e um formatador.
 */

type Rotulos = Record<string, string | number>;

const escapar = (v: string | number): string => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function serie(nome: string, rotulos: Rotulos, valor: number): string {
  const todos = { ...rotulos, instancia: INSTANCIA };
  const pares = Object.entries(todos)
    .map(([k, v]) => `${k}="${escapar(v)}"`)
    .join(',');
  return `${nome}{${pares}} ${Number.isFinite(valor) ? valor : 0}`;
}

const chaveDe = (rotulos: Rotulos): string => JSON.stringify(Object.entries(rotulos).sort(([a], [b]) => a.localeCompare(b)));

interface Metrica {
  renderizar(): string[];
}

const registro: Metrica[] = [];

class Contador implements Metrica {
  private valores = new Map<string, { rotulos: Rotulos; valor: number }>();
  constructor(
    private nome: string,
    private ajuda: string,
  ) {
    registro.push(this);
  }
  somar(rotulos: Rotulos = {}, quanto = 1): void {
    const k = chaveDe(rotulos);
    const atual = this.valores.get(k);
    if (atual) atual.valor += quanto;
    else this.valores.set(k, { rotulos, valor: quanto });
  }
  renderizar(): string[] {
    return [
      `# HELP ${this.nome} ${this.ajuda}`,
      `# TYPE ${this.nome} counter`,
      ...[...this.valores.values()].map((v) => serie(this.nome, v.rotulos, v.valor)),
    ];
  }
}

const FAIXAS_SEGUNDOS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

class Histograma implements Metrica {
  private valores = new Map<string, { rotulos: Rotulos; faixas: number[]; soma: number; total: number }>();
  constructor(
    private nome: string,
    private ajuda: string,
  ) {
    registro.push(this);
  }
  observar(rotulos: Rotulos, segundos: number): void {
    const k = chaveDe(rotulos);
    let v = this.valores.get(k);
    if (!v) this.valores.set(k, (v = { rotulos, faixas: FAIXAS_SEGUNDOS.map(() => 0), soma: 0, total: 0 }));
    for (let i = 0; i < FAIXAS_SEGUNDOS.length; i++) if (segundos <= FAIXAS_SEGUNDOS[i]) v.faixas[i]++;
    v.soma += segundos;
    v.total++;
  }
  renderizar(): string[] {
    const linhas = [`# HELP ${this.nome} ${this.ajuda}`, `# TYPE ${this.nome} histogram`];
    for (const v of this.valores.values()) {
      FAIXAS_SEGUNDOS.forEach((le, i) => linhas.push(serie(`${this.nome}_bucket`, { ...v.rotulos, le }, v.faixas[i])));
      linhas.push(serie(`${this.nome}_bucket`, { ...v.rotulos, le: '+Inf' }, v.total));
      linhas.push(serie(`${this.nome}_sum`, v.rotulos, v.soma));
      linhas.push(serie(`${this.nome}_count`, v.rotulos, v.total));
    }
    return linhas;
  }
}

/** Valor lido na hora da coleta. */
class Medidor implements Metrica {
  constructor(
    private nome: string,
    private ajuda: string,
    private ler: () => Array<{ rotulos?: Rotulos; valor: number }>,
  ) {
    registro.push(this);
  }
  renderizar(): string[] {
    return [
      `# HELP ${this.nome} ${this.ajuda}`,
      `# TYPE ${this.nome} gauge`,
      ...this.ler().map((v) => serie(this.nome, v.rotulos ?? {}, v.valor)),
    ];
  }
}

// ---------------------------------------------------------------------------
// Métricas do processo
// ---------------------------------------------------------------------------

export const httpRequisicoes = new Contador('leilao_http_requisicoes_total', 'Requisições HTTP atendidas, por rota e status.');
export const httpDuracao = new Histograma('leilao_http_duracao_segundos', 'Tempo de resposta das requisições HTTP.');

/** `resultado` é "ACEITO", "REENVIO" ou o motivo da recusa. */
export const lancesProcessados = new Contador('leilao_lances_total', 'Lances recebidos pela sala, por resultado.');
export const lanceDuracao = new Histograma(
  'leilao_lance_duracao_segundos',
  'Tempo entre o lance chegar ao servidor e a resposta sair (inclui a fila do leilão no banco).',
);

export const eventosRecebidos = new Contador('leilao_eventos_recebidos_total', 'Eventos recebidos do barramento (LISTEN/NOTIFY), por tipo.');
export const conexoesTempoReal = new Contador('leilao_sockets_conexoes_total', 'Conexões de tempo real aceitas desde a subida.');

let sockets: () => number = () => 0;
/** A sala informa como contar os sockets abertos nesta instância. */
export function informarSockets(ler: () => number): void {
  sockets = ler;
}

new Medidor('leilao_sockets_conectados', 'Sockets de tempo real abertos nesta instância.', () => [{ valor: sockets() }]);

new Medidor('leilao_db_conexoes', 'Conexões do pool do banco nesta instância.', () => [
  { rotulos: { estado: 'abertas' }, valor: pool.totalCount },
  { rotulos: { estado: 'ociosas' }, valor: pool.idleCount },
  { rotulos: { estado: 'na_fila' }, valor: pool.waitingCount },
]);

const laco = monitorEventLoopDelay({ resolution: 20 });
laco.enable();
new Medidor('leilao_laco_atraso_segundos', 'Atraso do laço de eventos do Node desde a última coleta.', () => {
  const valores = [
    { rotulos: { medida: 'media' }, valor: laco.mean / 1e9 },
    { rotulos: { medida: 'p99' }, valor: laco.percentile(99) / 1e9 },
    { rotulos: { medida: 'maximo' }, valor: laco.max / 1e9 },
  ];
  laco.reset();
  return valores;
});

new Medidor('leilao_processo_memoria_bytes', 'Memória residente do processo.', () => [{ valor: process.memoryUsage().rss }]);
new Medidor('leilao_processo_no_ar_segundos', 'Há quanto tempo esta instância está no ar.', () => [{ valor: process.uptime() }]);

// ---------------------------------------------------------------------------
// Métricas do sistema, lidas do banco
// ---------------------------------------------------------------------------

async function doBanco(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COALESCE(json_object_agg(status, n), '{}'::json)
          FROM (SELECT status, count(*) AS n FROM leiloes GROUP BY status) s) AS por_status,
       (SELECT count(*) FROM lances)::bigint AS lances,
       (SELECT count(*) FROM usuarios)::bigint AS usuarios,
       (SELECT count(*) FROM sessoes WHERE expira_em > clock_timestamp())::bigint AS sessoes,
       (SELECT count(*) FROM leiloes WHERE status = 'AGENDADO' AND inicio_em <= clock_timestamp())::int AS abrir_atrasados,
       (SELECT count(*) FROM leiloes WHERE status = 'EM_ANDAMENTO' AND termino_em <= clock_timestamp())::int AS fechar_atrasados,
       (SELECT COALESCE(EXTRACT(EPOCH FROM max(clock_timestamp() - quando)), 0)
          FROM (SELECT inicio_em AS quando FROM leiloes WHERE status = 'AGENDADO' AND inicio_em <= clock_timestamp()
                UNION ALL
                SELECT termino_em FROM leiloes WHERE status = 'EM_ANDAMENTO' AND termino_em <= clock_timestamp()) a
       )::float8 AS maior_atraso,
       (SELECT count(DISTINCT usuario_id) FROM presencas
         WHERE visto_em > clock_timestamp() - make_interval(secs => $1))::int AS pessoas_nas_salas,
       (SELECT count(DISTINCT instancia) FROM presencas
         WHERE visto_em > clock_timestamp() - make_interval(secs => $1))::int AS instancias_com_salas`,
    [VALIDADE_SEGUNDOS],
  );
  const r = rows[0];
  const medidor = (nome: string, ajuda: string, valores: Array<{ rotulos?: Rotulos; valor: number }>) => [
    `# HELP ${nome} ${ajuda}`,
    `# TYPE ${nome} gauge`,
    ...valores.map((v) => serie(nome, v.rotulos ?? {}, v.valor)),
  ];
  const porStatus = r.por_status as Record<string, number>;
  return [
    ...medidor(
      'leilao_leiloes',
      'Leilões por estado (lido do banco).',
      ['AGENDADO', 'EM_ANDAMENTO', 'VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO'].map((status) => ({
        rotulos: { status },
        valor: porStatus[status] ?? 0,
      })),
    ),
    ...medidor('leilao_lances_gravados', 'Total de lances aceitos gravados no banco.', [{ valor: r.lances }]),
    ...medidor('leilao_usuarios', 'Contas cadastradas.', [{ valor: r.usuarios }]),
    ...medidor('leilao_sessoes_ativas', 'Sessões ainda válidas.', [{ valor: r.sessoes }]),
    ...medidor('leilao_transicoes_atrasadas', 'Leilões que já deveriam ter aberto ou fechado. Fica em zero com o worker em dia.', [
      { rotulos: { tipo: 'abrir' }, valor: r.abrir_atrasados },
      { rotulos: { tipo: 'fechar' }, valor: r.fechar_atrasados },
    ]),
    ...medidor('leilao_transicao_maior_atraso_segundos', 'Há quanto tempo a transição mais atrasada espera pelo worker.', [
      { valor: r.maior_atraso },
    ]),
    ...medidor('leilao_pessoas_nas_salas', 'Pessoas distintas em alguma sala, somando todas as instâncias.', [
      { valor: r.pessoas_nas_salas },
    ]),
    ...medidor('leilao_instancias_com_salas', 'Instâncias da API que têm alguém em sala agora.', [
      { valor: r.instancias_com_salas },
    ]),
  ];
}

export const TIPO_DO_CONTEUDO = 'text/plain; version=0.0.4; charset=utf-8';

export async function renderizarMetricas(): Promise<string> {
  const linhas = registro.flatMap((m) => m.renderizar());
  try {
    linhas.push(...(await doBanco()));
    linhas.push(serie('leilao_banco_no_ar', {}, 1));
  } catch {
    // banco fora do ar: as métricas do processo continuam saindo
    linhas.push(serie('leilao_banco_no_ar', {}, 0));
  }
  return linhas.join('\n') + '\n';
}
