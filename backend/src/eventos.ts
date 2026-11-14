import pg from 'pg';
import { conexaoDoBanco, type Conexao } from './db.js';

/**
 * Barramento de eventos em cima do próprio Postgres (LISTEN/NOTIFY).
 *
 * Quem muda um leilão (lance, worker, cancelamento) publica o evento DENTRO da
 * transação. O Postgres só entrega o NOTIFY quando a transação confirma, e na
 * ordem dos commits. Consequências:
 *  - RF11: a sala só vê o novo estado depois que o lance foi gravado de verdade;
 *  - o worker é outro processo e mesmo assim a sala atualiza na hora;
 *  - com várias instâncias da API, cada uma escuta e avisa os próprios sockets,
 *    sem precisar de Redis.
 */
export const CANAL = 'leilao_eventos';

/** PRESENCA não muda o leilão: só avisa que alguém entrou, saiu ou trocou de papel na sala (RF25). */
export type TipoEvento = 'ABERTO' | 'LANCE' | 'ENCERRADO' | 'CANCELADO' | 'EDITADO' | 'PRESENCA';

export type EventoLeilao = {
  leilaoId: number;
  tipo: TipoEvento;
  /** em LANCE: quem liderava antes, para o aviso de lance superado */
  liderAnteriorId?: number | null;
  valorCentavos?: number;
};

export async function publicar(c: Conexao, evento: EventoLeilao): Promise<void> {
  await c.query('SELECT pg_notify($1, $2)', [CANAL, JSON.stringify(evento)]);
}

type Opcoes = {
  aoReceber: (evento: EventoLeilao) => void;
  /** chamado quando a escuta volta depois de uma queda: eventos podem ter sido perdidos */
  aoReconectar?: () => void;
};

/** Mantém uma conexão dedicada escutando o canal, reconectando sozinha se cair. */
export function escutarEventos(opcoes: Opcoes): { pronto: Promise<void>; parar: () => Promise<void> } {
  let parado = false;
  let atual: pg.Client | null = null;
  let espera: NodeJS.Timeout | null = null;
  let jaConectou = false;
  let avisarPronto: () => void = () => {};
  const pronto = new Promise<void>((resolve) => (avisarPronto = resolve));

  const agendar = () => {
    if (parado || espera) return;
    espera = setTimeout(() => {
      espera = null;
      void conectar();
    }, 1000);
  };

  async function conectar(): Promise<void> {
    if (parado) return;
    const cliente = new pg.Client({ ...conexaoDoBanco, keepAlive: true });
    let morto = false;
    const caiu = (motivo: string) => {
      if (morto) return;
      morto = true;
      if (atual === cliente) atual = null;
      cliente.end().catch(() => {});
      if (!parado) {
        console.warn(`[eventos] escuta caiu (${motivo}); reconectando em 1 s`);
        agendar();
      }
    };
    cliente.on('error', (erro) => caiu(erro.message));
    cliente.on('end', () => caiu('conexão encerrada'));
    cliente.on('notification', (msg) => {
      if (msg.channel !== CANAL || !msg.payload) return;
      try {
        opcoes.aoReceber(JSON.parse(msg.payload) as EventoLeilao);
      } catch (erro) {
        console.error('[eventos] falha ao tratar evento:', erro);
      }
    });
    try {
      await cliente.connect();
      await cliente.query(`LISTEN ${CANAL}`);
      if (parado) {
        await cliente.end().catch(() => {});
        return;
      }
      atual = cliente;
      if (jaConectou) opcoes.aoReconectar?.();
      jaConectou = true;
      avisarPronto();
    } catch (erro) {
      caiu((erro as Error).message);
    }
  }

  void conectar();

  return {
    pronto,
    async parar() {
      parado = true;
      if (espera) clearTimeout(espera);
      await atual?.end().catch(() => {});
    },
  };
}
