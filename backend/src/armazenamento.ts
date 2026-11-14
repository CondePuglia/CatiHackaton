import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { config } from './config.js';

/**
 * RF07 — as fotos ficam no serviço de armazenamento em nuvem, nunca no banco
 * nem no disco da VM. Este é o único arquivo que conhece o serviço: hoje fala
 * o protocolo S3 (AWS S3, MinIO, R2...). Se a organização entregar outro
 * serviço, troca-se a implementação destas três funções e nada mais.
 */
const a = config.armazenamento;

const s3 = new S3Client({
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

export async function salvarObjeto(chave: string, dados: Buffer, tipo: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: a.bucket,
      Key: chave,
      Body: dados,
      ContentType: tipo,
      ContentLength: dados.length,
    }),
  );
}

/** Abre o objeto como fluxo: os bytes passam pela VM, mas nunca são gravados nela. */
export async function abrirObjeto(chave: string): Promise<{ fluxo: Readable; tamanho?: number }> {
  const resposta = await s3.send(new GetObjectCommand({ Bucket: a.bucket, Key: chave }));
  return { fluxo: resposta.Body as Readable, tamanho: resposta.ContentLength };
}

/** No ambiente local (MinIO) o bucket é criado sozinho; na nuvem ele já existe. */
export async function garantirBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: a.bucket }));
  } catch (erro) {
    if (!a.criarBucket) throw erro;
    await s3.send(new CreateBucketCommand({ Bucket: a.bucket })).catch((e: { name?: string }) => {
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
