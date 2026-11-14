import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Pagination, Search, Tag } from '@carbon/react';
import { ArrowRight, Catalog, User } from '@carbon/icons-react';
import {
  api,
  dataHora,
  useTitulo,
  type ComitenteResumo,
  type PerfilComitente,
} from './comuns';
import { Aviso, CartaoLeilao, EstadoVazio, VoltarLink } from './ui';

/** RF22: busca de comitentes por nome de exibição. */
export function BuscaComitentes() {
  useTitulo('Comitentes');
  const [texto, setTexto] = useState('');
  const [dados, setDados] = useState<ComitenteResumo[] | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    let vivo = true;
    const t = setTimeout(() => {
      api<{ comitentes: ComitenteResumo[] }>(`/comitentes?q=${encodeURIComponent(texto.trim())}`)
        .then((r) => {
          if (!vivo) return;
          setDados(r.comitentes);
          setErro('');
        })
        .catch((e) => vivo && setErro(e.message));
    }, 300);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [texto]);

  return (
    <div className="pagina pagina--estreita">
      <div className="detalhe__trilha">
        <VoltarLink para="/">Catálogo</VoltarLink>
        <span aria-hidden="true">/</span>
        <span>Comitentes</span>
      </div>

      <div className="novo__cabecalho">
        <h1>Comitentes</h1>
        <p>Quem anuncia no Cati Leilões. Abra o perfil para ver os leilões de cada pessoa.</p>
      </div>

      <div className="comitentes__busca">
        <Search
          id="busca-comitentes"
          size="lg"
          labelText="Buscar comitentes"
          placeholder="Buscar pelo nome de exibição"
          closeButtonLabelText="Limpar busca"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onClear={() => setTexto('')}
        />
      </div>

      {erro && (
        <Aviso tipo="erro" titulo="Não foi possível buscar comitentes">
          {erro}
        </Aviso>
      )}

      {!dados && !erro && <p className="carregando">Buscando comitentes…</p>}

      {dados && dados.length === 0 && (
        <EstadoVazio
          titulo="Nenhum comitente encontrado"
          texto={texto ? `Nada para “${texto}”. Tente outro nome.` : 'Ainda não há comitentes com leilões publicados.'}
        />
      )}

      {dados && dados.length > 0 && (
        <ul className="comitentes">
          {dados.map((c) => (
            <li key={c.id}>
              <Link className="comitente-linha" to={`/comitentes/${c.id}`}>
                <span className="comitente-linha__avatar" aria-hidden="true">
                  {c.nome.trim().charAt(0).toUpperCase() || <User size={18} />}
                </span>
                <span className="comitente-linha__texto">
                  <strong>{c.nome}</strong>
                  <small>
                    No Cati desde {dataHora(c.desde)}
                    <span> / </span>
                    {c.leiloes} {c.leiloes === 1 ? 'leilão publicado' : 'leilões publicados'}
                  </small>
                </span>
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Secao({ titulo, leiloes }: { titulo: string; leiloes: PerfilComitente['agendados'] }) {
  if (!leiloes.length) return null;
  return (
    <section className="perfil__secao">
      <h2>{titulo}</h2>
      <div className="grade-cartoes">
        {leiloes.map((l) => (
          <CartaoLeilao key={l.id} leilao={l} />
        ))}
      </div>
    </section>
  );
}

/** RF22: perfil público do comitente, sem e-mail e sem reputação. */
export function PerfilDoComitente() {
  const { id } = useParams();
  const [busca, setBusca] = useSearchParams();
  const pagina = Math.max(1, Number(busca.get('pagina') ?? 1) || 1);
  const [perfil, setPerfil] = useState<PerfilComitente | null>(null);
  const [erro, setErro] = useState('');
  const [tentativa, setTentativa] = useState(0);

  useTitulo(perfil?.comitente.nome ?? 'Comitente');

  useEffect(() => {
    let vivo = true;
    api<PerfilComitente>(`/comitentes/${id}?pagina=${pagina}`)
      .then((r) => {
        if (!vivo) return;
        setPerfil(r);
        setErro('');
      })
      .catch((e) => vivo && setErro(e.message));
    return () => {
      vivo = false;
    };
  }, [id, pagina, tentativa]);

  if (!perfil) {
    return (
      <div className="pagina pagina--estreita">
        <VoltarLink para="/comitentes">Comitentes</VoltarLink>
        {erro ? (
          <>
            <Aviso tipo="erro" titulo="Comitente indisponível">
              {erro}
            </Aviso>
            <button className="link-inline" type="button" onClick={() => setTentativa((t) => t + 1)}>
              Tentar de novo
            </button>
          </>
        ) : (
          <p className="carregando">Carregando perfil…</p>
        )}
      </div>
    );
  }

  const total = perfil.emAndamento.length + perfil.agendados.length + perfil.passados.total;
  const paginas = Math.max(1, Math.ceil(perfil.passados.total / perfil.passados.porPagina));

  return (
    <div className="pagina">
      <div className="detalhe__trilha">
        <VoltarLink para="/comitentes">Comitentes</VoltarLink>
        <span aria-hidden="true">/</span>
        <span>{perfil.comitente.nome}</span>
      </div>

      <header className="perfil__cabecalho">
        <span className="comitente-linha__avatar comitente-linha__avatar--grande" aria-hidden="true">
          {perfil.comitente.nome.trim().charAt(0).toUpperCase()}
        </span>
        <div>
          <h1>{perfil.comitente.nome}</h1>
          <p>No Cati desde {dataHora(perfil.comitente.desde)}.</p>
          <div className="perfil__contagens">
            <Tag type="green" size="sm">
              {perfil.emAndamento.length} em andamento
            </Tag>
            <Tag type="blue" size="sm">
              {perfil.agendados.length} agendados
            </Tag>
            <Tag type="gray" size="sm">
              {perfil.passados.total} encerrados
            </Tag>
          </div>
        </div>
      </header>

      {erro && (
        <Aviso tipo="erro" titulo="Não foi possível atualizar o perfil">
          {erro}
        </Aviso>
      )}

      {total === 0 ? (
        <EstadoVazio
          titulo="Nenhum leilão publicado"
          texto="Este comitente ainda não tem leilões no catálogo."
          acao={
            <Link className="link-seta" to="/comitentes">
              Ver outros comitentes <ArrowRight size={16} aria-hidden="true" />
            </Link>
          }
        />
      ) : (
        <>
          <Secao titulo="Em andamento" leiloes={perfil.emAndamento} />
          <Secao titulo="Agendados" leiloes={perfil.agendados} />
          <Secao titulo="Encerrados" leiloes={perfil.passados.leiloes} />

          {paginas > 1 && (
            <div className="paginacao">
              <Pagination
                page={pagina}
                pageSize={perfil.passados.porPagina}
                pageSizes={[perfil.passados.porPagina]}
                totalItems={perfil.passados.total}
                onChange={({ page }) => {
                  const proximo = new URLSearchParams(busca);
                  proximo.set('pagina', String(page));
                  setBusca(proximo, { replace: true });
                }}
                itemsPerPageText="Itens por página"
                backwardText="Página anterior"
                forwardText="Próxima página"
                pageNumberText="Número da página"
                pageRangeText={(_, totalPaginas) => `de ${totalPaginas} páginas`}
              />
            </div>
          )}
        </>
      )}

      <div className="perfil__rodape">
        <Catalog size={16} aria-hidden="true" />
        <Link className="link-seta" to="/">
          Ver catálogo completo <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
