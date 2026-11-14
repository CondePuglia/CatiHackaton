import pg from 'pg';
import { config } from './config.js';

// BIGINT (ids e centavos) chega do driver como texto. Convertemos para number e
// falhamos alto se passar de 2^53: os limites de valor garantem que nunca passa,
// e assim nenhum centavo é arredondado em silêncio (RF19).
pg.types.setTypeParser(pg.types.builtins.INT8, (valor: string) => {
  const n = Number(valor);
  if (!Number.isSafeInteger(n)) throw new Error(`inteiro fora da faixa segura: ${valor}`);
  return n;
});

function tls(): pg.ClientConfig['ssl'] {
  const modo = config.bancoSsl.toLowerCase();
  if (modo === '' || modo === 'false' || modo === 'nao') return undefined;
  if (modo === 'sem-verificar') return { rejectUnauthorized: false };
  if (modo === 'verificar' || modo === 'true') return true;
  throw new Error(`Variável de ambiente DB_SSL inválida: "${config.bancoSsl}" (use verificar ou sem-verificar)`);
}

/** Como chegar ao banco: vale para o pool e para a conexão de escuta (eventos.ts). */
export const conexaoDoBanco: pg.ClientConfig = {
  connectionString: config.databaseUrl,
  ...(tls() !== undefined ? { ssl: tls() } : {}),
};

export const pool = new pg.Pool({
  ...conexaoDoBanco,
  max: config.conexoesBanco,
});

pool.on('error', (erro) => {
  console.error('[db] erro em conexão ociosa:', erro.message);
});

export type Conexao = pg.Pool | pg.PoolClient;

/** Roda `fn` em uma transação; qualquer exceção desfaz tudo. */
export async function transacao<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const resultado = await fn(c);
    await c.query('COMMIT');
    return resultado;
  } catch (erro) {
    await c.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    c.release();
  }
}

/**
 * RF16: o relógio que vale é um só — o do banco. Com várias instâncias do
 * back-end, cada uma teria o seu; o banco é o único que todas compartilham.
 */
export async function agoraDoBanco(c: Conexao = pool): Promise<Date> {
  const { rows } = await c.query('SELECT clock_timestamp() AS agora');
  return rows[0].agora as Date;
}

/** Espera o banco aceitar conexões (a VM pode subir os contêineres fora de ordem). */
export async function aguardarBanco(tentativas = 60): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (erro) {
      if (i >= tentativas) throw erro;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export const violouUnicidade = (erro: unknown, restricao?: string): boolean => {
  const e = erro as { code?: string; constraint?: string };
  return e?.code === '23505' && (restricao === undefined || e.constraint === restricao);
};
