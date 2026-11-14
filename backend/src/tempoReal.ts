import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { config } from './config.js';
import { resumoDeCredito } from './credito.js';
import type { EventoLeilao } from './eventos.js';
import { CHAVE_VALIDA, MENSAGENS, darLance, lanceMinimoVigente, recusa, type ResultadoLance } from './lances.js';
import { pool } from './db.js';
import { estadoDaSala, vinculoComLeilao } from './leiloes.js';
import { conexoesTempoReal, eventosRecebidos, informarSockets, lanceDuracao, lancesProcessados } from './metricas.js';
import {
  BATIMENTO_MS,
  contarPresenca,
  marcarPresenca,
  removerPresenca,
  removerPresencasDaInstancia,
  renovarPresencas,
} from './presenca.js';
import { usarSessao, type Usuario } from './sessoes.js';
import { idPositivo } from './validacao.js';

/**
 * Sala em tempo real (RF09).
 *
 * Canal: Socket.IO (WebSocket com queda para long-polling), na mesma origem do
 * site. Decisão da equipe: ele já traz salas, confirmação de entrega (ack) e
 * reconexão automática, que são exatamente as três coisas que o leilão precisa.
 *
 * Regras deste arquivo:
 *  - só conecta quem tem sessão válida (RF04: entrar na sala exige login);
 *  - o lance SÓ existe por este canal, vindo de um socket que entrou na sala:
 *    é assim que "o autor está na sala do leilão" (RF10) é verificado no servidor;
 *  - cada lance revalida a sessão no banco (RF02);
 *  - a sala nunca recebe estado calculado em memória: recebe a fotografia lida
 *    do banco depois do commit (RF11);
 *  - quem está em cada sala também fica no banco (presenca.ts), para a contagem
 *    do RF25 valer com várias instâncias da API.
 */

/**
 * RF25: PARTICIPANTE pode dar lance; ESPECTADOR só assiste e pode virar
 * participante sem sair da sala; COMITENTE é sempre espectador do próprio leilão.
 */
export type Papel = 'PARTICIPANTE' | 'ESPECTADOR' | 'COMITENTE';

type DadosDoSocket = {
  usuario: Usuario;
  token: string;
  /** salas em que este socket entrou, e com que papel */
  salas: Map<number, Papel>;
};

type SocketDaSala = Socket<any, any, any, DadosDoSocket>;
type Responder = (resposta: unknown) => void;

const salaDoLeilao = (leilaoId: number): string => `leilao:${leilaoId}`;
const salaDoUsuario = (usuarioId: number): string => `usuario:${usuarioId}`;

const falha = (codigo: string, mensagem: string) => ({ ok: false as const, erro: { codigo, mensagem } });

export function iniciarTempoReal(app: FastifyInstance) {
  const io = new Server<any, any, any, DadosDoSocket>(app.server, {
    serveClient: false,
    // detecta conexão morta em ~15 s, para a tela avisar e reconectar logo
    pingInterval: 10_000,
    pingTimeout: 5_000,
    maxHttpBufferSize: 16 * 1024,
  });

  // ---- entrada: só com sessão válida --------------------------------------
  io.use(async (socket, next) => {
    try {
      const cookies = app.parseCookie(socket.handshake.headers.cookie ?? '');
      const token = cookies[config.sessao.cookie];
      const usuario = await usarSessao(token);
      if (!usuario || !token) return next(new Error('NAO_AUTENTICADO'));
      socket.data.usuario = usuario;
      socket.data.token = token;
      socket.data.salas = new Map();
      next();
    } catch (erro) {
      app.log.error(erro);
      next(new Error('ERRO_INTERNO'));
    }
  });

  /** Sessão conferida de novo, no banco, a cada ação. */
  async function sessaoValida(socket: SocketDaSala): Promise<boolean> {
    return (await usarSessao(socket.data.token)) !== null;
  }

  /** Quem perdeu a sessão recebe a resposta e só depois é desligado. */
  const desligar = (socket: SocketDaSala) => setTimeout(() => socket.disconnect(true), 100);

  let encerrando = false;
  informarSockets(() => io.sockets.sockets.size);

  /**
   * RF25: a presença é gravada no banco e o banco avisa TODAS as instâncias
   * (evento PRESENCA); cada uma relê a contagem e avisa os próprios sockets.
   * Se a pessoa desligou enquanto a gravação estava a caminho, desfaz.
   */
  async function registrarPresenca(socket: SocketDaSala, leilaoId: number, papel: Papel): Promise<void> {
    await marcarPresenca(socket.id, leilaoId, socket.data.usuario.id, papel);
    if (!socket.connected) await removerPresenca(socket.id);
  }

  // Batimento: só renova quem ainda está conectado AQUI. Uma linha que sobrou
  // de um socket que já caiu envelhece e sai da contagem sozinha.
  const batimento = setInterval(() => {
    renovarPresencas([...io.sockets.sockets.keys()]).catch((erro) =>
      app.log.error({ erro: (erro as Error).message }, 'falha ao renovar presenças'),
    );
  }, BATIMENTO_MS);
  batimento.unref();

  io.on('connection', (socket: SocketDaSala) => {
    const { usuario } = socket.data;
    conexoesTempoReal.somar();

    // caiu ou fechou a aba: sai da contagem de todas as salas em que estava
    socket.on('disconnecting', () => {
      if (encerrando || socket.data.salas.size === 0) return;
      removerPresenca(socket.id).catch((erro) =>
        app.log.error({ erro: (erro as Error).message }, 'falha ao remover presença'),
      );
    });
    void socket.join(salaDoUsuario(usuario.id));

    const tratar =
      (nome: string, fn: (dados: any, responder: Responder) => Promise<void>) =>
      (dados: unknown, ack: unknown) => {
        const responder: Responder = typeof ack === 'function' ? (ack as Responder) : () => {};
        fn(dados ?? {}, responder).catch((erro) => {
          app.log.error({ erro, evento: nome }, 'falha em evento da sala');
          responder(falha('ERRO_INTERNO', 'Algo deu errado do nosso lado. Tente de novo.'));
        });
      };

    // ---- entrar na sala ---------------------------------------------------
    socket.on(
      'sala:entrar',
      tratar('sala:entrar', async (dados, responder) => {
        const leilaoId = idPositivo(dados.leilaoId);
        if (leilaoId === null) return responder(falha('NAO_ENCONTRADO', 'Leilão não encontrado.'));
        if (!(await sessaoValida(socket))) {
          responder(falha('SESSAO_EXPIRADA', MENSAGENS.SESSAO_EXPIRADA));
          desligar(socket);
          return;
        }
        const vinculo = await vinculoComLeilao(leilaoId, usuario.id);
        if (!vinculo.existe) return responder(falha('NAO_ENCONTRADO', 'Leilão não encontrado.'));

        // Entra antes de ler o estado: nenhuma mudança cai no vão entre a
        // fotografia e a inscrição. Se chegar uma em dobro, a versão desempata.
        await socket.join(salaDoLeilao(leilaoId));
        const estado = await estadoDaSala(leilaoId);
        if (!estado) return responder(falha('NAO_ENCONTRADO', 'Leilão não encontrado.'));

        // RF32: só participa quem tem crédito para cobrir o lance mínimo atual;
        // os demais entram como espectadores. O comitente nunca é espectador.
        // RF25: com crédito, a pessoa ainda pode escolher só assistir.
        let papel: Papel;
        let aviso: string | undefined;
        if (vinculo.souComitente) {
          papel = 'COMITENTE';
        } else if (
          estado.status === 'EM_ANDAMENTO' &&
          estado.lanceMinimoCentavos !== null &&
          (await resumoDeCredito(usuario.id)).disponivelCentavos < estado.lanceMinimoCentavos
        ) {
          papel = 'ESPECTADOR';
          aviso = 'Seu crédito disponível é menor que o lance mínimo deste leilão. Você está apenas assistindo.';
        } else {
          papel = dados.papel === 'ESPECTADOR' ? 'ESPECTADOR' : 'PARTICIPANTE';
        }
        socket.data.salas.set(leilaoId, papel);
        await registrarPresenca(socket, leilaoId, papel);

        responder({
          ok: true,
          estado,
          eu: { papel, numero: vinculo.numero, ...(aviso ? { aviso } : {}) },
          presenca: await contarPresenca(leilaoId),
        });
      }),
    );

    // ---- RF25: trocar de papel sem sair da sala -----------------------------
    socket.on(
      'sala:papel',
      tratar('sala:papel', async (dados, responder) => {
        const leilaoId = idPositivo(dados.leilaoId);
        const atual = leilaoId === null ? undefined : socket.data.salas.get(leilaoId);
        if (leilaoId === null || !atual) return responder(falha('FORA_DA_SALA', MENSAGENS.FORA_DA_SALA));
        if (atual === 'COMITENTE') {
          return responder(falha('COMITENTE_NAO_PODE_DAR_LANCE', MENSAGENS.COMITENTE_NAO_PODE_DAR_LANCE));
        }
        if (dados.papel !== 'PARTICIPANTE' && dados.papel !== 'ESPECTADOR') {
          return responder(falha('DADOS_INVALIDOS', 'Papel inválido.'));
        }
        // RF32: não dá para virar participante sem crédito para o lance mínimo atual.
        if (dados.papel === 'PARTICIPANTE') {
          const minimo = await lanceMinimoVigente(leilaoId);
          if (minimo !== null && (await resumoDeCredito(usuario.id)).disponivelCentavos < minimo) {
            return responder(falha('CREDITO_INSUFICIENTE', MENSAGENS.CREDITO_INSUFICIENTE));
          }
        }
        socket.data.salas.set(leilaoId, dados.papel);
        await registrarPresenca(socket, leilaoId, dados.papel);
        responder({ ok: true, eu: { papel: dados.papel } });
      }),
    );

    socket.on(
      'sala:sair',
      tratar('sala:sair', async (dados, responder) => {
        const leilaoId = idPositivo(dados.leilaoId);
        if (leilaoId !== null) {
          socket.data.salas.delete(leilaoId);
          await socket.leave(salaDoLeilao(leilaoId));
          await removerPresenca(socket.id, leilaoId);
        }
        responder({ ok: true });
      }),
    );

    // ---- lance (RF10) -------------------------------------------------------
    socket.on('lance:enviar', (dados: any, ack: unknown) => {
      const chegou = process.hrtime.bigint();
      const devolver: Responder = typeof ack === 'function' ? (ack as Responder) : () => {};
      // Toda resposta de lance passa por aqui: conta, mede e registra (Bônus 7.2).
      const responder = (resposta: ResultadoLance | Record<string, unknown>): void => {
        const r = resposta as { aceito?: boolean; reenvio?: boolean; motivo?: string };
        const segundos = Number(process.hrtime.bigint() - chegou) / 1e9;
        const resultado = r.reenvio ? 'REENVIO' : r.aceito ? 'ACEITO' : String(r.motivo);
        lancesProcessados.somar({ resultado });
        lanceDuracao.observar({ aceito: r.aceito ? 'sim' : 'nao' }, segundos);
        app.log.info(
          {
            leilaoId: idPositivo(dados?.leilaoId),
            usuarioId: usuario.id,
            valorCentavos: typeof dados?.valorCentavos === 'number' ? dados.valorCentavos : null,
            resultado,
            ms: Math.round(segundos * 1000),
          },
          'lance',
        );
        devolver(resposta);
      };

      (async () => {
        const leilaoId = idPositivo(dados?.leilaoId);
        const valorCentavos = dados?.valorCentavos;
        const chave = dados?.chave;
        if (
          leilaoId === null ||
          typeof valorCentavos !== 'number' ||
          !Number.isSafeInteger(valorCentavos) ||
          valorCentavos <= 0 ||
          valorCentavos > config.limites.lanceMaximoCentavos ||
          typeof chave !== 'string' ||
          !CHAVE_VALIDA.test(chave)
        ) {
          return responder(recusa('DADOS_INVALIDOS', leilaoId ? await lanceMinimoVigente(leilaoId) : null));
        }

        // 1) sessão válida, conferida no banco a cada lance
        if (!(await sessaoValida(socket))) {
          responder(recusa('SESSAO_EXPIRADA', await lanceMinimoVigente(leilaoId)));
          desligar(socket);
          return;
        }
        // 2) está na sala deste leilão
        const papel = socket.data.salas.get(leilaoId);
        if (!papel) return responder(recusa('FORA_DA_SALA', await lanceMinimoVigente(leilaoId)));
        if (papel === 'COMITENTE') {
          return responder(recusa('COMITENTE_NAO_PODE_DAR_LANCE', await lanceMinimoVigente(leilaoId)));
        }
        if (papel === 'ESPECTADOR') {
          return responder(recusa('SOMENTE_ESPECTADOR', await lanceMinimoVigente(leilaoId)));
        }
        // 3) o resto das regras é decidido dentro da transação
        responder(await darLance({ usuarioId: usuario.id, leilaoId, valorCentavos, chave }));
      })().catch((erro) => {
        app.log.error({ erro }, 'falha ao processar lance');
        // Não sabemos se gravou: o cliente reenvia com a MESMA chave e recebe a resposta original.
        responder({
          aceito: false,
          motivo: 'ERRO_INTERNO',
          mensagem: 'Não foi possível confirmar o lance. Reenviando…',
          lanceMinimoCentavos: null,
          reenvio: false,
        });
      });
    });
  });

  // ---- saída: avisar as salas ----------------------------------------------
  // Uma fila por leilão: fotografias saem em ordem, e eventos que chegam
  // enquanto uma leitura está em curso são fundidos em uma leitura só.
  type Fila = { rodando: boolean; pendente: boolean };
  const filasDeEstado = new Map<number, Fila>();
  const filasDePresenca = new Map<number, Fila>();

  function emFila(filas: Map<number, Fila>, leilaoId: number, oQue: string, enviar: () => Promise<void>): void {
    if (!io.sockets.adapter.rooms.has(salaDoLeilao(leilaoId))) return; // ninguém olhando daqui
    let fila = filas.get(leilaoId);
    if (!fila) filas.set(leilaoId, (fila = { rodando: false, pendente: false }));
    if (fila.rodando) {
      fila.pendente = true;
      return;
    }
    fila.rodando = true;
    void (async () => {
      try {
        do {
          fila.pendente = false;
          await enviar();
        } while (fila.pendente);
      } catch (erro) {
        app.log.error({ erro, leilaoId }, `falha ao difundir ${oQue}`);
      } finally {
        filas.delete(leilaoId);
      }
    })();
  }

  const difundir = (leilaoId: number): void =>
    emFila(filasDeEstado, leilaoId, 'estado da sala', async () => {
      const estado = await estadoDaSala(leilaoId);
      if (estado) io.to(salaDoLeilao(leilaoId)).emit('sala:estado', estado);
    });

  /** RF25: a contagem sai do banco, então é a mesma em todas as instâncias. */
  const difundirPresenca = (leilaoId: number): void =>
    emFila(filasDePresenca, leilaoId, 'presença', async () => {
      io.to(salaDoLeilao(leilaoId)).emit('sala:presenca', await contarPresenca(leilaoId));
    });

  return {
    io,

    /** Chamado para cada evento confirmado no banco (ver eventos.ts). */
    aoEvento(evento: EventoLeilao): void {
      eventosRecebidos.somar({ tipo: evento.tipo });
      if (evento.tipo === 'PRESENCA') return difundirPresenca(evento.leilaoId);
      difundir(evento.leilaoId);
      // a sala também é avisada de que a descrição mudou, para recarregar o item
      if (evento.tipo === 'EDITADO') io.to(salaDoLeilao(evento.leilaoId)).emit('sala:item', { leilaoId: evento.leilaoId });
      // RF26: quem liderava é avisado na hora, em qualquer página em que esteja
      if (evento.tipo === 'LANCE' && evento.liderAnteriorId) {
        const destino = salaDoUsuario(evento.liderAnteriorId);
        if (!io.sockets.adapter.rooms.has(destino)) return;
        void pool
          .query('SELECT i.nome FROM leiloes l JOIN itens i ON i.id = l.item_id WHERE l.id = $1', [evento.leilaoId])
          .then(({ rows }) =>
            io.to(destino).emit('lance:superado', {
              leilaoId: evento.leilaoId,
              itemNome: rows[0]?.nome ?? '',
              valorCentavos: evento.valorCentavos,
            }),
          )
          .catch((erro) => app.log.error({ erro }, 'falha ao avisar lance superado'));
      }
    },

    /** A escuta caiu e voltou: pode ter perdido eventos, então reenvia tudo o que há de sala aberta. */
    ressincronizar(): void {
      for (const nome of io.sockets.adapter.rooms.keys()) {
        const m = /^leilao:(\d+)$/.exec(nome);
        if (m) {
          difundir(Number(m[1]));
          difundirPresenca(Number(m[1]));
        }
      }
    },

    async encerrar(): Promise<void> {
      encerrando = true;
      clearInterval(batimento);
      // as outras instâncias param de contar quem estava aqui; ao reconectar
      // (RF24), cada pessoa entra de novo na sala e volta para a contagem
      await removerPresencasDaInstancia().catch(() => {});
      await io.close();
    },
  };
}
