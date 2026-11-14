import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { CANAL } from './eventos.js';

/**
 * RF25 com várias instâncias da API: quem está em cada sala fica no banco, não
 * na memória de um processo. Toda mudança publica o evento PRESENCA no mesmo
 * comando SQL; cada instância recebe o evento, relê a contagem e avisa os
 * próprios sockets. Assim a contagem é a mesma para todos, não importa em qual
 * instância cada pessoa caiu.
 *
 * Instância que morre sem se despedir: as linhas dela param de ser renovadas e,
 * passado `VALIDADE_SEGUNDOS`, deixam de contar; o worker apaga e avisa as salas.
 */

/** Identifica este processo. Muda a cada subida. */
export const INSTANCIA = `${process.env.HOSTNAME ?? 'local'}-${randomUUID().slice(0, 8)}`;

export const BATIMENTO_MS = 10_000;
export const VALIDADE_SEGUNDOS = 30;

export type PapelNaSala = 'PARTICIPANTE' | 'ESPECTADOR' | 'COMITENTE';
export type Presenca = { leilaoId: number; participantes: number; espectadores: number };

const AVISO = `pg_notify('${CANAL}', json_build_object('leilaoId', leilao_id, 'tipo', 'PRESENCA')::text)`;

/** Entrou na sala ou trocou de papel. */
export async function marcarPresenca(
  socketId: string,
  leilaoId: number,
  usuarioId: number,
  papel: PapelNaSala,
): Promise<void> {
  await pool.query(
    `WITH gravada AS (
       INSERT INTO presencas (socket_id, leilao_id, usuario_id, instancia, papel)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (socket_id, leilao_id)
       DO UPDATE SET papel = EXCLUDED.papel, instancia = EXCLUDED.instancia, visto_em = clock_timestamp()
       RETURNING leilao_id
     )
     SELECT ${AVISO} FROM gravada`,
    [socketId, leilaoId, usuarioId, INSTANCIA, papel],
  );
}

/** Saiu de uma sala (`leilaoId`) ou caiu a conexão (todas as salas do socket). */
export async function removerPresenca(socketId: string, leilaoId?: number): Promise<void> {
  await pool.query(
    `WITH apagadas AS (
       DELETE FROM presencas
        WHERE socket_id = $1 AND ($2::bigint IS NULL OR leilao_id = $2)
       RETURNING leilao_id
     )
     SELECT ${AVISO} FROM (SELECT DISTINCT leilao_id FROM apagadas) a`,
    [socketId, leilaoId ?? null],
  );
}

/**
 * Quantas PESSOAS (não abas) há na sala, por papel. Quem tem uma aba como
 * participante e outra como espectador conta como participante. O comitente
 * conta como espectador.
 */
export async function contarPresenca(leilaoId: number): Promise<Presenca> {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE participa)::int AS participantes,
            count(*) FILTER (WHERE NOT participa)::int AS espectadores
       FROM (SELECT bool_or(papel = 'PARTICIPANTE') AS participa
               FROM presencas
              WHERE leilao_id = $1
                AND visto_em > clock_timestamp() - make_interval(secs => $2)
              GROUP BY usuario_id) p`,
    [leilaoId, VALIDADE_SEGUNDOS],
  );
  return { leilaoId, participantes: rows[0].participantes, espectadores: rows[0].espectadores };
}

/** Batimento: esta instância continua viva e os sockets ainda conectados nela continuam contando. */
export async function renovarPresencas(socketsVivos: string[]): Promise<void> {
  if (socketsVivos.length === 0) return;
  await pool.query(
    'UPDATE presencas SET visto_em = clock_timestamp() WHERE instancia = $1 AND socket_id = ANY($2::text[])',
    [INSTANCIA, socketsVivos],
  );
}

/** Desligamento limpo: tira da contagem todo mundo que estava nesta instância. */
export async function removerPresencasDaInstancia(): Promise<void> {
  await pool.query(
    `WITH apagadas AS (DELETE FROM presencas WHERE instancia = $1 RETURNING leilao_id)
     SELECT ${AVISO} FROM (SELECT DISTINCT leilao_id FROM apagadas) a`,
    [INSTANCIA],
  );
}

/** Worker: apaga o que ficou para trás de instâncias que morreram. */
export async function apagarPresencasVencidas(): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH apagadas AS (
       DELETE FROM presencas
        WHERE visto_em <= clock_timestamp() - make_interval(secs => $1)
       RETURNING leilao_id
     )
     SELECT ${AVISO} FROM (SELECT DISTINCT leilao_id FROM apagadas) a`,
    [VALIDADE_SEGUNDOS],
  );
  return rowCount ?? 0;
}
