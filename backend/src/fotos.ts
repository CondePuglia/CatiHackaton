import { randomUUID } from 'node:crypto';
import { abrirObjeto, salvarObjeto } from './armazenamento.js';
import { config } from './config.js';
import { pool } from './db.js';
import { ErroApp, naoEncontrado } from './erros.js';
import type { Usuario } from './sessoes.js';

type TipoImagem = { mime: string; extensao: string };

/**
 * RF07: valida pelo conteúdo, não pelo nome nem pelo Content-Type que o
 * navegador declara. Um .exe renomeado para .png não passa.
 */
export function detectarImagem(dados: Buffer): TipoImagem | null {
  if (dados.length >= 3 && dados[0] === 0xff && dados[1] === 0xd8 && dados[2] === 0xff) {
    return { mime: 'image/jpeg', extensao: 'jpg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (dados.length >= 8 && png.every((b, i) => dados[i] === b)) {
    return { mime: 'image/png', extensao: 'png' };
  }
  if (
    dados.length >= 12 &&
    dados.subarray(0, 4).toString('latin1') === 'RIFF' &&
    dados.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { mime: 'image/webp', extensao: 'webp' };
  }
  return null;
}

export const urlDaFoto = (id: number): string => `/api/fotos/${id}`;

/** Recebe os bytes em memória, valida e manda direto para o bucket. */
export async function enviarFoto(dono: Usuario, dados: Buffer): Promise<{ id: number; url: string }> {
  const limite = config.limites.fotos.tamanhoMaxBytes;
  if (dados.length === 0) {
    throw new ErroApp(400, 'ARQUIVO_VAZIO', 'O arquivo enviado está vazio.');
  }
  if (dados.length > limite) {
    throw new ErroApp(413, 'ARQUIVO_GRANDE', `Cada foto pode ter no máximo ${Math.floor(limite / 1024 / 1024)} MB.`);
  }
  const tipo = detectarImagem(dados);
  if (!tipo) {
    throw new ErroApp(415, 'TIPO_NAO_ACEITO', 'Envie fotos em JPEG, PNG ou WebP.');
  }

  const chave = `${config.armazenamento.prefixo}/${randomUUID()}.${tipo.extensao}`;
  await salvarObjeto(chave, dados, tipo.mime);

  const { rows } = await pool.query(
    `INSERT INTO fotos (dono_id, chave, tipo, tamanho_bytes) VALUES ($1, $2, $3, $4) RETURNING id`,
    [dono.id, chave, tipo.mime, dados.length],
  );
  const id = rows[0].id as number;
  return { id, url: urlDaFoto(id) };
}

export async function abrirFoto(id: number) {
  const { rows } = await pool.query('SELECT chave, tipo FROM fotos WHERE id = $1', [id]);
  if (!rows[0]) throw naoEncontrado('Foto');
  try {
    const objeto = await abrirObjeto(rows[0].chave);
    return { ...objeto, tipo: rows[0].tipo as string };
  } catch (erro) {
    const { name, code } = erro as { name?: string; code?: string };
    if (name === 'NoSuchKey' || name === 'NotFound' || code === 'ENOENT') throw naoEncontrado('Foto');
    throw erro;
  }
}
