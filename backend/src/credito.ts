import { pool, type Conexao } from './db.js';
import { pontuacao } from './regras.js';

/**
 * Bônus (RF29–RF32): pontuação, habilitação de comitente e crédito.
 *
 * Tudo deriva dos dados já gravados — não existe tabela de reserva. O limite é
 * `renda mensal × 6 × pontuação ÷ 100`; a reserva é a soma dos preços atuais
 * dos leilões EM_ANDAMENTO em que o usuário é líder. Ser superado (perde a
 * liderança) ou o leilão terminar libera a reserva sozinho; vencer vira
 * histórico de compras, que alimenta a pontuação.
 */

/** RF30: a partir de quantos pontos o usuário pode se habilitar a vender. */
export const PONTUACAO_MINIMA_COMITENTE = 50;

export type ResumoDeCredito = {
  rendaMensalCentavos: number;
  diasDeConta: number;
  compras: number;
  totalCompradoCentavos: number;
  pontuacao: number;
  limiteCentavos: number;
  reservadoCentavos: number;
  disponivelCentavos: number;
};

/**
 * Lê, em um único comando, tudo o que define a pontuação e o crédito de um
 * usuário. `conexao` permite reusar a conexão (e a trava) de uma transação.
 */
export async function resumoDeCredito(usuarioId: number, conexao: Conexao = pool): Promise<ResumoDeCredito> {
  const { rows } = await conexao.query(
    `SELECT u.renda_mensal_centavos, u.criado_em,
            clock_timestamp() AS agora,
            COALESCE((SELECT count(*) FROM leiloes l WHERE l.lider_id = u.id AND l.status = 'VENDIDO'), 0)::bigint AS compras,
            COALESCE((SELECT sum(l.preco_atual_centavos) FROM leiloes l
                       WHERE l.lider_id = u.id AND l.status = 'VENDIDO'), 0)::bigint AS total_comprado_centavos,
            COALESCE((SELECT sum(l.preco_atual_centavos) FROM leiloes l
                       WHERE l.lider_id = u.id AND l.status = 'EM_ANDAMENTO'), 0)::bigint AS reservado_centavos
       FROM usuarios u WHERE u.id = $1`,
    [usuarioId],
  );
  const r = rows[0];
  if (!r) throw new Error('usuário inexistente ao calcular crédito');

  const renda = r.renda_mensal_centavos ?? 0;
  const dias = Math.max(0, Math.floor((r.agora.getTime() - r.criado_em.getTime()) / 86_400_000));
  const score = pontuacao({
    rendaCentavos: renda,
    diasDeConta: dias,
    compras: r.compras,
    totalCompradoCentavos: r.total_comprado_centavos,
  });
  const limite = Math.floor((renda * 6 * score) / 100);
  const reservado = r.reservado_centavos;
  return {
    rendaMensalCentavos: renda,
    diasDeConta: dias,
    compras: r.compras,
    totalCompradoCentavos: r.total_comprado_centavos,
    pontuacao: score,
    limiteCentavos: limite,
    reservadoCentavos: reservado,
    disponivelCentavos: Math.max(0, limite - reservado),
  };
}

export type Compra = { leilaoId: number; itemNome: string; valorCentavos: number; em: string };

/**
 * RF31: o histórico de compras (leilões vencidos, que alimentam a pontuação) e
 * as reservas em vigor (leilões em andamento que o usuário lidera agora).
 */
export async function minhasCompras(
  usuarioId: number,
): Promise<{ compras: Compra[]; reservas: Compra[]; totalCompradoCentavos: number; reservadoCentavos: number }> {
  const { rows } = await pool.query(
    `SELECT l.id, i.nome, l.status, l.preco_atual_centavos,
            COALESCE(l.encerrado_em, (SELECT max(criado_em) FROM lances WHERE leilao_id = l.id)) AS em
       FROM leiloes l JOIN itens i ON i.id = l.item_id
      WHERE l.lider_id = $1 AND l.status IN ('VENDIDO', 'EM_ANDAMENTO')
      ORDER BY em DESC NULLS LAST, l.id DESC`,
    [usuarioId],
  );
  const compras: Compra[] = [];
  const reservas: Compra[] = [];
  for (const r of rows) {
    (r.status === 'VENDIDO' ? compras : reservas).push({
      leilaoId: r.id,
      itemNome: r.nome,
      valorCentavos: r.preco_atual_centavos,
      em: (r.em as Date).toISOString(),
    });
  }
  const soma = (lista: Compra[]) => lista.reduce((total, c) => total + c.valorCentavos, 0);
  return { compras, reservas, totalCompradoCentavos: soma(compras), reservadoCentavos: soma(reservas) };
}

export async function pontuacaoDoUsuario(usuarioId: number): Promise<number> {
  return (await resumoDeCredito(usuarioId)).pontuacao;
}

/**
 * RF30: habilita o usuário como comitente quando a pontuação permite. Sem
 * aprovação manual. Se já estava habilitado, devolve o registro existente.
 */
export async function habilitarComitente(
  usuarioId: number,
): Promise<{ habilitado: boolean; pontuacao: number; comitenteDesde: string | null }> {
  const score = await pontuacaoDoUsuario(usuarioId);
  if (score < PONTUACAO_MINIMA_COMITENTE) {
    return { habilitado: false, pontuacao: score, comitenteDesde: null };
  }
  const { rows } = await pool.query(
    `UPDATE usuarios SET comitente_desde = COALESCE(comitente_desde, clock_timestamp())
      WHERE id = $1 RETURNING comitente_desde`,
    [usuarioId],
  );
  return { habilitado: true, pontuacao: score, comitenteDesde: rows[0].comitente_desde.toISOString() };
}
