import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Relógio (RF16): a tela nunca confia no relógio do navegador. Toda resposta do
// servidor traz `agora`; guardamos a diferença e contamos o tempo a partir dela.
// A contagem regressiva é só visual — quem decide é o servidor.
// ---------------------------------------------------------------------------
let defasagemMs = 0;
export const acertarRelogio = (agoraDoServidor: string | undefined) => {
  if (agoraDoServidor) defasagemMs = new Date(agoraDoServidor).getTime() - Date.now();
};
export const agoraNoServidor = () => Date.now() + defasagemMs;

/** Hora do servidor, atualizada quatro vezes por segundo. */
export function useAgora(): number {
  const [agora, setAgora] = useState(agoraNoServidor);
  useEffect(() => {
    const t = setInterval(() => setAgora(agoraNoServidor()), 250);
    return () => clearInterval(t);
  }, []);
  return agora;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export class ErroApi extends Error {
  constructor(
    public status: number,
    public codigo: string,
    mensagem: string,
    public campos: Record<string, string> = {},
  ) {
    super(mensagem);
  }
}

export async function api<T = any>(
  caminho: string,
  opcoes: { metodo?: string; corpo?: unknown; formulario?: FormData } = {},
): Promise<T> {
  let resposta: Response;
  try {
    resposta = await fetch(`/api${caminho}`, {
      method: opcoes.metodo ?? (opcoes.corpo !== undefined || opcoes.formulario ? 'POST' : 'GET'),
      headers: opcoes.corpo !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opcoes.formulario ?? (opcoes.corpo !== undefined ? JSON.stringify(opcoes.corpo) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    throw new ErroApi(0, 'SEM_CONEXAO', 'Sem conexão com o servidor. Tente de novo.');
  }
  const dados = resposta.status === 204 ? null : await resposta.json().catch(() => null);
  if (!resposta.ok) {
    const e = dados?.erro ?? {};
    throw new ErroApi(resposta.status, e.codigo ?? 'ERRO', e.mensagem ?? 'Algo deu errado. Tente de novo.', e.campos);
  }
  acertarRelogio(dados?.agora ?? dados?.leilao?.agora);
  return dados as T;
}

// ---------------------------------------------------------------------------
// Tipos do domínio
// ---------------------------------------------------------------------------
export type Status = 'AGENDADO' | 'EM_ANDAMENTO' | 'VENDIDO' | 'ENCERRADO_SEM_LANCES' | 'CANCELADO';

export type Resumo = {
  id: number;
  status: Status;
  item: { id: number; nome: string; categoria: string; categoriaNome: string; fotoUrl: string | null };
  comitente: { id: number; nome: string };
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  lanceMinimoCentavos: number;
  totalLances: number;
  inicioEm: string;
  terminoEm: string;
  prorrogado: boolean;
  encerradoEm: string | null;
};

export type Leilao = {
  id: number;
  status: Status;
  versao: number;
  item: {
    id: number;
    nome: string;
    descricao: string;
    categoria: string;
    categoriaNome: string;
    fotos: Array<{ id: number; url: string }>;
  };
  comitente: { id: number; nome: string; desde: string };
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  lanceMinimoCentavos: number;
  totalLances: number;
  inicioEm: string;
  terminoEm: string;
  terminoOriginalEm: string;
  prorrogado: boolean;
  abertoEm: string | null;
  encerradoEm: string | null;
  criadoEm: string;
  lider: { numero: number; apelido: string } | null;
  resultado: any;
  agora: string;
  eu:
    | {
        souComitente: boolean;
        souLider: boolean;
        numero: number | null;
        venci: boolean;
        podeCancelar: boolean;
        vencedorNome: string | null;
        edicao?: 'TUDO' | 'ACRESCENTAR_DESCRICAO' | 'NADA';
        podeRelistar?: boolean;
      }
    | null;
};

export type EstadoSala = {
  leilaoId: number;
  versao: number;
  status: Status;
  agora: string;
  inicioEm: string;
  terminoEm: string;
  terminoOriginalEm: string;
  prorrogado: boolean;
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  lanceMinimoCentavos: number | null;
  totalLances: number;
  lider: { numero: number; apelido: string } | null;
  ultimosLances: Array<{ sequencia: number; numero: number; apelido: string; valorCentavos: number; em: string }>;
  resultado: any;
  presenca?: { participantes: number; espectadores: number };
};

export type SituacaoParticipacao = 'LIDER' | 'SUPERADO' | 'VENCEDOR' | 'NAO_VENCEU';

export type Participacao = {
  leilaoId: number;
  status: Status;
  item: { nome: string; fotoUrl: string | null };
  situacao: SituacaoParticipacao;
  meuMaiorLanceCentavos: number;
  meusLances: number;
  precoAtualCentavos: number;
  totalLances: number;
  terminoEm: string;
  encerradoEm: string | null;
};

export type ComitenteResumo = { id: number; nome: string; desde: string; leiloes: number };

export type PerfilComitente = {
  comitente: { id: number; nome: string; desde: string };
  agendados: Resumo[];
  emAndamento: Resumo[];
  passados: { leiloes: Resumo[]; pagina: number; porPagina: number; total: number };
  agora: string;
};

export type FaixaIncremento = { ateCentavos: number | null; incrementoCentavos: number };

export type Config = {
  agora: string;
  categorias: Array<{ id: string; nome: string }>;
  limites: {
    nomeItem: { min: number; max: number };
    descricao: { min: number; max: number };
    fotos: { min: number; max: number; tamanhoMaxBytes: number; tipos: string[] };
    precoInicialCentavos: { min: number; max: number };
    antecedenciaSegundos: { min: number; max: number };
    duracaoSegundos: { min: number; max: number };
    nomeUsuario: { min: number; max: number };
    senha: { min: number };
  };
  prorrogacao: { janelaSegundos: number; maximoSegundos: number };
  incrementos: FaixaIncremento[];
  lances: { recentes: number; intervaloMinimoMs: number };
  edicao: { bloqueioSegundos: number };
  sessao: { inatividadeSegundos: number; maximoSegundos: number };
};

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
export type Usuario = {
  id: number;
  nome: string;
  email: string;
  /** RF30: já pode anunciar itens. */
  comitente: boolean;
  /** RF29: pontuação de 0 a 100. */
  pontuacao: number;
};

export type Credito = {
  pontuacao: number;
  limiteCentavos: number;
  reservadoCentavos: number;
  disponivelCentavos: number;
};
type Sessao = {
  /** undefined = ainda carregando; null = visitante */
  usuario: Usuario | null | undefined;
  definir: (u: Usuario | null) => void;
  sair: () => Promise<void>;
};
const ContextoSessao = createContext<Sessao>({ usuario: undefined, definir: () => {}, sair: async () => {} });
export const useSessao = () => useContext(ContextoSessao);

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null | undefined>(undefined);
  useEffect(() => {
    api('/eu')
      .then((r) => setUsuario(r.usuario))
      .catch(() => setUsuario(null));
  }, []);
  const sair = useCallback(async () => {
    await api('/sessao', { metodo: 'DELETE' }).catch(() => {});
    setUsuario(null);
  }, []);
  return <ContextoSessao.Provider value={{ usuario, definir: setUsuario, sair }}>{children}</ContextoSessao.Provider>;
}

// ---------------------------------------------------------------------------
// Formatação (RF19): dinheiro sempre em centavos inteiros; horário no fuso de quem vê.
// ---------------------------------------------------------------------------
const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const reais = (centavos: number) => moeda.format(centavos / 100);

/** "1.234,56" -> 123456. Faz a conta com texto, sem ponto flutuante. */
export function paraCentavos(texto: string): number | null {
  const limpo = texto.replace(/[R$\s.]/g, '');
  const m = /^(\d{1,13})(?:,(\d{1,2}))?$/.exec(limpo);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export const centavosParaTexto = (centavos: number) =>
  `${Math.floor(centavos / 100).toLocaleString('pt-BR')},${String(centavos % 100).padStart(2, '0')}`;

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
export const dataHora = (iso: string) => formatoData.format(new Date(iso));
export const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR');
export const fusoLocal = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Contagem compacta para cartões: "2d 04h", "1h 05min", "03:42". */
export function tempo(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const dois = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${dois(h)}h`;
  if (h > 0) return `${h}h ${dois(m)}min`;
  return `${dois(m)}:${dois(s % 60)}`;
}

/** Contagem de sala: sempre precisa no último dia, com segundos. */
export function tempoPreciso(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  const dois = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${dois(h)}h`;
  if (h > 0) return `${dois(h)}:${dois(m)}:${dois(seg)}`;
  return `${dois(m)}:${dois(seg)}`;
}

export const STATUS: Record<Status, { rotulo: string; tag: 'blue' | 'green' | 'purple' | 'gray' | 'red'; final: boolean }> = {
  AGENDADO: { rotulo: 'Agendado', tag: 'blue', final: false },
  EM_ANDAMENTO: { rotulo: 'Em andamento', tag: 'green', final: false },
  VENDIDO: { rotulo: 'Vendido', tag: 'purple', final: true },
  ENCERRADO_SEM_LANCES: { rotulo: 'Encerrado sem lances', tag: 'gray', final: true },
  CANCELADO: { rotulo: 'Cancelado', tag: 'red', final: true },
};

export const infoStatus = (status: string) => STATUS[status as Status] ?? { rotulo: status, tag: 'gray' as const, final: true };

/** RF14: mesma tabela do servidor; `ateCentavos` é exclusivo. */
export function incrementoAtual(precoCentavos: number, faixas: FaixaIncremento[]): number {
  for (const faixa of faixas) {
    if (faixa.ateCentavos === null || precoCentavos < faixa.ateCentavos) return faixa.incrementoCentavos;
  }
  return faixas[faixas.length - 1]?.incrementoCentavos ?? 0;
}

// ---------------------------------------------------------------------------
// Pequenos ganchos de tela
// ---------------------------------------------------------------------------
export function useTitulo(titulo: string) {
  useEffect(() => {
    document.title = `${titulo} | Cati Leilões`;
  }, [titulo]);
}

export function useConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let vivo = true;
    api<Config>('/config')
      .then((c) => vivo && setConfig(c))
      .catch((e) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, []);
  return { config, erro };
}

/** RF31: limite, reserva e disponível do usuário logado. */
export function useCredito() {
  const [credito, setCredito] = useState<Credito | null>(null);
  const [erro, setErro] = useState('');
  const recarregar = useCallback(
    () =>
      api<Credito>('/eu/credito')
        .then((c) => {
          setCredito(c);
          setErro('');
        })
        .catch((e) => setErro(e.message)),
    [],
  );
  useEffect(() => {
    void recarregar();
  }, [recarregar]);
  return { credito, erro, recarregar };
}

/** Estado do sistema para o rodapé; não é decoração: é o /api/saude. */
export function useSaude(intervaloMs = 30_000) {
  const [noAr, setNoAr] = useState<boolean | null>(null);
  useEffect(() => {
    let vivo = true;
    const consultar = () =>
      api<{ ok: boolean; agora: string }>('/saude')
        .then((r) => vivo && setNoAr(Boolean(r.ok)))
        .catch(() => vivo && setNoAr(false));
    void consultar();
    const t = setInterval(consultar, intervaloMs);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [intervaloMs]);
  return noAr;
}
