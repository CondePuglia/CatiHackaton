import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Dropdown, Pagination, Search } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import {
  api,
  reais,
  tempoPreciso,
  useAgora,
  useConfig,
  useTitulo,
  type Resumo,
} from './comuns';
import {
  AcaoAnunciar,
  Aviso,
  CartaoLeilao,
  EsqueletoCartao,
  EstadoVazio,
  Selo,
} from './ui';

type RespostaLista = { leiloes: Resumo[]; total: number; porPagina: number; pagina: number };

type Filtro = 'ATIVOS' | 'EM_ANDAMENTO' | 'AGENDADO' | 'ENCERRADOS' | 'TODOS';

const FILTROS: Array<{ id: Filtro; rotulo: string; status: string | null }> = [
  { id: 'ATIVOS', rotulo: 'Ativos', status: null },
  { id: 'EM_ANDAMENTO', rotulo: 'Ao vivo', status: 'EM_ANDAMENTO' },
  { id: 'AGENDADO', rotulo: 'Agendados', status: 'AGENDADO' },
  { id: 'ENCERRADOS', rotulo: 'Encerrados', status: 'VENDIDO,ENCERRADO_SEM_LANCES,CANCELADO' },
  { id: 'TODOS', rotulo: 'Todos', status: 'TODOS' },
];

function Destaque({ leilao }: { leilao: Resumo }) {
  const agora = useAgora();
  const aoVivo = leilao.status === 'EM_ANDAMENTO';
  const alvo = aoVivo ? leilao.terminoEm : leilao.inicioEm;
  const restante = new Date(alvo).getTime() - agora;
  return (
    <Link to={`/leiloes/${leilao.id}`} className="destaque">
      {leilao.item.fotoUrl ? (
        <img src={leilao.item.fotoUrl} alt="" className="destaque__imagem" />
      ) : (
        <span className="destaque__imagem destaque__imagem--vazia" />
      )}
      <span className="destaque__sobrepor" aria-hidden="true" />
      <span className="destaque__conteudo">
        <span className="destaque__topo">
          <Selo status={leilao.status} />
          <span>{leilao.item.categoriaNome}</span>
        </span>
        <span className="destaque__rotulo">{aoVivo ? 'Encerra em' : 'Abre em'}</span>
        <span className="destaque__tempo">
          {restante <= 0 ? 'Encerrando…' : tempoPreciso(restante)}
        </span>
        <span className="destaque__nome">{leilao.item.nome}</span>
        <span className="destaque__rodape">
          <span className="destaque__preco">{reais(leilao.precoAtualCentavos ?? leilao.precoInicialCentavos)}</span>
          <span className="destaque__acao">
            Ver leilão <ArrowRight size={16} aria-hidden="true" />
          </span>
        </span>
      </span>
    </Link>
  );
}

function Estatisticas() {
  const [dados, setDados] = useState<{ aoVivo: number; agendados: number } | null>(null);
  useEffect(() => {
    let vivo = true;
    const carregar = async () => {
      try {
        const [a, b] = await Promise.all([
          api<RespostaLista>('/leiloes?status=EM_ANDAMENTO&pagina=1'),
          api<RespostaLista>('/leiloes?status=AGENDADO&pagina=1'),
        ]);
        if (vivo) setDados({ aoVivo: a.total, agendados: b.total });
      } catch {
        /* o destaque já mostra o estado; a estatística é secundária */
      }
    };
    void carregar();
    const t = setInterval(carregar, 15_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);
  if (!dados) return null;
  return (
    <dl className="abertura__numeros">
      <div>
        <dt>Ao vivo agora</dt>
        <dd>{dados.aoVivo}</dd>
      </div>
      <div>
        <dt>Agendados</dt>
        <dd>{dados.agendados}</dd>
      </div>
      <div>
        <dt>Fechamento</dt>
        <dd>Automático</dd>
      </div>
    </dl>
  );
}

/** RF20: listagem pública (ou, com `meus`, os leilões que eu anunciei em qualquer estado). */
export function Listagem({ meus = false }: { meus?: boolean }) {
  useTitulo(meus ? 'Meus leilões' : 'Leilões');
  const [busca, setBusca] = useSearchParams();
  const { config } = useConfig();
  const filtro = (busca.get('status') as Filtro) || (meus ? 'TODOS' : 'ATIVOS');
  const categoria = busca.get('categoria') ?? '';
  const q = busca.get('q') ?? '';
  const pagina = Math.max(1, Number(busca.get('pagina') ?? 1) || 1);
  const [textoBusca, setTextoBusca] = useState(q);
  const [dados, setDados] = useState<RespostaLista | null>(null);
  const [erro, setErro] = useState('');
  const [tentativa, setTentativa] = useState(0);

  const statusApi = useMemo(() => {
    if (meus) return null;
    return FILTROS.find((f) => f.id === filtro)?.status ?? null;
  }, [filtro, meus]);

  useEffect(() => {
    let vivo = true;
    const carregar = () => {
      const params = new URLSearchParams();
      if (!meus) {
        if (statusApi && statusApi !== 'TODOS') params.set('status', statusApi);
        else if (statusApi === 'TODOS') params.set('status', 'TODOS');
        if (categoria) params.set('categoria', categoria);
        if (q) params.set('q', q);
      }
      params.set('pagina', String(pagina));
      return api<RespostaLista>(`${meus ? '/eu/leiloes' : '/leiloes'}?${params}`)
        .then((r) => {
          if (!vivo) return;
          setDados(r);
          setErro('');
        })
        .catch((e) => vivo && setErro(e.message));
    };
    void carregar();
    // Estados e preços mudam sozinhos; a página se atualiza sem recarregar.
    const t = setInterval(carregar, 5000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [pagina, meus, statusApi, categoria, q, tentativa]);

  useEffect(() => {
    setTextoBusca(q);
  }, [q]);

  useEffect(() => {
    if (textoBusca === q) return;
    const t = setTimeout(() => {
      const proximo = new URLSearchParams(busca);
      const termo = textoBusca.trim();
      if (termo) proximo.set('q', termo);
      else proximo.delete('q');
      proximo.delete('pagina');
      setBusca(proximo, { replace: true });
    }, 350);
    return () => clearTimeout(t);
  }, [textoBusca, q, busca, setBusca]);

  const categorias = useMemo(
    () => [{ id: '', nome: 'Todas as categorias' }, ...(config?.categorias ?? [])],
    [config],
  );
  const categoriaSelecionada = categorias.find((c) => c.id === categoria) ?? categorias[0];

  const atualizar = (patch: Record<string, string | null>) => {
    const proximo = new URLSearchParams(busca);
    for (const [chave, valor] of Object.entries(patch)) {
      if (!valor) proximo.delete(chave);
      else proximo.set(chave, valor);
    }
    setBusca(proximo, { replace: true });
  };

  const destaque = useMemo(() => {
    if (meus || !dados?.leiloes.length || pagina !== 1 || filtro === 'ENCERRADOS') return null;
    return (
      dados.leiloes.find((l) => l.status === 'EM_ANDAMENTO') ??
      dados.leiloes.find((l) => l.status === 'AGENDADO') ??
      null
    );
  }, [dados, meus, pagina, filtro]);

  const paginas = dados ? Math.max(1, Math.ceil(dados.total / dados.porPagina)) : 1;
  const semDados = dados && dados.leiloes.length === 0;

  return (
    <div className="pagina">
      {!meus && (
        <section className="abertura" aria-labelledby="titulo-leiloes">
          <div className="abertura__texto">
            <h1 id="titulo-leiloes">Dispute o que vale a pena.</h1>
            <p className="abertura__frase">
              Lances em tempo real, prorrogação automática e fechamento pelo relógio do servidor.
            </p>
            <div className="abertura__acoes">
              <Button as="a" href="#catalogo" kind="primary" renderIcon={ArrowRight}>
                Ver leilões ativos
              </Button>
              <AcaoAnunciar kind="tertiary" />
            </div>
            <Estatisticas />
          </div>
          <div className="abertura__destaque">
            {destaque ? (
              <Destaque leilao={destaque} />
            ) : (
              <div className="destaque destaque--vazio">
                <span className="destaque__conteudo">
                  <span className="destaque__rotulo">Catálogo</span>
                  <span className="destaque__tempo">Em breve</span>
                  <span className="destaque__nome">Nenhum leilão ativo com esses filtros.</span>
                  <span className="destaque__rodape">
                    <span className="destaque__acao">
                      Ver catálogo <ArrowRight size={16} aria-hidden="true" />
                    </span>
                  </span>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      <section id="catalogo" className="catalogo" aria-labelledby="titulo-catalogo">
        <div className="catalogo__cabecalho">
          <div>
            <h2 id="titulo-catalogo">{meus ? 'Meus leilões' : 'Catálogo'}</h2>
            <p>
              {meus
                ? 'Tudo o que você anunciou, em qualquer estado.'
                : 'Em andamento primeiro; depois os que vão abrir. A lista se atualiza sozinha.'}
            </p>
          </div>
          {meus && <AcaoAnunciar kind="primary" />}
        </div>

        {!meus && (
          <div className="filtros">
            <div className="filtros__situacao" role="group" aria-label="Filtrar por situação">
              {FILTROS.map((f) => (
                <Button
                  key={f.id}
                  size="sm"
                  kind={filtro === f.id ? 'primary' : 'ghost'}
                  onClick={() => atualizar({ status: f.id === 'ATIVOS' ? null : f.id, pagina: null })}
                >
                  {f.rotulo}
                </Button>
              ))}
            </div>
            <div className="filtros__busca">
              <Search
                id="busca-leiloes"
                size="lg"
                labelText="Buscar leilões"
                placeholder="Buscar pelo nome do item"
                closeButtonLabelText="Limpar busca"
                value={textoBusca}
                onChange={(e) => setTextoBusca(e.target.value)}
                onClear={() => setTextoBusca('')}
              />
            </div>
            <div className="filtros__categoria">
              <Dropdown
                id="filtro-categoria"
                titleText="Categoria"
                label="Todas as categorias"
                items={categorias}
                itemToString={(item) => (item ? item.nome : '')}
                selectedItem={categoriaSelecionada}
                onChange={({ selectedItem }) => atualizar({ categoria: selectedItem?.id || null, pagina: null })}
              />
            </div>
            <p className="filtros__total" role="status">
              {dados ? `${dados.total} ${dados.total === 1 ? 'leilão' : 'leilões'}` : 'Carregando…'}
            </p>
          </div>
        )}

        {erro && !dados && (
          <Aviso tipo="erro" titulo="Não foi possível carregar o catálogo">
            {erro}{' '}
            <Button size="sm" kind="ghost" onClick={() => setTentativa((t) => t + 1)}>
              Tentar de novo
            </Button>
          </Aviso>
        )}

        {!dados && !erro && (
          <div className="grade-cartoes" aria-busy="true" aria-label="Carregando leilões">
            {Array.from({ length: 6 }, (_, i) => (
              <EsqueletoCartao key={i} />
            ))}
          </div>
        )}

        {semDados && (
          <EstadoVazio
            titulo={meus ? 'Você ainda não anunciou nada' : 'Nenhum leilão com esses filtros'}
            texto={
              meus
                ? 'Crie o primeiro anúncio para abrir uma sala ao vivo.'
                : 'Tente outra situação ou categoria. Novos leilões aparecem aqui assim que forem publicados.'
            }
            acao={
              meus ? (
                <AcaoAnunciar kind="primary" />
              ) : (
                <Button kind="tertiary" onClick={() => setBusca(new URLSearchParams(), { replace: true })}>
                  Limpar filtros
                </Button>
              )
            }
          />
        )}

        {dados && !semDados && (
          <div className="grade-cartoes">
            {dados.leiloes.map((l, i) => (
              <CartaoLeilao key={l.id} leilao={l} prioridade={i < 3} />
            ))}
          </div>
        )}

        {dados && paginas > 1 && (
          <div className="paginacao">
            <Pagination
              page={pagina}
              pageSize={dados.porPagina}
              pageSizes={[dados.porPagina]}
              totalItems={dados.total}
              onChange={({ page }) => atualizar({ pagina: String(page) })}
              itemsPerPageText="Itens por página"
              backwardText="Página anterior"
              forwardText="Próxima página"
              pageNumberText="Número da página"
              pageRangeText={(_, total) => `de ${total} páginas`}
            />
          </div>
        )}
      </section>
    </div>
  );
}
