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
// Sessão
// ---------------------------------------------------------------------------
export type Usuario = { id: number; nome: string; email: string };
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

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
export const dataHora = (iso: string) => formatoData.format(new Date(iso));
export const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR');
export const fusoLocal = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

// ---------------------------------------------------------------------------
// Componentes pequenos
// ---------------------------------------------------------------------------
const ROTULOS: Record<string, [string, string]> = {
  AGENDADO: ['Agendado', 'bg-sky-100 text-sky-800'],
  EM_ANDAMENTO: ['Em andamento', 'bg-emerald-100 text-emerald-800'],
  VENDIDO: ['Vendido', 'bg-violet-100 text-violet-800'],
  ENCERRADO_SEM_LANCES: ['Encerrado sem lances', 'bg-slate-200 text-slate-700'],
  CANCELADO: ['Cancelado', 'bg-rose-100 text-rose-800'],
};

export function Selo({ status }: { status: string }) {
  const [rotulo, cor] = ROTULOS[status] ?? [status, 'bg-slate-200'];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${cor}`}>{rotulo}</span>;
}

/** "Abre em 01:30" / "Termina em 00:42", sempre pelo relógio do servidor. */
export function Contador({ status, inicioEm, terminoEm }: { status: string; inicioEm: string; terminoEm: string }) {
  const agora = useAgora();
  if (status === 'AGENDADO') return <>Abre em {tempo(new Date(inicioEm).getTime() - agora)}</>;
  if (status === 'EM_ANDAMENTO') return <>Termina em {tempo(new Date(terminoEm).getTime() - agora)}</>;
  return null;
}

export function Aviso({ tipo = 'erro', children }: { tipo?: 'erro' | 'ok' | 'info'; children: ReactNode }) {
  const cor = {
    erro: 'border-rose-200 bg-rose-50 text-rose-800',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
  }[tipo];
  return (
    <div role={tipo === 'erro' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${cor}`}>
      {children}
    </div>
  );
}

export const botao =
  'inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
export const botaoSecundario =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50';
export const campo =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

export function Campo({ rotulo, erro, dica, children }: { rotulo: string; erro?: string; dica?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{rotulo}</span>
      {children}
      {dica && !erro && <span className="mt-1 block text-xs text-slate-500">{dica}</span>}
      {erro && <span className="mt-1 block text-xs font-medium text-rose-700">{erro}</span>}
    </label>
  );
}
