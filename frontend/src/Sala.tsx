import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import { Aviso, Selo, acertarRelogio, api, botao, campo, centavosParaTexto, hora, paraCentavos, reais, tempo, useAgora } from './comuns';
import { Fotos, TextoResultado } from './Detalhe';

type Estado = {
  leilaoId: number;
  versao: number;
  status: string;
  agora: string;
  inicioEm: string;
  terminoEm: string;
  prorrogado: boolean;
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  lanceMinimoCentavos: number | null;
  totalLances: number;
  lider: { numero: number; apelido: string } | null;
  ultimosLances: Array<{ sequencia: number; numero: number; apelido: string; valorCentavos: number; em: string }>;
  resultado: any;
};

type Retorno = { tipo: 'ok' | 'erro' | 'info'; texto: string };

const novaChave = () => crypto.randomUUID();

/**
 * Sala em tempo real (RF09). A tela não calcula nada: mostra a fotografia que o
 * servidor manda a cada mudança. O lance mínimo, o líder e o tempo vêm de lá.
 */
export function Sala() {
  const leilaoId = Number(useParams().id);
  const [item, setItem] = useState<any>(null);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [eu, setEu] = useState<{ papel: string; numero: number | null }>({ papel: '', numero: null });
  const [conectado, setConectado] = useState(false);
  const [falha, setFalha] = useState('');
  const [valor, setValor] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [retorno, setRetorno] = useState<Retorno | null>(null);
  const socket = useRef<Socket | null>(null);
  // RF12: uma chave por tentativa. Clique duplo e reenvio usam a mesma; só troca
  // depois de uma resposta definitiva do servidor.
  const chave = useRef(novaChave());
  const agora = useAgora();

  useEffect(() => {
    api(`/leiloes/${leilaoId}`)
      .then((r) => setItem(r.leilao))
      .catch((e) => setFalha(e.message));
  }, [leilaoId]);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    socket.current = s;

    const receber = (novo: Estado) => {
      if (novo.leilaoId !== leilaoId) return;
      acertarRelogio(novo.agora);
      // a versão desempata mensagens fora de ordem: estado velho é ignorado
      setEstado((atual) => (atual && atual.versao > novo.versao ? atual : novo));
    };

    // Vale para a primeira conexão e para cada reconexão: entra de novo e recebe o estado inteiro.
    s.on('connect', () => {
      setConectado(true);
      s.emit('sala:entrar', { leilaoId }, (r: any) => {
        if (!r?.ok) return setFalha(r?.erro?.mensagem ?? 'Não foi possível entrar na sala.');
        setFalha('');
        setEu(r.eu);
        receber(r.estado);
      });
    });
    s.on('disconnect', () => setConectado(false));
    s.on('connect_error', (e) => {
      setConectado(false);
      if (e.message === 'NAO_AUTENTICADO') setFalha('Sua sessão expirou. Entre de novo para voltar à sala.');
    });
    s.on('sala:estado', receber);
    return () => {
      s.close();
    };
  }, [leilaoId]);

  const minimo = estado?.lanceMinimoCentavos ?? null;

  // Mantém o campo sempre em um valor que ainda vale: se o mínimo subiu, o campo sobe junto.
  useEffect(() => {
    if (minimo === null) return;
    setValor((v) => {
      const digitado = paraCentavos(v);
      return digitado === null || digitado < minimo ? centavosParaTexto(minimo) : v;
    });
  }, [minimo]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const valorCentavos = paraCentavos(valor);
    if (valorCentavos === null) return setRetorno({ tipo: 'erro', texto: 'Informe o valor em reais, por exemplo 150,00.' });
    if (!socket.current || enviando) return;
    setEnviando(true);
    setRetorno(null);

    let resposta: any = null;
    // Falha de rede: reenvia a MESMA tentativa. O servidor devolve a resposta original (RF12).
    for (let tentativa = 0; tentativa < 4 && !resposta; tentativa++) {
      try {
        const r = await socket.current.timeout(4000).emitWithAck('lance:enviar', { leilaoId, valorCentavos, chave: chave.current });
        if (r?.motivo !== 'ERRO_INTERNO') resposta = r;
      } catch {
        setRetorno({ tipo: 'info', texto: 'Sem resposta do servidor. Reenviando o mesmo lance…' });
      }
    }
    setEnviando(false);

    if (!resposta) {
      return setRetorno({ tipo: 'erro', texto: 'Não foi possível confirmar o lance. Confira a conexão e tente de novo.' });
    }
    if (resposta.motivo === 'SESSAO_EXPIRADA') {
      // a chave é mantida: depois do login, o mesmo lance pode ser reenviado
      return setFalha('Sua sessão expirou. Entre de novo para voltar à sala.');
    }
    chave.current = novaChave(); // resposta definitiva: a próxima é outra tentativa
    if (resposta.aceito) {
      setEu((x) => ({ ...x, numero: resposta.meuNumero }));
      setRetorno({
        tipo: 'ok',
        texto: `Lance de ${reais(resposta.lance.valorCentavos)} aceito. Você é o líder.${resposta.prorrogou ? ' O término foi prorrogado.' : ''}`,
      });
    } else {
      setRetorno({
        tipo: 'erro',
        texto: `${resposta.mensagem}${resposta.lanceMinimoCentavos ? ` Lance mínimo atual: ${reais(resposta.lanceMinimoCentavos)}.` : ''}`,
      });
    }
  }

  if (falha && !estado) {
    return (
      <div className="space-y-3">
        <Aviso>{falha}</Aviso>
        <Link className="text-sm font-semibold text-indigo-700" to={`/entrar?volta=/leiloes/${leilaoId}/sala`}>
          Entrar de novo
        </Link>
      </div>
    );
  }
  if (!estado) return <p className="text-sm text-slate-500">Entrando na sala…</p>;

  const souLider = eu.numero !== null && estado.lider?.numero === eu.numero;
  const souComitente = eu.papel === 'COMITENTE';
  const aberto = estado.status === 'EM_ANDAMENTO';
  const restante = new Date(estado.terminoEm).getTime() - agora;
  const paraAbrir = new Date(estado.inicioEm).getTime() - agora;
  const quem = (numero: number, apelido: string) => (numero === eu.numero ? `${apelido} (você)` : apelido);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        {item && <Fotos fotos={item.item.fotos} />}
        <h1 className="text-xl font-bold">{item?.item.nome ?? 'Leilão'}</h1>
        <Link className="text-sm font-semibold text-indigo-700" to={`/leiloes/${leilaoId}`}>
          Ver descrição completa
        </Link>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Selo status={estado.status} />
          <span className={`text-xs font-semibold ${conectado ? 'text-emerald-700' : 'text-amber-700'}`} role="status">
            {conectado ? '● Ao vivo' : '○ Reconectando…'}
          </span>
        </div>
        {falha && (
          <Aviso>
            {falha}{' '}
            <Link className="font-semibold underline" to={`/entrar?volta=/leiloes/${leilaoId}/sala`}>
              Entrar de novo
            </Link>
          </Aviso>
        )}

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-500">{estado.precoAtualCentavos === null ? 'Preço inicial' : 'Preço atual'}</p>
              <p className="text-3xl font-bold text-indigo-700">{reais(estado.precoAtualCentavos ?? estado.precoInicialCentavos)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-slate-500">{estado.status === 'AGENDADO' ? 'Abre em' : 'Tempo restante'}</p>
              <p className={`text-3xl font-bold tabular-nums ${aberto && restante < 60_000 ? 'text-rose-600' : ''}`}>
                {estado.status === 'AGENDADO' ? tempo(paraAbrir) : aberto ? (restante > 0 ? tempo(restante) : 'Encerrando…') : '—'}
              </p>
              {estado.prorrogado && aberto && <p className="text-xs font-semibold text-amber-700">Término prorrogado</p>}
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 text-sm">
            <div>
              <dt className="text-slate-500">Líder</dt>
              <dd className="font-semibold">{estado.lider ? quem(estado.lider.numero, estado.lider.apelido) : '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Lance mínimo</dt>
              <dd className="font-semibold">{minimo !== null ? reais(minimo) : '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Total de lances</dt>
              <dd className="font-semibold">{estado.totalLances}</dd>
            </div>
          </dl>
        </div>

        <TextoResultado leilao={{ resultado: estado.resultado, eu: { venci: estado.status === 'VENDIDO' && souLider } }} />

        {estado.status === 'AGENDADO' && <Aviso tipo="info">A sala abre sozinha no horário. Não precisa recarregar a página.</Aviso>}

        {aberto &&
          (souComitente ? (
            <Aviso tipo="info">Você é o comitente deste leilão: acompanha a disputa, mas não pode dar lance.</Aviso>
          ) : (
            <form onSubmit={enviar} className="space-y-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <label className="block text-sm font-medium text-slate-700" htmlFor="valor">
                Seu lance (R$)
              </label>
              <div className="flex gap-2">
                <input id="valor" className={campo} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
                <button className={botao} disabled={enviando || !conectado || souLider}>
                  {enviando ? 'Enviando…' : 'Dar lance'}
                </button>
              </div>
              <p className="text-xs text-slate-500">
                {souLider ? 'Você é o líder. Só precisa dar outro lance se alguém cobrir.' : 'O lance é irrevogável: não dá para desfazer.'}
              </p>
            </form>
          ))}
        {retorno && <Aviso tipo={retorno.tipo}>{retorno.texto}</Aviso>}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Últimos lances</h2>
          {estado.ultimosLances.length === 0 ? (
            <p className="text-sm text-slate-500">Nenhum lance ainda.</p>
          ) : (
            <ol className="divide-y divide-slate-100 text-sm">
              {estado.ultimosLances.map((l) => (
                <li key={l.sequencia} className="flex items-center justify-between py-1.5">
                  <span>{quem(l.numero, l.apelido)}</span>
                  <span className="font-semibold">{reais(l.valorCentavos)}</span>
                  <span className="tabular-nums text-slate-500">{hora(l.em)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
