import { config } from './config.js';
import { agoraDoBanco, pool } from './db.js';
import { publicar } from './eventos.js';
import { lanceMinimo, novoTermino } from './regras.js';

export type Motivo =
  | 'SESSAO_EXPIRADA'
  | 'FORA_DA_SALA'
  | 'SOMENTE_ESPECTADOR'
  | 'DADOS_INVALIDOS'
  | 'LEILAO_INEXISTENTE'
  | 'LEILAO_NAO_INICIADO'
  | 'LEILAO_ENCERRADO'
  | 'COMITENTE_NAO_PODE_DAR_LANCE'
  | 'JA_E_LIDER'
  | 'VALOR_ABAIXO_DO_MINIMO'
  | 'CHAVE_REUTILIZADA'
  | 'MUITO_RAPIDO'
  | 'ERRO_INTERNO';

export const MENSAGENS: Record<Motivo, string> = {
  SESSAO_EXPIRADA: 'Sua sessão expirou. Entre de novo para dar lances.',
  FORA_DA_SALA: 'Entre na sala do leilão para dar lances.',
  SOMENTE_ESPECTADOR: 'Você está só assistindo. Mude para participante para dar lances.',
  DADOS_INVALIDOS: 'Informe um valor de lance válido.',
  LEILAO_INEXISTENTE: 'Leilão não encontrado.',
  LEILAO_NAO_INICIADO: 'Este leilão ainda não começou.',
  LEILAO_ENCERRADO: 'Este leilão já terminou.',
  COMITENTE_NAO_PODE_DAR_LANCE: 'O comitente não pode dar lance no próprio leilão.',
  JA_E_LIDER: 'Você já é o líder deste leilão.',
  VALOR_ABAIXO_DO_MINIMO: 'O valor está abaixo do lance mínimo atual.',
  CHAVE_REUTILIZADA: 'Esta tentativa de lance já foi usada com outros dados.',
  MUITO_RAPIDO: 'Aguarde um instante antes de dar outro lance.',
  ERRO_INTERNO: 'Não foi possível confirmar o lance. Tente de novo.',
};

export type LanceAceito = {
  aceito: true;
  lance: { id: number; sequencia: number; valorCentavos: number; em: string };
  meuNumero: number;
  /** mínimo para o PRÓXIMO lance, já contando este */
  lanceMinimoCentavos: number;
  terminoEm: string;
  prorrogou: boolean;
  /** true quando esta resposta é a original, devolvida a um reenvio (RF12) */
  reenvio: boolean;
};

export type LanceRecusado = {
  aceito: false;
  motivo: Motivo;
  mensagem: string;
  /** RF10: toda recusa informa o lance mínimo atual (null se o leilão não recebe lances) */
  lanceMinimoCentavos: number | null;
  reenvio: boolean;
};

export type ResultadoLance = LanceAceito | LanceRecusado;

export type EntradaLance = {
  usuarioId: number;
  leilaoId: number;
  valorCentavos: number;
  /** chave de idempotência gerada no navegador para ESTA tentativa */
  chave: string;
};

export const recusa = (motivo: Motivo, lanceMinimoCentavos: number | null = null): LanceRecusado => ({
  aceito: false,
  motivo,
  mensagem: MENSAGENS[motivo],
  lanceMinimoCentavos,
  reenvio: false,
});

export const CHAVE_VALIDA = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Processa um lance. É a única porta de entrada de lances no sistema.
 *
 * Tudo acontece em UMA transação, nesta ordem:
 *
 *  1. Reserva a chave de idempotência (RF12). Se a chave já existe, devolve a
 *     resposta original e não processa nada. O INSERT ... ON CONFLICT espera um
 *     envio simultâneo da mesma chave terminar, então clique duplo nunca vira
 *     dois lances.
 *  2. Trava a linha do leilão com SELECT ... FOR UPDATE (RF11). Lances
 *     simultâneos no mesmo leilão formam fila aqui: quem chega primeiro é
 *     processado primeiro, e o seguinte já enxerga o estado deixado por ele.
 *     Leilões diferentes não se bloqueiam.
 *  3. Lê o relógio do banco DEPOIS de obter a trava (RF16): vale a hora em que
 *     o lance é processado, não a hora em que o usuário clicou.
 *  4. Confere as regras do RF10 contra o estado de agora.
 *  5. Grava lance, novo preço, líder e término (RF15), guarda a resposta e
 *     publica o evento. O evento só sai no COMMIT, então a sala nunca vê um
 *     lance que não foi gravado.
 *
 * Recusas por regra também ficam gravadas na tentativa: reenviar a mesma chave
 * devolve a mesma recusa.
 */
export async function darLance(e: EntradaLance): Promise<ResultadoLance> {
  const c = await pool.connect();
  let aberta = false;
  const desfazer = async () => {
    if (aberta) {
      aberta = false;
      await c.query('ROLLBACK').catch(() => {});
    }
  };

  try {
    await c.query('BEGIN');
    aberta = true;

    // 1. idempotência -------------------------------------------------------
    const reserva = await c.query(
      `INSERT INTO tentativas_lance (usuario_id, chave, leilao_id, valor_centavos)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario_id, chave) DO NOTHING`,
      [e.usuarioId, e.chave, e.leilaoId, e.valorCentavos],
    );
    if (reserva.rowCount === 0) {
      const { rows } = await c.query(
        `SELECT leilao_id, valor_centavos, resultado FROM tentativas_lance
          WHERE usuario_id = $1 AND chave = $2`,
        [e.usuarioId, e.chave],
      );
      await desfazer();
      const original = rows[0];
      if (!original?.resultado) throw new Error('tentativa de lance sem resultado gravado');
      if (original.leilao_id !== e.leilaoId || original.valor_centavos !== e.valorCentavos) {
        return recusa('CHAVE_REUTILIZADA');
      }
      return { ...(original.resultado as ResultadoLance), reenvio: true };
    }

    // 1b. limite de frequência (RF13) ---------------------------------------
    // Vem DEPOIS da idempotência: reenviar a mesma tentativa nunca é punido.
    // A trava é na linha do próprio usuário: pessoas diferentes não se bloqueiam.
    const autor = await c.query('SELECT ultimo_lance_em FROM usuarios WHERE id = $1 FOR NO KEY UPDATE', [e.usuarioId]);
    const instante = await agoraDoBanco(c);
    const ultimo = autor.rows[0]?.ultimo_lance_em as Date | null | undefined;
    if (ultimo && instante.getTime() - ultimo.getTime() < config.lances.intervaloMinimoMs) {
      await desfazer(); // não chegou a ser avaliado: a tentativa não fica gravada
      return recusa('MUITO_RAPIDO', await lanceMinimoVigente(e.leilaoId));
    }
    await c.query('UPDATE usuarios SET ultimo_lance_em = $2 WHERE id = $1', [e.usuarioId, instante]);

    // 2. fila por leilão ----------------------------------------------------
    const { rows } = await c.query(
      `SELECT comitente_id, status, preco_inicial_centavos, preco_atual_centavos,
              lider_id, total_lances, termino_em, termino_original_em
         FROM leiloes WHERE id = $1 FOR UPDATE`,
      [e.leilaoId],
    );
    const l = rows[0];
    if (!l) {
      await desfazer(); // nada a registrar: o leilão não existe
      return recusa('LEILAO_INEXISTENTE');
    }

    // 3. relógio do servidor, lido com a trava em mãos ------------------------
    const agora = await agoraDoBanco(c);

    // 4. regras do RF10, contra o estado vigente -----------------------------
    const minimo = lanceMinimo({
      totalLances: l.total_lances,
      precoInicialCentavos: l.preco_inicial_centavos,
      precoAtualCentavos: l.preco_atual_centavos,
    });
    const emAndamento = l.status === 'EM_ANDAMENTO' && agora.getTime() < l.termino_em.getTime();

    let motivo: Motivo | null = null;
    if (l.status === 'AGENDADO') motivo = 'LEILAO_NAO_INICIADO';
    else if (!emAndamento) motivo = 'LEILAO_ENCERRADO';
    else if (l.comitente_id === e.usuarioId) motivo = 'COMITENTE_NAO_PODE_DAR_LANCE';
    else if (l.lider_id === e.usuarioId) motivo = 'JA_E_LIDER';
    else if (e.valorCentavos < minimo) motivo = 'VALOR_ABAIXO_DO_MINIMO';

    if (motivo) {
      const recusado = recusa(motivo, emAndamento ? minimo : null);
      await c.query(
        'UPDATE tentativas_lance SET resultado = $3 WHERE usuario_id = $1 AND chave = $2',
        [e.usuarioId, e.chave, JSON.stringify(recusado)],
      );
      await c.query('COMMIT');
      aberta = false;
      return recusado;
    }

    // 5. grava ---------------------------------------------------------------
    const sequencia = (l.total_lances as number) + 1;

    await c.query(
      `INSERT INTO apelidos (leilao_id, usuario_id, numero)
       SELECT $1::bigint, $2::bigint, COALESCE(MAX(numero), 0) + 1 FROM apelidos WHERE leilao_id = $1::bigint
       ON CONFLICT (leilao_id, usuario_id) DO NOTHING`,
      [e.leilaoId, e.usuarioId],
    );
    const apelidoAtual = await c.query(
      'SELECT numero FROM apelidos WHERE leilao_id = $1 AND usuario_id = $2',
      [e.leilaoId, e.usuarioId],
    );

    const novoLance = await c.query(
      `INSERT INTO lances (leilao_id, usuario_id, valor_centavos, sequencia, criado_em)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.leilaoId, e.usuarioId, e.valorCentavos, sequencia, agora],
    );

    const termino = novoTermino(agora, l.termino_em, l.termino_original_em, config.prorrogacao);
    await c.query(
      `UPDATE leiloes
          SET preco_atual_centavos = $2, lider_id = $3, total_lances = $4,
              termino_em = GREATEST(termino_em, $5), -- o término nunca recua
              versao = versao + 1
        WHERE id = $1`,
      [e.leilaoId, e.valorCentavos, e.usuarioId, sequencia, termino],
    );

    const aceito: LanceAceito = {
      aceito: true,
      lance: {
        id: novoLance.rows[0].id,
        sequencia,
        valorCentavos: e.valorCentavos,
        em: agora.toISOString(),
      },
      meuNumero: apelidoAtual.rows[0].numero,
      lanceMinimoCentavos: lanceMinimo({
        totalLances: sequencia,
        precoInicialCentavos: l.preco_inicial_centavos,
        precoAtualCentavos: e.valorCentavos,
      }),
      terminoEm: termino.toISOString(),
      prorrogou: termino.getTime() > l.termino_em.getTime(),
      reenvio: false,
    };

    await c.query(
      'UPDATE tentativas_lance SET resultado = $3 WHERE usuario_id = $1 AND chave = $2',
      [e.usuarioId, e.chave, JSON.stringify(aceito)],
    );
    await publicar(c, {
      leilaoId: e.leilaoId,
      tipo: 'LANCE',
      liderAnteriorId: l.lider_id ?? null,
      valorCentavos: e.valorCentavos,
    });

    await c.query('COMMIT');
    aberta = false;
    return aceito;
  } catch (erro) {
    await desfazer();
    throw erro;
  } finally {
    c.release();
  }
}

/** Lance mínimo vigente, para as recusas que acontecem antes da transação. */
export async function lanceMinimoVigente(leilaoId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT status, total_lances, preco_inicial_centavos, preco_atual_centavos,
            termino_em > clock_timestamp() AS no_prazo
       FROM leiloes WHERE id = $1`,
    [leilaoId],
  );
  const l = rows[0];
  if (!l || l.status !== 'EM_ANDAMENTO' || !l.no_prazo) return null;
  return lanceMinimo({
    totalLances: l.total_lances,
    precoInicialCentavos: l.preco_inicial_centavos,
    precoAtualCentavos: l.preco_atual_centavos,
  });
}
