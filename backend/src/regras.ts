/**
 * Regras de negócio puras: sem banco, sem relógio, sem rede.
 * Recebem o estado e devolvem a resposta — por isso são fáceis de testar e de
 * explicar. Todo dinheiro aqui é inteiro, em centavos (RF19).
 */

export type Status = 'AGENDADO' | 'EM_ANDAMENTO' | 'VENDIDO' | 'ENCERRADO_SEM_LANCES' | 'CANCELADO';

export const STATUS: readonly Status[] = [
  'AGENDADO',
  'EM_ANDAMENTO',
  'VENDIDO',
  'ENCERRADO_SEM_LANCES',
  'CANCELADO',
];
export const STATUS_ATIVOS: readonly Status[] = ['AGENDADO', 'EM_ANDAMENTO'];
export const STATUS_FINAIS: readonly Status[] = ['VENDIDO', 'ENCERRADO_SEM_LANCES', 'CANCELADO'];

/** RF14: tabela de referência do documento. `ate` é exclusivo. */
export const FAIXAS_INCREMENTO: ReadonlyArray<{ ateCentavos: number | null; incrementoCentavos: number }> = [
  { ateCentavos: 100_00, incrementoCentavos: 1_00 },
  { ateCentavos: 500_00, incrementoCentavos: 5_00 },
  { ateCentavos: 1_000_00, incrementoCentavos: 10_00 },
  { ateCentavos: 5_000_00, incrementoCentavos: 50_00 },
  { ateCentavos: 25_000_00, incrementoCentavos: 100_00 },
  { ateCentavos: null, incrementoCentavos: 500_00 },
];

export function incremento(precoAtualCentavos: number): number {
  for (const faixa of FAIXAS_INCREMENTO) {
    if (faixa.ateCentavos === null || precoAtualCentavos < faixa.ateCentavos) {
      return faixa.incrementoCentavos;
    }
  }
  throw new Error('tabela de incrementos sem faixa final');
}

export type EstadoDePreco = {
  totalLances: number;
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
};

/**
 * RF14: lance mínimo atual. Depende só do estado do leilão, dá sempre o mesmo
 * resultado para o mesmo estado e cresce a cada lance aceito. O primeiro lance
 * pode ser igual ao preço inicial.
 */
export function lanceMinimo(l: EstadoDePreco): number {
  if (l.totalLances === 0 || l.precoAtualCentavos === null) return l.precoInicialCentavos;
  return l.precoAtualCentavos + incremento(l.precoAtualCentavos);
}

export type RegraProrrogacao = { janelaSegundos: number; maximoSegundos: number };

/**
 * RF15: um lance aceito com menos de `janela` no relógio leva o término para
 * `janela` depois do lance, sem passar de `término original + máximo`.
 * O término nunca recua.
 */
export function novoTermino(
  agora: Date,
  terminoAtual: Date,
  terminoOriginal: Date,
  regra: RegraProrrogacao,
): Date {
  const janelaMs = regra.janelaSegundos * 1000;
  const restanteMs = terminoAtual.getTime() - agora.getTime();
  if (restanteMs >= janelaMs) return terminoAtual;
  const candidato = agora.getTime() + janelaMs;
  const teto = terminoOriginal.getTime() + regra.maximoSegundos * 1000;
  return new Date(Math.max(terminoAtual.getTime(), Math.min(candidato, teto)));
}

export type LeilaoParaPermissao = {
  status: Status;
  totalLances: number;
  inicioEm: Date;
  terminoEm: Date;
};

/** RF08: cancela enquanto Agendado, ou Em andamento sem lances e antes do término. */
export function podeCancelar(l: LeilaoParaPermissao, agora: Date): boolean {
  if (l.status === 'AGENDADO') return true;
  return l.status === 'EM_ANDAMENTO' && l.totalLances === 0 && agora.getTime() < l.terminoEm.getTime();
}

export const apelido = (numero: number): string => `Participante ${numero}`;
