import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const pasta = await mkdtemp(path.join(tmpdir(), 'leilao-fotos-'));
process.env.ARMAZENAMENTO = 'disco';
process.env.PASTA_FOTOS = pasta;

const { abrirObjeto, garantirBucket, salvarObjeto } = await import('../../src/armazenamento.js');

after(() => rm(pasta, { recursive: true, force: true }));

test('modo disco grava o arquivo na pasta e o devolve como fluxo', async () => {
  await garantirBucket();
  const dados = Buffer.from('conteudo-da-foto');
  await salvarObjeto('fotos/teste.png', dados, 'image/png');

  assert.deepEqual(await readFile(path.join(pasta, 'fotos', 'teste.png')), dados);

  const objeto = await abrirObjeto('fotos/teste.png');
  const partes: Buffer[] = [];
  for await (const parte of objeto.fluxo) partes.push(parte as Buffer);
  assert.deepEqual(Buffer.concat(partes), dados);
  assert.equal(objeto.tamanho, dados.length);
});

test('modo disco recusa chave que tenta sair da pasta', async () => {
  await assert.rejects(
    () => salvarObjeto('../fora.png', Buffer.from('x'), 'image/png'),
    /Chave de armazenamento inválida/,
  );
});
