import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { config } from './config.js';

/**
 * RF07 — as fotos ficam no destino escolhido por ARMAZENAMENTO, nunca no banco.
 * Este é o único arquivo que conhece o armazenamento:
 *
 *   - `s3` (padrão): bucket compatível com S3 (AWS S3, MinIO, R2...).
 *   - `disco`: pasta no servidor, normalmente montada pelo Compose.
 *
 * Se a organização entregar outro serviço, troca-se a implementação destas
 * três funções e nada mais.
 */
const a = config.armazenamento;
const modoDisco = a.modo === 'disco';
const raiz = path.resolve(a.pasta);

let clienteS3: S3Client | undefined;

function s3(): S3Client {
  clienteS3 ??= new S3Client({
    region: a.regiao,
    ...(a.endpoint ? { endpoint: a.endpoint } : {}),
    forcePathStyle: a.estiloCaminho,
    // Sem chaves no ambiente, o SDK usa a cadeia padrão (ex.: perfil da instância EC2).
    ...(a.chaveAcesso && a.chaveSecreta
      ? {
          credentials: {
            accessKeyId: a.chaveAcesso,
            secretAccessKey: a.chaveSecreta,
            ...(a.tokenSessao ? { sessionToken: a.tokenSessao } : {}),
          },
        }
      : {}),
    // Só calcula checksum extra quando o serviço exige: mantém compatibilidade
    // com implementações de S3 que não aceitam os cabeçalhos novos.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return clienteS3;
}

/** Resolve a chave dentro da pasta, recusando qualquer caminho que escape dela. */
function caminhoDaChave(chave: string): string {
  const caminho = path.resolve(raiz, chave);
  const prefixo = raiz.endsWith(path.sep) ? raiz : raiz + path.sep;
  if (!caminho.startsWith(prefixo)) {
    throw new Error(`Chave de armazenamento inválida: "${chave}"`);
  }
  return caminho;
}

export async function salvarObjeto(chave: string, dados: Buffer, tipo: string): Promise<void> {
  if (modoDisco) {
    const caminho = caminhoDaChave(chave);
    await mkdir(path.dirname(caminho), { recursive: true });
    await writeFile(caminho, dados);
    return;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: a.bucket,
      Key: chave,
      Body: dados,
      ContentType: tipo,
      ContentLength: dados.length,
    }),
  );
}

/** Abre o objeto como fluxo. No modo `disco`, lê direto da pasta. */
export async function abrirObjeto(chave: string): Promise<{ fluxo: Readable; tamanho?: number }> {
  if (modoDisco) {
    const caminho = caminhoDaChave(chave);
    const info = await stat(caminho);
    return { fluxo: createReadStream(caminho), tamanho: info.size };
  }
  const resposta = await s3().send(new GetObjectCommand({ Bucket: a.bucket, Key: chave }));
  return { fluxo: resposta.Body as Readable, tamanho: resposta.ContentLength };
}

/** No modo `disco` garante a pasta; no S3 local (MinIO) cria o bucket. */
export async function garantirBucket(): Promise<void> {
  if (modoDisco) {
    await mkdir(raiz, { recursive: true });
    return;
  }
  try {
    await s3().send(new HeadBucketCommand({ Bucket: a.bucket }));
  } catch (erro) {
    if (!a.criarBucket) throw erro;
    await s3().send(new CreateBucketCommand({ Bucket: a.bucket })).catch((e: { name?: string }) => {
      // outra instância pode ter criado no mesmo instante
      if (e?.name !== 'BucketAlreadyOwnedByYou' && e?.name !== 'BucketAlreadyExists') throw e;
    });
  }
}

export async function aguardarArmazenamento(tentativas = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await garantirBucket();
      return;
    } catch (erro) {
      if (i >= tentativas) throw erro;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
