import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Pagination, Tag } from '@carbon/react';
import { ArrowRight, Image as ImageIcon } from '@carbon/icons-react';
import {
  api,
  dataHora,
  reais,
  tempoPreciso,
  useAgora,
  useTitulo,
  type Participacao,
  type SituacaoParticipacao,
} from './comuns';
import { Aviso, EstadoVazio, Selo } from './ui';

const SITUACOES: Array<{ id: 'TODAS' | SituacaoParticipacao; rotulo: string }> = [
  { id: 'TODAS', rotulo: 'Todas' },
  { id: 'LIDER', rotulo: 'Liderando' },
  { id: 'SUPERADO', rotulo: 'Superado' },
  { id: 'VENCEDOR', rotulo: 'Vencedor' },
  { id: 'NAO_VENCEU', rotulo: 'Não venceu' },
];

const TAG_SITUACAO: Record<SituacaoParticipacao, { tipo: 'green' | 'warm-gray' | 'purple' | 'gray'; rotulo: string }> = {
  LIDER: { tipo: 'green', rotulo: 'Liderando' },
  SUPERADO: { tipo: 'warm-gray', rotulo: 'Superado' },
  VENCEDOR: { tipo: 'purple', rotulo: 'Vencedor' },
  NAO_VENCEU: { tipo: 'gray', rotulo: 'Não venceu' },
};

/** RF27: leilões em que o usuário deu lance. */
export function MinhasParticipacoes() {
  useTitulo('Minhas participações');
  const [dados, setDados] = useState<Participacao[] | null>(null);
  const [erro, setErro] = useState('');
  const [situacao, setSituacao] = useState<'TODAS' | SituacaoParticipacao>('TODAS');
  const [pagina, setPagina] = useState(1);
  const agora = useAgora();

  useEffect(() => {
    let vivo = true;
    const carregar = () =>
      api<{ participacoes: Participacao[] }>('/eu/participacoes')
        .then((r) => {
          if (!vivo) return;
          setDados(r.participacoes);
          setErro('');
        })
        .catch((e) => vivo && setErro(e.message));
    void carregar();
    const t = setInterval(carregar, 8000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  const filtradas = useMemo(
    () => (dados ?? []).filter((p) => situacao === 'TODAS' || p.situacao === situacao),
    [dados, situacao],
  );
  const porPagina = 8;
  const paginas = Math.max(1, Math.ceil(filtradas.length / porPagina));
  const visiveis = filtradas.slice((pagina - 1) * porPagina, pagina * porPagina);

  function mudarFiltro(nova: 'TODAS' | SituacaoParticipacao) {
    setSituacao(nova);
    setPagina(1);
  }

  return (
    <div className="pagina">
      <div className="catalogo__cabecalho">
        <div>
          <h1>Minhas participações</h1>
          <p>Leilões em que você deu lance, com a sua situação em cada um.</p>
        </div>
        <Button as={Link} to="/" kind="tertiary" renderIcon={ArrowRight}>
          Ver catálogo
        </Button>
      </div>

      {erro && (
        <Aviso tipo="erro" titulo="Não foi possível carregar suas participações">
          {erro}
        </Aviso>
      )}

      <div className="filtros filtros--simples">
        <div className="filtros__situacao" role="group" aria-label="Filtrar por situação">
          {SITUACOES.map((s) => (
            <Button
              key={s.id}
              size="sm"
              kind={situacao === s.id ? 'primary' : 'ghost'}
              onClick={() => mudarFiltro(s.id)}
            >
              {s.rotulo}
            </Button>
          ))}
        </div>
        <p className="filtros__total" role="status">
          {dados ? `${filtradas.length} ${filtradas.length === 1 ? 'participação' : 'participações'}` : 'Carregando…'}
        </p>
      </div>

      {!dados && !erro && <p className="carregando">Carregando participações…</p>}

      {dados && filtradas.length === 0 && (
        <EstadoVazio
          titulo={dados.length === 0 ? 'Você ainda não deu lance' : 'Nenhuma participação com esse filtro'}
          texto={
            dados.length === 0
              ? 'Entre em uma sala ao vivo e dê o primeiro lance. Suas participações aparecem aqui.'
              : 'Tente outra situação para ver seus outros leilões.'
          }
          acao={
            <Button as={Link} to="/" kind="primary" renderIcon={ArrowRight}>
              Ver leilões
            </Button>
          }
        />
      )}

      {visiveis.length > 0 && (
        <ul className="participacoes">
          {visiveis.map((p) => {
            const tag = TAG_SITUACAO[p.situacao];
            const restante = new Date(p.terminoEm).getTime() - agora;
            return (
              <li key={p.leilaoId}>
                <Link className="participacao" to={`/leiloes/${p.leilaoId}`}>
                  <span className="participacao__media">
                    {p.item.fotoUrl ? (
                      <img src={p.item.fotoUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="participacao__sem-foto">
                        <ImageIcon size={24} aria-hidden="true" />
                      </span>
                    )}
                  </span>
                  <span className="participacao__corpo">
                    <span className="participacao__topo">
                      <Selo status={p.status} />
                      <Tag type={tag.tipo} size="sm">
                        {tag.rotulo}
                      </Tag>
                    </span>
                    <strong className="participacao__nome">{p.item.nome}</strong>
                    <span className="participacao__meta">
                      Seu maior lance: <b>{reais(p.meuMaiorLanceCentavos)}</b>
                      <span className="participacao__separador">/</span>
                      {p.meusLances} {p.meusLances === 1 ? 'lance seu' : 'lances seus'}
                    </span>
                    <span className="participacao__meta">
                      {p.status === 'EM_ANDAMENTO'
                        ? restante > 0
                          ? `Termina em ${tempoPreciso(restante)}`
                          : 'Encerrando…'
                        : `Encerrado em ${dataHora(p.encerradoEm ?? p.terminoEm)}`}
                    </span>
                  </span>
                  <span className="participacao__preco">
                    <small>{p.status === 'EM_ANDAMENTO' ? 'Preço atual' : 'Preço final'}</small>
                    <b>{reais(p.precoAtualCentavos)}</b>
                    <small>{p.totalLances} lances no total</small>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {paginas > 1 && (
        <div className="paginacao">
          <Pagination
            page={pagina}
            pageSize={porPagina}
            pageSizes={[porPagina]}
            totalItems={filtradas.length}
            onChange={({ page }) => setPagina(page)}
            itemsPerPageText="Itens por página"
            backwardText="Página anterior"
            forwardText="Próxima página"
            pageNumberText="Número da página"
            pageRangeText={(_, total) => `de ${total} páginas`}
          />
        </div>
      )}
    </div>
  );
}
