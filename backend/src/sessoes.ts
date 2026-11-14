import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';

export type Usuario = {
  id: number;
  nome: string;
  email: string;
  criadoEm: Date;
};

const hashDoToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * RF02 — sessão guardada no banco (decisão da equipe):
 *  - o cookie leva um token aleatório de 256 bits; o banco guarda só o SHA-256 dele;
 *  - vale em qualquer instância do back-end e sobrevive a reinício;
 *  - dá para encerrar no servidor (logout de verdade), o que um JWT puro não dá.
 */
export async function criarSessao(usuarioId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessoes (token_hash, usuario_id, expira_em)
     VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3))`,
    [hashDoToken(token), usuarioId, config.sessao.inatividadeSegundos],
  );
  return token;
}

/**
 * Valida e renova em um único comando: a sessão expira após N segundos sem uso
 * e cada uso empurra o prazo, até o teto absoluto contado da criação.
 * Devolve null se o token não existe ou já expirou.
 */
export async function usarSessao(token: string | null | undefined): Promise<Usuario | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await pool.query(
    `UPDATE sessoes s
        SET expira_em = LEAST(
              clock_timestamp() + make_interval(secs => $2),
              s.criada_em + make_interval(secs => $3))
       FROM usuarios u
      WHERE s.token_hash = $1
        AND s.expira_em > clock_timestamp()
        AND u.id = s.usuario_id
  RETURNING u.id, u.nome, u.email, u.criado_em`,
    [hashDoToken(token), config.sessao.inatividadeSegundos, config.sessao.maximoSegundos],
  );
  const r = rows[0];
  return r ? { id: r.id, nome: r.nome, email: r.email, criadoEm: r.criado_em } : null;
}

export async function encerrarSessao(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await pool.query('DELETE FROM sessoes WHERE token_hash = $1', [hashDoToken(token)]);
}

/** Faxina periódica feita pelo worker. */
export async function apagarSessoesExpiradas(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM sessoes WHERE expira_em < clock_timestamp() - interval '1 hour'`,
  );
  return rowCount ?? 0;
}
