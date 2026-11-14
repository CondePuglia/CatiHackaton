import { aguardarArmazenamento } from './armazenamento.js';
import { config } from './config.js';
import { aguardarBanco, pool } from './db.js';
import { escutarEventos } from './eventos.js';
import { criarApp } from './http.js';
import { migrar } from './migrar.js';
import { iniciarTempoReal } from './tempoReal.js';

/**
 * Processo da API: HTTP + tempo real. Não guarda estado de leilão em memória;
 * tudo o que importa está no Postgres. Por isso pode reiniciar a qualquer
 * momento (RF18) e pode haver mais de uma instância rodando.
 */
async function principal(): Promise<void> {
  await aguardarBanco();
  const aplicadas = await migrar();

  const app = await criarApp();
  await app.ready();
  if (aplicadas.length) app.log.info({ aplicadas }, 'migrações aplicadas');

  const tempoReal = iniciarTempoReal(app);
  const escuta = escutarEventos({
    aoReceber: tempoReal.aoEvento,
    aoReconectar: tempoReal.ressincronizar,
  });
  await escuta.pronto;

  // O armazenamento não bloqueia a subida: se demorar, só o upload espera.
  aguardarArmazenamento()
    .then(() =>
      app.log.info(
        {
          modo: config.armazenamento.modo,
          destino: config.armazenamento.modo === 'disco' ? config.armazenamento.pasta : config.armazenamento.bucket,
        },
        'armazenamento de fotos pronto',
      ),
    )
    .catch((erro) => app.log.error({ erro: (erro as Error).message }, 'armazenamento de fotos indisponível'));

  await app.listen({ port: config.porta, host: '0.0.0.0' });

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ sinal }, 'encerrando');
    // quem está nas salas reconecta sozinho assim que a API voltar
    await tempoReal.encerrar().catch(() => {});
    await app.close().catch(() => {});
    await escuta.parar().catch(() => {});
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
