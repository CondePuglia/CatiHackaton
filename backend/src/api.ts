import { aguardarArmazenamento } from './armazenamento.js';
import { config } from './config.js';
import { aguardarBanco, pool } from './db.js';
import { criarApp } from './http.js';
import { migrar } from './migrar.js';

/**
 * Processo da API. Não guarda estado de leilão em memória; tudo o que importa
 * está no Postgres. Por isso pode reiniciar a qualquer momento (RF18).
 *
 * Nesta etapa (Núcleo · Parte 1) serve só HTTP. A sala em tempo real, por onde
 * entram os lances, é a Parte 2.
 */
async function principal(): Promise<void> {
  await aguardarBanco();
  const aplicadas = await migrar();

  const app = await criarApp();
  await app.ready();
  if (aplicadas.length) app.log.info({ aplicadas }, 'migrações aplicadas');

  // O bucket não bloqueia a subida: se o armazenamento demorar, só o upload espera.
  aguardarArmazenamento()
    .then(() => app.log.info({ bucket: config.armazenamento.bucket }, 'armazenamento de fotos pronto'))
    .catch((erro) => app.log.error({ erro: (erro as Error).message }, 'armazenamento de fotos indisponível'));

  await app.listen({ port: config.porta, host: '0.0.0.0' });

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ sinal }, 'encerrando');
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

principal().catch((erro) => {
  console.error('[api] falha fatal ao subir:', erro);
  process.exit(1);
});
