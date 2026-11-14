import type pg from 'pg';
import { CATEGORIAS, config } from './config.js';
import { agoraDoBanco, pool, transacao } from './db.js';
import { ErroApp, conflito, naoEncontrado, proibido } from './erros.js';
import { publicar } from './eventos.js';
import { urlDaFoto } from './fotos.js';
import { STATUS_ATIVOS, apelido, lanceMinimo, modoDeEdicao, podeCancelar, type Status } from './regras.js';
import type { Usuario } from './sessoes.js';
import { Validador, idPositivo, objeto } from './validacao.js';

// ---------------------------------------------------------------------------
// Texto de apoio para mensagens de validação
// ---------------------------------------------------------------------------

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const reais = (centavos: number): string => moeda.format(centavos / 100).replace(/ /g, ' ');

export function duracaoLegivel(segundos: number): string {
  const unidades: Array<[number, string, string]> = [
    [86400, 'dia', 'dias'],
    [3600, 'hora', 'horas'],
    [60, 'minuto', 'minutos'],
    [1, 'segundo', 'segundos'],
  ];
  for (const [tamanho, singular, plural] of unidades) {
    if (segundos >= tamanho && segundos % tamanho === 0) {
      const n = segundos / tamanho;
      return `${n} ${n === 1 ? singular : plural}`;
    }
  }
  return `${segundos} segundos`;
}

const nomeDaCategoria = (id: string): string => CATEGORIAS.find((c) => c.id === id)?.nome ?? id;

// ---------------------------------------------------------------------------
// Validação (RF05)
// ---------------------------------------------------------------------------

export type DadosItem = { nome: string; descricao: string; categoria: string; fotoIds: number[] };
export type DadosVenda = { precoInicialCentavos: number; inicioEm: Date; duracaoSegundos: number };

export function validarItem(dados: Record<string, unknown>, v: Validador): DadosItem {
  const lim = config.limites;
  const nome = v.texto(dados.nome, 'nome', lim.nomeItem, 'o nome do item');
  const descricao = v.texto(dados.descricao, 'descricao', lim.descricao, 'a descrição');

  const categoria = typeof dados.categoria === 'string' ? dados.categoria : '';
  if (!CATEGORIAS.some((c) => c.id === categoria)) {
    v.erro('categoria', 'Escolha uma categoria da lista.');
  }

  const fotoIds: number[] = [];
  if (!Array.isArray(dados.fotoIds)) {
    v.erro('fotos', `Envie de ${lim.fotos.min} a ${lim.fotos.max} fotos.`);
  } else {
    for (const bruto of dados.fotoIds) {
      const id = idPositivo(bruto);
      if (id === null) v.erro('fotos', 'Lista de fotos inválida.');
      else if (!fotoIds.includes(id)) fotoIds.push(id);
    }
    if (fotoIds.length < lim.fotos.min || fotoIds.length > lim.fotos.max) {
      v.erro('fotos', `Envie de ${lim.fotos.min} a ${lim.fotos.max} fotos.`);
    }
  }
  return { nome, descricao, categoria, fotoIds };
}

export function validarVenda(dados: Record<string, unknown>, v: Validador, agora: Date): DadosVenda {
  const lim = config.limites;
  const precoInicialCentavos = v.inteiro(
    dados.precoInicialCentavos,
    'precoInicialCentavos',
    lim.precoInicialCentavos,
    `O preço inicial deve ficar entre ${reais(lim.precoInicialCentavos.min)} e ${reais(lim.precoInicialCentavos.max)}.`,
  );

  const inicioEm = v.data(dados.inicioEm, 'inicioEm', 'Informe a data e a hora de início.');
  if (!Number.isNaN(inicioEm.getTime())) {
    // RF16: a antecedência é medida contra o relógio do servidor, não o do navegador.
    const antecedencia = (inicioEm.getTime() - agora.getTime()) / 1000;
    if (antecedencia < lim.antecedenciaSegundos.min) {
      v.erro('inicioEm', `O início precisa ser pelo menos ${duracaoLegivel(lim.antecedenciaSegundos.min)} à frente.`);
    } else if (antecedencia > lim.antecedenciaSegundos.max) {
      v.erro('inicioEm', `O início pode ser no máximo ${duracaoLegivel(lim.antecedenciaSegundos.max)} à frente.`);
    }
  }

  const duracaoSegundos = v.inteiro(
    dados.duracaoSegundos,
    'duracaoSegundos',
    lim.duracaoSegundos,
    `A duração deve ficar entre ${duracaoLegivel(lim.duracaoSegundos.min)} e ${duracaoLegivel(lim.duracaoSegundos.max)}.`,
  );
  return { precoInicialCentavos, inicioEm, duracaoSegundos };
}

/** As fotos precisam ter sido enviadas por quem cria o leilão e estar livres (ou já ser deste item). */
export async function reservarFotos(
  c: pg.PoolClient,
  usuarioId: number,
  fotoIds: number[],
  itemId: number | null,
): Promise<void> {
  const { rows } = await c.query(
    `SELECT id FROM fotos
      WHERE id = ANY($1::bigint[]) AND dono_id = $2 AND (item_id IS NULL OR item_id = $3::bigint)
        FOR UPDATE`,
    [fotoIds, usuarioId, itemId],
  );
  if (rows.length !== fotoIds.length) {
    throw new ErroApp(422, 'VALIDACAO', 'Revise os campos destacados.', {
      fotos: 'Alguma foto não foi encontrada. Envie as fotos de novo.',
    });
  }
}

export async function anexarFotos(c: pg.PoolClient, itemId: number, fotoIds: number[]): Promise<void> {
  await c.query('UPDATE fotos SET item_id = NULL WHERE item_id = $1 AND NOT (id = ANY($2::bigint[]))', [
    itemId,
    fotoIds,
  ]);
  await c.query(
    `UPDATE fotos f SET item_id = $1, ordem = x.ordem
       FROM unnest($2::bigint[]) WITH ORDINALITY AS x(id, ordem)
      WHERE f.id = x.id`,
    [itemId, fotoIds],
  );
}

export async function inserirLeilao(
  c: pg.PoolClient,
  itemId: number,
  comitenteId: number,
  venda: DadosVenda,
): Promise<number> {
  const termino = new Date(venda.inicioEm.getTime() + venda.duracaoSegundos * 1000);
  const { rows } = await c.query(
    `INSERT INTO leiloes (item_id, comitente_id, preco_inicial_centavos, inicio_em, termino_original_em, termino_em)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [itemId, comitenteId, venda.precoInicialCentavos, venda.inicioEm, termino],
  );
  return rows[0].id as number;
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

/** RF05: cria o item e o primeiro leilão dele. */
export async function criarLeilao(usuario: Usuario, corpo: unknown): Promise<number> {
  const dados = objeto(corpo);
  const agora = await agoraDoBanco();
  const v = new Validador();
  const item = validarItem(dados, v);
  const venda = validarVenda(dados, v, agora);
  v.verificar();

  return transacao(async (c) => {
    await reservarFotos(c, usuario.id, item.fotoIds, null);
    const { rows } = await c.query(
      `INSERT INTO itens (comitente_id, nome, descricao, categoria) VALUES ($1, $2, $3, $4) RETURNING id`,
      [usuario.id, item.nome, item.descricao, item.categoria],
    );
    const itemId = rows[0].id as number;
    await anexarFotos(c, itemId, item.fotoIds);
    return inserirLeilao(c, itemId, usuario.id, venda);
  });
}

/**
 * RF08: o comitente cancela enquanto Agendado ou Em andamento sem lances.
 * A linha é travada antes da checagem, então um primeiro lance simultâneo e o
 * cancelamento nunca valem os dois. Nada é apagado: o leilão vira CANCELADO.
 */
export async function cancelarLeilao(usuario: Usuario, leilaoId: number): Promise<void> {
  await transacao(async (c) => {
    const { rows } = await c.query(
      `SELECT comitente_id, status, total_lances, inicio_em, termino_em
         FROM leiloes WHERE id = $1 FOR UPDATE`,
      [leilaoId],
    );
    const l = rows[0];
    if (!l) throw naoEncontrado('Leilão');
    if (l.comitente_id !== usuario.id) throw proibido('Só o comitente pode cancelar este leilão.');

    const agora = await agoraDoBanco(c);
    const permitido = podeCancelar(
      { status: l.status, totalLances: l.total_lances, inicioEm: l.inicio_em, terminoEm: l.termino_em },
      agora,
    );
    if (!permitido) {
      throw conflito(
        'CANCELAMENTO_NAO_PERMITIDO',
        l.total_lances > 0
          ? 'Um leilão com lances não pode ser cancelado.'
          : 'Este leilão já terminou e não pode ser cancelado.',
      );
    }
    await c.query(
      `UPDATE leiloes SET status = 'CANCELADO', encerrado_em = $2, versao = versao + 1 WHERE id = $1`,
      [leilaoId, agora],
    );
    await publicar(c, { leilaoId, tipo: 'CANCELADO' });
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

type LinhaLeilao = {
  status: Status;
  total_lances: number;
  preco_inicial_centavos: number;
  preco_atual_centavos: number | null;
};

/** Lance mínimo exibido: só existe enquanto o leilão ainda pode receber lances. */
function minimoExibido(l: LinhaLeilao): number | null {
  if (!STATUS_ATIVOS.includes(l.status)) return null;
  return lanceMinimo({
    totalLances: l.total_lances,
    precoInicialCentavos: l.preco_inicial_centavos,
    precoAtualCentavos: l.preco_atual_centavos,
  });
}

export type FiltrosListagem = {
  status?: Status[];
  pagina?: number;
  categoria?: string;
  comitenteId?: number;
  q?: string;
};

/** Monta o WHERE da listagem. O Nível 2 acrescenta a busca por nome aqui. */
function montarFiltro(f: FiltrosListagem): { onde: string; parametros: unknown[] } {
  const parametros: unknown[] = [f.status?.length ? f.status : STATUS_ATIVOS];
  const onde = ['l.status = ANY($1::text[])'];
  if (f.categoria) {
    parametros.push(f.categoria);
    onde.push(`i.categoria = $${parametros.length}`);
  }
  if (f.comitenteId) {
    parametros.push(f.comitenteId);
    onde.push(`l.comitente_id = $${parametros.length}`);
  }
  const termo = f.q?.normalize('NFC').trim();
  if (termo) {
    // RF21: trecho do nome, sem diferenciar maiúsculas nem acentos
    parametros.push(`%${termo.replace(/[\\%_]/g, '\\$&')}%`);
    onde.push(`unaccent(i.nome) ILIKE unaccent($${parametros.length})`);
  }
  return { onde: onde.join(' AND '), parametros };
}

/**
 * RF20: listagem pública. Ordem: em andamento primeiro (o que termina antes
 * vem antes), depois agendados (o que começa antes vem antes), depois
 * encerrados (mais recentes antes). Paginada para aguentar muitos leilões.
 */
export async function listarLeiloes(f: FiltrosListagem) {
  const { onde, parametros } = montarFiltro(f);
  const porPagina = config.listagem.porPagina;
  const pagina = Math.max(1, Math.floor(f.pagina ?? 1));

  const contagem = await pool.query(
    `SELECT count(*) AS total, clock_timestamp() AS agora
       FROM leiloes l JOIN itens i ON i.id = l.item_id
      WHERE ${onde}`,
    parametros,
  );

  const { rows } = await pool.query(
    `SELECT l.id, l.status, l.preco_inicial_centavos, l.preco_atual_centavos, l.total_lances,
            l.inicio_em, l.termino_em, l.termino_original_em, l.encerrado_em,
            i.id AS item_id, i.nome, i.categoria,
            u.id AS comitente_id, u.nome AS comitente_nome,
            (SELECT f.id FROM fotos f WHERE f.item_id = i.id ORDER BY f.ordem, f.id LIMIT 1) AS foto_id
       FROM leiloes l
       JOIN itens i ON i.id = l.item_id
       JOIN usuarios u ON u.id = l.comitente_id
      WHERE ${onde}
      ORDER BY CASE l.status WHEN 'EM_ANDAMENTO' THEN 0 WHEN 'AGENDADO' THEN 1 ELSE 2 END,
               CASE l.status WHEN 'EM_ANDAMENTO' THEN l.termino_em WHEN 'AGENDADO' THEN l.inicio_em END ASC NULLS LAST,
               l.encerrado_em DESC NULLS LAST,
               l.id DESC
      LIMIT $${parametros.length + 1} OFFSET $${parametros.length + 2}`,
    [...parametros, porPagina, (pagina - 1) * porPagina],
  );

  return {
    leiloes: rows.map((r) => ({
      id: r.id as number,
      status: r.status as Status,
      item: {
        id: r.item_id as number,
        nome: r.nome as string,
        categoria: r.categoria as string,
        categoriaNome: nomeDaCategoria(r.categoria),
        fotoUrl: r.foto_id ? urlDaFoto(r.foto_id) : null,
      },
      comitente: { id: r.comitente_id as number, nome: r.comitente_nome as string },
      precoInicialCentavos: r.preco_inicial_centavos as number,
      precoAtualCentavos: r.preco_atual_centavos as number | null,
      lanceMinimoCentavos: minimoExibido(r),
      totalLances: r.total_lances as number,
      inicioEm: iso(r.inicio_em)!,
      terminoEm: iso(r.termino_em)!,
      prorrogado: r.termino_em.getTime() > r.termino_original_em.getTime(),
      encerradoEm: iso(r.encerrado_em),
    })),
    pagina,
    porPagina,
    total: contagem.rows[0].total as number,
    agora: iso(contagem.rows[0].agora)!,
  };
}

export type Resultado =
  | { tipo: 'VENDIDO'; vencedor: { numero: number; apelido: string }; valorCentavos: number }
  | { tipo: 'ENCERRADO_SEM_LANCES' }
  | { tipo: 'CANCELADO' }
  | null;

function montarResultado(r: {
  status: Status;
  lider_numero: number | null;
  preco_atual_centavos: number | null;
}): Resultado {
  if (r.status === 'VENDIDO') {
    return {
      tipo: 'VENDIDO',
      vencedor: { numero: r.lider_numero!, apelido: apelido(r.lider_numero!) },
      valorCentavos: r.preco_atual_centavos!,
    };
  }
  if (r.status === 'ENCERRADO_SEM_LANCES') return { tipo: 'ENCERRADO_SEM_LANCES' };
  if (r.status === 'CANCELADO') return { tipo: 'CANCELADO' };
  return null;
}

/** Detalhe público do leilão; `eu` só vem para quem está logado. */
export async function detalharLeilao(id: number, usuario: Usuario | null) {
  const { rows } = await pool.query(
    `SELECT l.*, i.nome, i.descricao, i.categoria,
            u.nome AS comitente_nome, u.criado_em AS comitente_desde,
            v.nome AS lider_nome,
            clock_timestamp() AS agora,
            (SELECT a.numero FROM apelidos a WHERE a.leilao_id = l.id AND a.usuario_id = l.lider_id) AS lider_numero,
            (SELECT a.numero FROM apelidos a WHERE a.leilao_id = l.id AND a.usuario_id = $2::bigint) AS meu_numero,
            (SELECT COALESCE(json_agg(f.id ORDER BY f.ordem, f.id), '[]'::json)
               FROM fotos f WHERE f.item_id = l.item_id) AS foto_ids
       FROM leiloes l
       JOIN itens i ON i.id = l.item_id
       JOIN usuarios u ON u.id = l.comitente_id
       LEFT JOIN usuarios v ON v.id = l.lider_id
      WHERE l.id = $1`,
    [id, usuario?.id ?? null],
  );
  const r = rows[0];
  if (!r) throw naoEncontrado('Leilão');

  const souComitente = usuario?.id === r.comitente_id;
  const souLider = usuario !== null && usuario.id === r.lider_id;

  return {
    id: r.id as number,
    status: r.status as Status,
    versao: r.versao as number,
    item: {
      id: r.item_id as number,
      nome: r.nome as string,
      descricao: r.descricao as string,
      categoria: r.categoria as string,
      categoriaNome: nomeDaCategoria(r.categoria),
      fotos: (r.foto_ids as number[]).map((fotoId) => ({ id: fotoId, url: urlDaFoto(fotoId) })),
    },
    comitente: { id: r.comitente_id as number, nome: r.comitente_nome as string, desde: iso(r.comitente_desde)! },
    precoInicialCentavos: r.preco_inicial_centavos as number,
    precoAtualCentavos: r.preco_atual_centavos as number | null,
    lanceMinimoCentavos: minimoExibido(r),
    totalLances: r.total_lances as number,
    inicioEm: iso(r.inicio_em)!,
    terminoEm: iso(r.termino_em)!,
    terminoOriginalEm: iso(r.termino_original_em)!,
    prorrogado: r.termino_em.getTime() > r.termino_original_em.getTime(),
    abertoEm: iso(r.aberto_em),
    encerradoEm: iso(r.encerrado_em),
    criadoEm: iso(r.criado_em)!,
    lider: r.lider_numero ? { numero: r.lider_numero as number, apelido: apelido(r.lider_numero) } : null,
    resultado: montarResultado(r),
    agora: iso(r.agora)!,
    eu: usuario
      ? {
          souComitente,
          souLider,
          numero: (r.meu_numero as number | null) ?? null,
          venci: r.status === 'VENDIDO' && souLider,
          podeCancelar:
            souComitente &&
            podeCancelar(
              { status: r.status, totalLances: r.total_lances, inicioEm: r.inicio_em, terminoEm: r.termino_em },
              r.agora,
            ),
          // RF23: o que o comitente ainda pode mudar agora
          edicao: souComitente
            ? modoDeEdicao(
                { status: r.status, totalLances: r.total_lances, inicioEm: r.inicio_em, terminoEm: r.termino_em },
                r.agora,
                config.edicao.bloqueioSegundos,
              )
            : 'NADA',
          podeRelistar: souComitente && (r.status === 'ENCERRADO_SEM_LANCES' || r.status === 'CANCELADO'),
          // Só o comitente fica sabendo quem comprou, e só depois de vendido.
          vencedorNome: souComitente && r.status === 'VENDIDO' ? (r.lider_nome as string) : null,
        }
      : null,
  };
}

export type EstadoSala = {
  leilaoId: number;
  versao: number;
  status: Status;
  agora: string;
  inicioEm: string;
  terminoEm: string;
  terminoOriginalEm: string;
  prorrogado: boolean;
  encerradoEm: string | null;
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  lanceMinimoCentavos: number | null;
  totalLances: number;
  lider: { numero: number; apelido: string } | null;
  ultimosLances: Array<{ sequencia: number; numero: number; apelido: string; valorCentavos: number; em: string }>;
  resultado: Resultado;
};

/**
 * RF09: fotografia completa da sala, lida em um único comando SQL para que
 * preço, líder e lista de lances sejam sempre do mesmo instante. É o que cada
 * pessoa recebe ao entrar, ao reconectar e a cada mudança.
 */
export async function estadoDaSala(leilaoId: number): Promise<EstadoSala | null> {
  const { rows } = await pool.query(
    `SELECT l.id, l.versao, l.status, l.inicio_em, l.termino_em, l.termino_original_em, l.encerrado_em,
            l.preco_inicial_centavos, l.preco_atual_centavos, l.total_lances,
            clock_timestamp() AS agora,
            (SELECT a.numero FROM apelidos a WHERE a.leilao_id = l.id AND a.usuario_id = l.lider_id) AS lider_numero,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'sequencia', x.sequencia, 'numero', x.numero,
                       'valorCentavos', x.valor_centavos, 'em', x.criado_em)
                     ORDER BY x.sequencia DESC)
                FROM (
                  SELECT la.sequencia, la.valor_centavos, la.criado_em, a.numero
                    FROM lances la
                    JOIN apelidos a ON a.leilao_id = la.leilao_id AND a.usuario_id = la.usuario_id
                   WHERE la.leilao_id = l.id
                   ORDER BY la.sequencia DESC
                   LIMIT $2
                ) x
            ), '[]'::json) AS ultimos_lances
       FROM leiloes l
      WHERE l.id = $1`,
    [leilaoId, config.lances.recentes],
  );
  const r = rows[0];
  if (!r) return null;

  type LanceBruto = { sequencia: number; numero: number; valorCentavos: number; em: string };
  return {
    leilaoId: r.id,
    versao: r.versao,
    status: r.status,
    agora: iso(r.agora)!,
    inicioEm: iso(r.inicio_em)!,
    terminoEm: iso(r.termino_em)!,
    terminoOriginalEm: iso(r.termino_original_em)!,
    prorrogado: r.termino_em.getTime() > r.termino_original_em.getTime(),
    encerradoEm: iso(r.encerrado_em),
    precoInicialCentavos: r.preco_inicial_centavos,
    precoAtualCentavos: r.preco_atual_centavos,
    lanceMinimoCentavos: minimoExibido(r),
    totalLances: r.total_lances,
    lider: r.lider_numero ? { numero: r.lider_numero, apelido: apelido(r.lider_numero) } : null,
    ultimosLances: (r.ultimos_lances as LanceBruto[]).map((l) => ({
      sequencia: l.sequencia,
      numero: l.numero,
      apelido: apelido(l.numero),
      valorCentavos: l.valorCentavos,
      em: new Date(l.em).toISOString(),
    })),
    resultado: montarResultado(r),
  };
}

/** O que a sala precisa saber sobre a relação entre uma pessoa e um leilão. */
export async function vinculoComLeilao(
  leilaoId: number,
  usuarioId: number,
): Promise<{ existe: boolean; souComitente: boolean; numero: number | null }> {
  const { rows } = await pool.query(
    `SELECT l.comitente_id,
            (SELECT a.numero FROM apelidos a WHERE a.leilao_id = l.id AND a.usuario_id = $2) AS numero
       FROM leiloes l WHERE l.id = $1`,
    [leilaoId, usuarioId],
  );
  const r = rows[0];
  if (!r) return { existe: false, souComitente: false, numero: null };
  return { existe: true, souComitente: r.comitente_id === usuarioId, numero: r.numero ?? null };
}
