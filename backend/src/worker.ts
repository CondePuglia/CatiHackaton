import { config } from './config.js';
import { aguardarBanco, pool } from './db.js';
import { migrar } from './migrar.js';
import { apagarPresencasVencidas } from './presenca.js';
import { apagarSessoesExpiradas } from './sessoes.js';
import { rodada } from './transicoes.js';

/**
 * Processo de fundo (RF17/RF18). Em laço: abre o que chegou na hora, fecha o
 * que passou do término, dorme. Não guarda nada em memória, então pode cair e
 * voltar a qualquer momento — e pode haver mais de um rodando ao mesmo tempo.
 */
const registrar = (mensagem: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ hora: new Date().toISOString(), servico: 'worker', mensagem, ...extra }));

let parar = false;
let acordar: (() => void) | null = null;

const dormir = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    acordar = () => {
      clearTimeout(timer);
      resolve();
    };
  });

async function principal(): Promise<void> {
  await aguardarBanco();
  const aplicadas = await migrar();
  if (aplicadas.length) registrar('migrações aplicadas', { aplicadas });
  registrar('worker pronto', { intervaloMs: config.worker.intervaloMs });

  let ultimaFaxina = 0;
  let ultimaRonda = 0;
  while (!parar) {
    const inicio = Date.now();
    try {
      const { abertos, fechados } = await rodada();
      for (const id of abertos) registrar('leilão aberto', { leilaoId: id });
      for (const f of fechados) registrar('leilão fechado', { leilaoId: f.id, status: f.status });

      // RF25 com várias instâncias: quem estava em uma instância que morreu sai da contagem
      if (inicio - ultimaRonda > 10_000) {
        ultimaRonda = inicio;
        const vencidas = await apagarPresencasVencidas();
        if (vencidas) registrar('presenças vencidas apagadas', { salas: vencidas });
      }

      if (inicio - ultimaFaxina > 60_000) {
        ultimaFaxina = inicio;
        const apagadas = await apagarSessoesExpiradas();
        if (apagadas) registrar('sessões expiradas apagadas', { apagadas });
      }
    } catch (erro) {
      // Banco fora do ar, por exemplo: registra e tenta de novo na próxima rodada.
      registrar('rodada falhou', { erro: (erro as Error).message });
    }
    await dormir(Math.max(0, config.worker.intervaloMs - (Date.now() - inicio)));
  }

  await pool.end();
  registrar('worker encerrado');
}

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    parar = true;
    acordar?.();
  });
}

principal().catch((erro) => {
  console.error('[worker] falha fatal:', erro);
  process.exit(1);
});
