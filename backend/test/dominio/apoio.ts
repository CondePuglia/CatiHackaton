import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { garantirBucket } from '../../src/armazenamento.js';
import { pool } from '../../src/db.js';
import { enviarFoto } from '../../src/fotos.js';
import { criarLeilao } from '../../src/leiloes.js';
import { migrar } from '../../src/migrar.js';
import { gerarPng } from '../../src/png.js';
import type { Usuario } from '../../src/sessoes.js';
import { abrirLeiloes } from '../../src/transicoes.js';
import { cadastrar } from '../../src/usuarios.js';

/**
 * Apoio dos testes de domínio. Eles rodam dentro do processo (sem servidor HTTP
 * de verdade e sem worker), contra um Postgres real e um bucket real, e
 * controlam o tempo mexendo nos horários direto no banco.
 */

const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalido/invalido');
const banco = url.pathname.slice(1);

export async function preparar(): Promise<void> {
  if (!banco.endsWith('_teste')) {
    throw new Error(`Estes testes apagam dados: o banco precisa terminar em "_teste" (recebi "${banco}").`);
  }
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const existe = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [banco]);
    if (existe.rowCount === 0) await c.query(`CREATE DATABASE "${banco}"`);
  } finally {
    await c.end();
  }
  await migrar();
  await pool.query(
    `TRUNCATE usuarios, sessoes, itens, fotos, leiloes, lances, apelidos, tentativas_lance
     RESTART IDENTITY CASCADE`,
  );
  await garantirBucket();
}

export async function encerrar(): Promise<void> {
  await pool.end();
}

let contador = 0;
export const SENHA = 'senha-de-teste';

export async function novoUsuario(nome = 'Pessoa', rendaCentavos = 100_000_00): Promise<Usuario> {
  contador++;
  return cadastrar({
    nome: `${nome} ${contador}`,
    email: `u${contador}-${randomUUID()}@teste.dev`,
    senha: SENHA,
    rendaMensalCentavos: rendaCentavos,
  });
}

/** RF30: habilita um usuário como comitente (direto no banco, para os testes). */
export async function habilitarComitente(usuario: Usuario): Promise<void> {
  await pool.query(
    `UPDATE usuarios SET comitente_desde = COALESCE(comitente_desde, clock_timestamp()) WHERE id = $1`,
    [usuario.id],
  );
  usuario.comitenteDesde = new Date();
}

export const pngValido = (): Buffer => gerarPng(8, 8, (x, y) => [x * 30, y * 30, 120]);

export async function novasFotos(dono: Usuario, quantidade = 3): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < quantidade; i++) ids.push((await enviarFoto(dono, pngValido())).id);
  return ids;
}

export const emSegundos = (s: number): string => new Date(Date.now() + s * 1000).toISOString();

export async function dadosDeLeilao(comitente: Usuario, extras: Record<string, unknown> = {}) {
  return {
    nome: 'Bicicleta de estrada',
    descricao: 'Bicicleta de estrada em ótimo estado, pouco usada.',
    categoria: 'esportes',
    fotoIds: await novasFotos(comitente),
    precoInicialCentavos: 100_00,
    inicioEm: emSegundos(3600),
    duracaoSegundos: 3600,
    ...extras,
  };
}

export async function novoLeilao(comitente: Usuario, extras: Record<string, unknown> = {}): Promise<number> {
  await habilitarComitente(comitente);
  return criarLeilao(comitente, await dadosDeLeilao(comitente, extras));
}

/** Faz o horário de início "chegar" e roda a abertura, como o worker faria. */
export async function abrirAgora(leilaoId: number, duracaoSegundos = 3600): Promise<void> {
  await pool.query(
    `UPDATE leiloes
        SET inicio_em = clock_timestamp() - interval '1 second',
            termino_original_em = clock_timestamp() + make_interval(secs => $2),
            termino_em = clock_timestamp() + make_interval(secs => $2)
      WHERE id = $1`,
    [leilaoId, duracaoSegundos],
  );
  await abrirLeiloes();
}

export async function novoLeilaoAberto(
  comitente: Usuario,
  extras: Record<string, unknown> = {},
  duracaoSegundos = 3600,
): Promise<number> {
  const id = await novoLeilao(comitente, extras);
  await abrirAgora(id, duracaoSegundos);
  return id;
}

/**
 * Reposiciona os términos em relação a agora (segundos; negativo = já passou).
 * `original` é o término agendado; `atual` é o vigente, já com prorrogações.
 */
export async function definirTerminos(leilaoId: number, original: number, atual = original): Promise<void> {
  await pool.query(
    `UPDATE leiloes
        SET inicio_em = LEAST(inicio_em, clock_timestamp() + make_interval(secs => $2) - interval '1 hour'),
            termino_original_em = clock_timestamp() + make_interval(secs => $2),
            termino_em = clock_timestamp() + make_interval(secs => $3)
      WHERE id = $1`,
    [leilaoId, original, atual],
  );
}

export async function linha(leilaoId: number) {
  const { rows } = await pool.query('SELECT * FROM leiloes WHERE id = $1', [leilaoId]);
  return rows[0];
}

export async function lancesDe(leilaoId: number) {
  const { rows } = await pool.query(
    'SELECT id, usuario_id, valor_centavos, sequencia, criado_em FROM lances WHERE leilao_id = $1 ORDER BY sequencia',
    [leilaoId],
  );
  return rows as Array<{ id: number; usuario_id: number; valor_centavos: number; sequencia: number; criado_em: Date }>;
}

export const chave = (): string => randomUUID();

export const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Corpo multipart com um arquivo, para testar o upload pelo HTTP. */
export function multipart(dados: Buffer, nomeArquivo = 'foto.png', tipo = 'image/png', campo = 'arquivo') {
  const limite = `----teste${randomUUID()}`;
  const corpo = Buffer.concat([
    Buffer.from(
      `--${limite}\r\nContent-Disposition: form-data; name="${campo}"; filename="${nomeArquivo}"\r\n` +
        `Content-Type: ${tipo}\r\n\r\n`,
    ),
    dados,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);
  return { payload: corpo, headers: { 'content-type': `multipart/form-data; boundary=${limite}` } };
}
