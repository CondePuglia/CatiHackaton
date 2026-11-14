import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Aviso, Contador, Selo, api, botao, botaoSecundario, reais } from './comuns';

type Resumo = {
  id: number;
  status: string;
  item: { nome: string; categoriaNome: string; fotoUrl: string | null };
  comitente: { nome: string };
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  totalLances: number;
  inicioEm: string;
  terminoEm: string;
};

/** RF20: listagem pública (ou, com `meus`, os leilões que eu anunciei em qualquer estado). */
export function Listagem({ meus = false }: { meus?: boolean }) {
  const [pagina, setPagina] = useState(1);
  const [dados, setDados] = useState<{ leiloes: Resumo[]; total: number; porPagina: number } | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    let vivo = true;
    const carregar = () =>
      api(`${meus ? '/eu/leiloes' : '/leiloes'}?pagina=${pagina}`)
        .then((r) => vivo && (setDados(r), setErro('')))
        .catch((e) => vivo && setErro(e.message));
    void carregar();
    // Estados e preços mudam sozinhos; a página se atualiza sem recarregar.
    const t = setInterval(carregar, 4000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [pagina, meus]);

  const paginas = dados ? Math.max(1, Math.ceil(dados.total / dados.porPagina)) : 1;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{meus ? 'Meus leilões' : 'Leilões'}</h1>
          <p className="text-sm text-slate-600">
            {meus ? 'Tudo o que você anunciou, em qualquer estado.' : 'Em andamento primeiro; depois os que vão abrir.'}
          </p>
        </div>
        {meus && (
          <Link to="/leiloes/novo" className={botao}>
            Anunciar item
          </Link>
        )}
      </div>

      {erro && <Aviso>{erro}</Aviso>}
      {dados && dados.leiloes.length === 0 && (
        <Aviso tipo="info">{meus ? 'Você ainda não anunciou nenhum item.' : 'Nenhum leilão agendado ou em andamento agora.'}</Aviso>
      )}

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dados?.leiloes.map((l) => (
          <li key={l.id}>
            <Link
              to={`/leiloes/${l.id}`}
              className="block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
            >
              <div className="aspect-[4/3] bg-slate-100">
                {l.item.fotoUrl && <img src={l.item.fotoUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
              </div>
              <div className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <Selo status={l.status} />
                  <span className="text-xs text-slate-500">{l.item.categoriaNome}</span>
                </div>
                <h2 className="truncate font-semibold">{l.item.nome}</h2>
                <p className="text-lg font-bold text-indigo-700">{reais(l.precoAtualCentavos ?? l.precoInicialCentavos)}</p>
                <p className="text-xs text-slate-600">
                  {l.precoAtualCentavos === null ? 'Preço inicial' : `${l.totalLances} lance${l.totalLances === 1 ? '' : 's'}`}
                  {' · '}
                  <Contador status={l.status} inicioEm={l.inicioEm} terminoEm={l.terminoEm} />
                </p>
                <p className="text-xs text-slate-500">Comitente: {l.comitente.nome}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {paginas > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-3 text-sm">
          <button className={botaoSecundario} disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>
            Anterior
          </button>
          <span>
            Página {pagina} de {paginas}
          </span>
          <button className={botaoSecundario} disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)}>
            Próxima
          </button>
        </nav>
      )}
    </section>
  );
}
