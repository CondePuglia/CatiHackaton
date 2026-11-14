import { pool } from './db.js';
import { CANAL } from './eventos.js';
import type { Status } from './regras.js';

/**
 * RF17 / RF18 — abertura e fechamento automáticos.
 *
 * Não há timer guardado em memória: a verdade está no banco. Cada função é UM
 * comando SQL condicional, que:
 *  - só toca leilões cujo horário já passou, pelo relógio do banco;
 *  - é idempotente: rodar de novo não acha mais nada para mudar, então fechar
 *    duas vezes não duplica resultado;
 *  - disputa a mesma trava de linha que o lance. Se um lance está sendo gravado,
 *    o fechamento espera; quando a trava solta, o Postgres reavalia o WHERE com
 *    a linha nova. Se o lance prorrogou o término, o leilão não fecha;
 *  - publica o evento na mesma transação, para a sala atualizar na hora.
 *
 * Depois de um reinício, a primeira rodada simplesmente encontra tudo o que
 * venceu enquanto o sistema estava fora e coloca em dia.
 */

export async function abrirLeiloes(): Promise<number[]> {
  const { rows } = await pool.query(
    `WITH abertos AS (
       UPDATE leiloes
          SET status = 'EM_ANDAMENTO', aberto_em = clock_timestamp(), versao = versao + 1
        WHERE status = 'AGENDADO' AND inicio_em <= clock_timestamp()
    RETURNING id
     )
     SELECT id, pg_notify('${CANAL}', json_build_object('leilaoId', id, 'tipo', 'ABERTO')::text)
       FROM abertos`,
  );
  return rows.map((r) => r.id as number);
}

export async function fecharLeiloes(): Promise<Array<{ id: number; status: Status }>> {
  const { rows } = await pool.query(
    `WITH fechados AS (
       UPDATE leiloes
          SET status = CASE WHEN total_lances > 0 THEN 'VENDIDO' ELSE 'ENCERRADO_SEM_LANCES' END,
              encerrado_em = clock_timestamp(),
              versao = versao + 1
        WHERE status = 'EM_ANDAMENTO' AND termino_em <= clock_timestamp()
    RETURNING id, status
     )
     SELECT id, status, pg_notify('${CANAL}', json_build_object('leilaoId', id, 'tipo', 'ENCERRADO')::text)
       FROM fechados`,
  );
  return rows.map((r) => ({ id: r.id as number, status: r.status as Status }));
}

/** Uma rodada do worker: primeiro abre, depois fecha (um leilão vencido por inteiro faz as duas). */
export async function rodada(): Promise<{ abertos: number[]; fechados: Array<{ id: number; status: Status }> }> {
  const abertos = await abrirLeiloes();
  const fechados = await fecharLeiloes();
  return { abertos, fechados };
}
