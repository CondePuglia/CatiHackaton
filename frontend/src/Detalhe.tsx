import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Aviso, Contador, Selo, api, botao, botaoSecundario, dataHora, fusoLocal, reais, useSessao } from './comuns';

export function Fotos({ fotos }: { fotos: Array<{ id: number; url: string }> }) {
  const [atual, setAtual] = useState(0);
  const foto = fotos[Math.min(atual, fotos.length - 1)];
  return (
    <div>
      <div className="aspect-[4/3] overflow-hidden rounded-2xl bg-slate-100">
        {foto && <img src={foto.url} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="mt-2 flex gap-2 overflow-x-auto">
        {fotos.map((f, i) => (
          <button
            key={f.id}
            type="button"
            aria-label={`Foto ${i + 1}`}
            onClick={() => setAtual(i)}
            className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 ${i === atual ? 'border-indigo-600' : 'border-transparent'}`}
          >
            <img src={f.url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

export function TextoResultado({ leilao }: { leilao: any }) {
  const r = leilao.resultado;
  if (!r) return null;
  if (r.tipo === 'VENDIDO') {
    return (
      <Aviso tipo="ok">
        <strong>Vendido</strong> para {r.vencedor.apelido} por <strong>{reais(r.valorCentavos)}</strong>.
        {leilao.eu?.venci && ' Você venceu este leilão!'}
        {leilao.eu?.vencedorNome && ` Comprador: ${leilao.eu.vencedorNome}.`}
      </Aviso>
    );
  }
  if (r.tipo === 'ENCERRADO_SEM_LANCES') return <Aviso tipo="info">Encerrado sem lances.</Aviso>;
  return <Aviso tipo="info">Leilão cancelado pelo comitente.</Aviso>;
}

/** Detalhe público do leilão; daqui se entra na sala. */
export function Detalhe() {
  const { id } = useParams();
  const { usuario } = useSessao();
  const [leilao, setLeilao] = useState<any>(null);
  const [erro, setErro] = useState('');
  const [cancelando, setCancelando] = useState(false);

  const carregar = useCallback(
    () =>
      api(`/leiloes/${id}`)
        .then((r) => (setLeilao(r.leilao), setErro('')))
        .catch((e) => setErro(e.message)),
    [id],
  );
  useEffect(() => {
    void carregar();
    const t = setInterval(carregar, 4000);
    return () => clearInterval(t);
  }, [carregar, usuario]);

  async function cancelar() {
    if (!window.confirm('Cancelar este leilão? Ele continua registrado como Cancelado.')) return;
    setCancelando(true);
    try {
      const r = await api(`/leiloes/${id}/cancelar`, { metodo: 'POST' });
      setLeilao(r.leilao);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setCancelando(false);
    }
  }

  if (!leilao) return erro ? <Aviso>{erro}</Aviso> : <p className="text-sm text-slate-500">Carregando…</p>;
  const ativo = leilao.status === 'AGENDADO' || leilao.status === 'EM_ANDAMENTO';

  return (
    <article className="grid gap-6 lg:grid-cols-2">
      <Fotos fotos={leilao.item.fotos} />
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Selo status={leilao.status} />
          <span className="text-sm text-slate-500">{leilao.item.categoriaNome}</span>
        </div>
        <h1 className="text-2xl font-bold">{leilao.item.nome}</h1>
        <p className="whitespace-pre-line text-slate-700">{leilao.item.descricao}</p>

        <dl className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm">
          <div>
            <dt className="text-slate-500">{leilao.precoAtualCentavos === null ? 'Preço inicial' : 'Preço atual'}</dt>
            <dd className="text-xl font-bold text-indigo-700">{reais(leilao.precoAtualCentavos ?? leilao.precoInicialCentavos)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Lances</dt>
            <dd className="text-xl font-bold">{leilao.totalLances}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Início</dt>
            <dd>{dataHora(leilao.inicioEm)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Término{leilao.prorrogado ? ' (prorrogado)' : ''}</dt>
            <dd>{dataHora(leilao.terminoEm)}</dd>
          </div>
          <div className="col-span-2 text-xs text-slate-500">
            Horários no seu fuso ({fusoLocal}). Comitente: {leilao.comitente.nome}.
          </div>
        </dl>

        {erro && <Aviso>{erro}</Aviso>}
        <TextoResultado leilao={leilao} />

        {ativo && (
          <p className="font-semibold text-slate-800">
            <Contador status={leilao.status} inicioEm={leilao.inicioEm} terminoEm={leilao.terminoEm} />
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Link to={`/leiloes/${leilao.id}/sala`} className={botao}>
            {usuario ? 'Entrar na sala' : 'Entrar na sala (exige login)'}
          </Link>
          {leilao.eu?.podeCancelar && (
            <button className={botaoSecundario} onClick={() => void cancelar()} disabled={cancelando}>
              {cancelando ? 'Cancelando…' : 'Cancelar leilão'}
            </button>
          )}
        </div>
        {leilao.eu?.souComitente && leilao.totalLances > 0 && ativo && (
          <p className="text-xs text-slate-500">Um leilão com lances não pode mais ser cancelado.</p>
        )}
      </div>
    </article>
  );
}
