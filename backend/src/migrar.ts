import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const PASTA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TRAVA = 20261114;

/**
 * Aplica, em ordem, os arquivos .sql ainda não aplicados. A trava consultiva
 * deixa API e worker subirem juntos sem aplicar a mesma migração duas vezes.
 */
export async function migrar(): Promise<string[]> {
  const c = await pool.connect();
  const aplicadas: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock($1)', [TRAVA]);
    await c.query(`CREATE TABLE IF NOT EXISTS migracoes (
      nome TEXT PRIMARY KEY,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
    const { rows } = await c.query('SELECT nome FROM migracoes');
    const feitas = new Set(rows.map((r) => r.nome as string));
    const arquivos = (await readdir(PASTA)).filter((f) => f.endsWith('.sql')).sort();

    for (const arquivo of arquivos) {
      if (feitas.has(arquivo)) continue;
      const sql = await readFile(path.join(PASTA, arquivo), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO migracoes (nome) VALUES ($1)', [arquivo]);
        await c.query('COMMIT');
      } catch (erro) {
        await c.query('ROLLBACK').catch(() => {});
        throw new Error(`migração ${arquivo} falhou: ${(erro as Error).message}`);
      }
      aplicadas.push(arquivo);
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => {});
    c.release();
  }
  return aplicadas;
}
