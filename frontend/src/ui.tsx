import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderMenuItem,
  HeaderName,
  HeaderNavigation,
  InlineNotification,
  Modal,
  SideNav,
  SideNavItems,
  SideNavLink,
  SkeletonPlaceholder,
  SkeletonText,
  Tag,
} from '@carbon/react';
import {
  Add,
  ArrowLeft,
  ArrowRight,
  Catalog,
  ChartLineSmooth,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Logout,
  Timer,
} from '@carbon/icons-react';
import {
  api,
  dataHora,
  hora,
  infoStatus,
  reais,
  tempo,
  tempoPreciso,
  useAgora,
  useSaude,
  useSessao,
  type Resumo,
  type Status,
} from './comuns';

// ---------------------------------------------------------------------------
// Marca e casca do aplicativo
// ---------------------------------------------------------------------------
export function Marca({ compacta = false }: { compacta?: boolean }) {
  return (
    <Link to="/" className={`marca${compacta ? ' marca--compacta' : ''}`} aria-label="Cati Leilões, início">
      <span className="marca__nome">Cati</span>
      <span className="marca__descritor">Leilões</span>
    </Link>
  );
}

function RelogioServidor() {
  const agora = useAgora();
  return (
    <span className="topo__relogio" title="Hora do servidor">
      <Timer size={16} aria-hidden="true" />
      <span className="topo__relogio-texto">{new Date(agora).toLocaleTimeString('pt-BR')}</span>
      <span className="topo__relogio-rotulo">hora do servidor</span>
    </span>
  );
}

type ResultadoQueroVender = { pontuacao: number; minimo: number };

/** RF30: transforma a conta em comitente quando a pontuação permite. */
export function useQueroVender() {
  const { usuario, definir } = useSessao();
  const navegar = useNavigate();
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoQueroVender | null>(null);
  const [erro, setErro] = useState('');

  const fechar = useCallback(() => {
    setResultado(null);
    setErro('');
  }, []);

  const habilitar = useCallback(async () => {
    if (!usuario || carregando) return;
    setCarregando(true);
    setErro('');
    try {
      const r = await api<{ habilitado: boolean; pontuacao: number; minimo?: number }>('/eu/comitente', {
        metodo: 'POST',
        corpo: { habilitado: true },
      });
      if (r.habilitado) {
        definir({ ...usuario, comitente: true, pontuacao: r.pontuacao });
        navegar('/leiloes/novo');
      } else {
        setResultado({ pontuacao: r.pontuacao, minimo: r.minimo ?? 50 });
      }
    } catch (falha) {
      setErro((falha as Error).message);
    } finally {
      setCarregando(false);
    }
  }, [usuario, definir, navegar, carregando]);

  return { habilitar, carregando, resultado, erro, fechar };
}

export function ModalQueroVender({ estado }: { estado: ReturnType<typeof useQueroVender> }) {
  return (
    <Modal
      open={Boolean(estado.resultado || estado.erro)}
      modalHeading="Quero vender"
      primaryButtonText="Entendi"
      onRequestClose={estado.fechar}
      onRequestSubmit={estado.fechar}
    >
      {estado.erro ? (
        <p>{estado.erro}</p>
      ) : (
        <>
          <p>
            Sua pontuação é <strong>{estado.resultado?.pontuacao ?? 0} de 100</strong>.
          </p>
          <p>
            São necessários <strong>{estado.resultado?.minimo ?? 50} pontos</strong> para se habilitar como comitente.
            Dê lances e conclua compras para aumentar sua pontuação.
          </p>
        </>
      )}
    </Modal>
  );
}

/** Botão de anúncio: link para comitentes, "Quero vender" para quem ainda não é. */
export function AcaoAnunciar({
  kind = 'primary',
  size,
}: {
  kind?: 'primary' | 'tertiary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  const { usuario } = useSessao();
  const queroVender = useQueroVender();

  if (!usuario || usuario.comitente) {
    return (
      <Button as={Link} to="/leiloes/novo" kind={kind} size={size} renderIcon={Add}>
        Anunciar item
      </Button>
    );
  }

  return (
    <>
      <Button
        kind={kind}
        size={size}
        renderIcon={Add}
        onClick={() => void queroVender.habilitar()}
        disabled={queroVender.carregando}
      >
        {queroVender.carregando ? 'Verificando…' : 'Quero vender'}
      </Button>
      <ModalQueroVender estado={queroVender} />
    </>
  );
}

export function Cabecalho() {
  const { usuario, sair } = useSessao();
  const local = useLocation();
  const [menuAberto, setMenuAberto] = useState(false);
  const queroVender = useQueroVender();

  useEffect(() => setMenuAberto(false), [local.pathname]);

  const item = ({ isActive }: { isActive: boolean }) => ({ isActive });

  return (
    <>
      <Header aria-label="Cati Leilões" className="topo">
      <HeaderMenuButton
        aria-label={menuAberto ? 'Fechar menu' : 'Abrir menu'}
        isActive={menuAberto}
        onClick={() => setMenuAberto((v) => !v)}
      />
      <HeaderName as={Link} to="/" prefix="Cati">
        Leilões
      </HeaderName>
      <HeaderNavigation aria-label="Navegação principal" className="topo__nav">
        <HeaderMenuItem as={Link} to="/" {...item({ isActive: local.pathname === '/' })}>
          Leilões
        </HeaderMenuItem>
        <HeaderMenuItem
          as={Link}
          to="/comitentes"
          {...item({ isActive: local.pathname.startsWith('/comitentes') })}
        >
          Comitentes
        </HeaderMenuItem>
        {usuario && (
          <>
            <HeaderMenuItem
              as={Link}
              to="/meus-leiloes"
              {...item({ isActive: local.pathname === '/meus-leiloes' })}
            >
              Meus leilões
            </HeaderMenuItem>
            <HeaderMenuItem
              as={Link}
              to="/minhas-participacoes"
              {...item({ isActive: local.pathname === '/minhas-participacoes' })}
            >
              Participações
            </HeaderMenuItem>
            {usuario.comitente ? (
              <HeaderMenuItem
                as={Link}
                to="/leiloes/novo"
                {...item({ isActive: local.pathname === '/leiloes/novo' })}
              >
                Anunciar item
              </HeaderMenuItem>
            ) : (
              <HeaderMenuItem
                as="button"
                type="button"
                onClick={() => {
                  setMenuAberto(false);
                  void queroVender.habilitar();
                }}
                disabled={queroVender.carregando}
              >
                {queroVender.carregando ? 'Verificando…' : 'Quero vender'}
              </HeaderMenuItem>
            )}
          </>
        )}
      </HeaderNavigation>
      <HeaderGlobalBar className="topo__acoes">
        <RelogioServidor />
        {usuario ? (
          <>
            <Link className="topo__conta" to="/minha-conta" title="Minha conta: pontuação, crédito e compras">
              <span className="topo__pontuacao">
                <b>{usuario.pontuacao}</b> pts
              </span>
              <span className="topo__usuario">{usuario.nome}</span>
            </Link>
            <HeaderGlobalAction aria-label="Sair da conta" onClick={() => void sair()} tooltipAlignment="end">
              <Logout size={20} />
            </HeaderGlobalAction>
          </>
        ) : (
          <Link className="topo__entrar" to="/entrar">
            Entrar
          </Link>
        )}
      </HeaderGlobalBar>
      <SideNav
        aria-label="Menu principal"
        expanded={menuAberto}
        isPersistent={false}
        onOverlayClick={() => setMenuAberto(false)}
        className="topo__menu-lateral"
      >
        <SideNavItems>
          <SideNavLink as={Link} to="/" isActive={local.pathname === '/'} onClick={() => setMenuAberto(false)}>
            Leilões
          </SideNavLink>
          <SideNavLink
            as={Link}
            to="/comitentes"
            isActive={local.pathname.startsWith('/comitentes')}
            onClick={() => setMenuAberto(false)}
          >
            Comitentes
          </SideNavLink>
          {usuario && (
            <>
              <SideNavLink
                as={Link}
                to="/meus-leiloes"
                isActive={local.pathname === '/meus-leiloes'}
                onClick={() => setMenuAberto(false)}
              >
                Meus leilões
              </SideNavLink>
              <SideNavLink
                as={Link}
                to="/minhas-participacoes"
                isActive={local.pathname === '/minhas-participacoes'}
                onClick={() => setMenuAberto(false)}
              >
                Participações
              </SideNavLink>
              {usuario.comitente ? (
                <SideNavLink
                  as={Link}
                  to="/leiloes/novo"
                  isActive={local.pathname === '/leiloes/novo'}
                  onClick={() => setMenuAberto(false)}
                >
                  Anunciar item
                </SideNavLink>
              ) : (
                <SideNavLink
                  as="button"
                  type="button"
                  onClick={() => {
                    setMenuAberto(false);
                    void queroVender.habilitar();
                  }}
                  disabled={queroVender.carregando}
                >
                  {queroVender.carregando ? 'Verificando…' : 'Quero vender'}
                </SideNavLink>
              )}
              <SideNavLink
                as={Link}
                to="/minha-conta"
                isActive={local.pathname === '/minha-conta'}
                onClick={() => setMenuAberto(false)}
              >
                Minha conta · {usuario.pontuacao} pts
              </SideNavLink>
            </>
          )}
          {!usuario && (
            <SideNavLink as={Link} to="/entrar" onClick={() => setMenuAberto(false)}>
              Entrar
            </SideNavLink>
          )}
        </SideNavItems>
      </SideNav>
      </Header>
      <ModalQueroVender estado={queroVender} />
    </>
  );
}

export function Rodape() {
  const noAr = useSaude();
  return (
    <footer className="rodape">
      <div className="rodape__interno">
        <div className="rodape__marca">
          <Marca compacta />
          <p>Leilões ao vivo, com lances em tempo real e fechamento automático.</p>
        </div>
        <nav className="rodape__links" aria-label="Rodapé">
          <Link to="/">Leilões</Link>
          <Link to="/comitentes">Comitentes</Link>
          <Link to="/meus-leiloes">Meus leilões</Link>
          <Link to="/minhas-participacoes">Participações</Link>
          <Link to="/minha-conta">Minha conta</Link>
          <Link to="/leiloes/novo">Anunciar item</Link>
        </nav>
        <div className="rodape__estado" role="status">
          <Tag type={noAr === false ? 'red' : 'green'} size="sm">
            {noAr === null ? 'Verificando sistema' : noAr ? 'Sistema no ar' : 'Sistema indisponível'}
          </Tag>
          <span>Hackathon Cati, dados de demonstração</span>
        </div>
      </div>
    </footer>
  );
}

export function IrParaConteudo() {
  return (
    <a className="pular" href="#conteudo">
      Pular para o conteúdo
    </a>
  );
}

// ---------------------------------------------------------------------------
// Peças de interface
// ---------------------------------------------------------------------------
export function Selo({ status, size = 'sm' }: { status: Status | string; size?: 'sm' | 'md' | 'lg' }) {
  const info = infoStatus(status);
  return (
    <Tag as="span" type={info.tag} size={size}>
      {info.rotulo}
    </Tag>
  );
}

export function Contador({
  status,
  inicioEm,
  terminoEm,
  preciso = false,
  prefixo,
}: {
  status: Status | string;
  inicioEm: string;
  terminoEm: string;
  preciso?: boolean;
  prefixo?: string;
}) {
  const agora = useAgora();
  let alvo: string | null = null;
  let rotulo = '';
  if (status === 'AGENDADO') {
    alvo = inicioEm;
    rotulo = 'Abre em';
  } else if (status === 'EM_ANDAMENTO') {
    alvo = terminoEm;
    rotulo = 'Termina em';
  }
  if (!alvo) return null;
  const ms = new Date(alvo).getTime() - agora;
  const texto = ms <= 0 ? 'Encerrando…' : preciso ? tempoPreciso(ms) : tempo(ms);
  return (
    <span className="contador" aria-label={`${rotulo} ${dataHora(alvo)}, pelo relógio do servidor`}>
      {prefixo !== '' && <span className="contador__rotulo">{prefixo ?? rotulo}</span>}
      <span className={`contador__valor${ms > 0 && ms < 60_000 ? ' contador__valor--urgente' : ''}`}>{texto}</span>
    </span>
  );
}

export function Aviso({
  tipo = 'erro',
  titulo,
  children,
  onFechar,
  baixoContraste = true,
  className,
}: {
  tipo?: 'erro' | 'ok' | 'info' | 'alerta';
  titulo?: string;
  children?: ReactNode;
  onFechar?: () => void;
  baixoContraste?: boolean;
  className?: string;
}) {
  const kind = tipo === 'erro' ? 'error' : tipo === 'ok' ? 'success' : tipo === 'alerta' ? 'warning' : 'info';
  const padrao = tipo === 'erro' ? 'Não foi possível concluir' : tipo === 'ok' ? 'Tudo certo' : tipo === 'alerta' ? 'Atenção' : 'Informação';
  return (
    <InlineNotification
      className={className}
      kind={kind}
      title={titulo ?? padrao}
      subtitle={typeof children === 'string' ? children : undefined}
      lowContrast={baixoContraste}
      hideCloseButton={!onFechar}
      onCloseButtonClick={onFechar}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {typeof children === 'string' ? undefined : children}
    </InlineNotification>
  );
}

export function EstadoVazio({
  titulo,
  texto,
  acao,
}: {
  titulo: string;
  texto: string;
  acao?: ReactNode;
}) {
  return (
    <div className="vazio">
      <span className="vazio__icone" aria-hidden="true">
        <Catalog size={32} />
      </span>
      <h2>{titulo}</h2>
      <p>{texto}</p>
      {acao && <div className="vazio__acao">{acao}</div>}
    </div>
  );
}

export function EsqueletoCartao() {
  return (
    <div className="cartao cartao--esqueleto" aria-hidden="true">
      <SkeletonPlaceholder className="cartao__esqueleto-imagem" />
      <div className="cartao__corpo">
        <SkeletonText width="40%" />
        <SkeletonText heading width="90%" />
        <SkeletonText width="55%" />
        <SkeletonText width="70%" />
      </div>
    </div>
  );
}

/**
 * Quanto do leilão já passou, de 0 a 1, pelo relógio do servidor. É só visual:
 * com prorrogação o término anda e a barra recua um pouco.
 */
export function useDecorrido(inicioEm: string, terminoEm: string): number {
  const agora = useAgora();
  const inicio = new Date(inicioEm).getTime();
  const fim = new Date(terminoEm).getTime();
  if (fim <= inicio) return 1;
  return Math.max(0, Math.min(1, (agora - inicio) / (fim - inicio)));
}

/** Barra fina de tempo: enche até o término e fica vermelha no último minuto. */
export function BarraTempo({ inicioEm, terminoEm, inversa = false }: { inicioEm: string; terminoEm: string; inversa?: boolean }) {
  const agora = useAgora();
  const decorrido = useDecorrido(inicioEm, terminoEm);
  const restante = new Date(terminoEm).getTime() - agora;
  const urgente = restante > 0 && restante < 60_000;
  return (
    <span className={`tempo-barra${inversa ? ' tempo-barra--inversa' : ''}${urgente ? ' tempo-barra--urgente' : ''}`} aria-hidden="true">
      <span style={{ width: `${decorrido * 100}%` }} />
    </span>
  );
}

export function CartaoLeilao({ leilao, prioridade = false }: { leilao: Resumo; prioridade?: boolean }) {
  const info = infoStatus(leilao.status);
  const preco = leilao.precoAtualCentavos ?? leilao.precoInicialCentavos;
  const aoVivo = leilao.status === 'EM_ANDAMENTO';
  return (
    <Link
      to={`/leiloes/${leilao.id}`}
      className={`cartao${info.final ? ' cartao--final' : ''}`}
      aria-label={`${leilao.item.nome}, ${info.rotulo}, ${reais(preco)}`}
    >
      <div className="cartao__media">
        {leilao.item.fotoUrl ? (
          <img
            src={leilao.item.fotoUrl}
            alt=""
            loading={prioridade ? 'eager' : 'lazy'}
            className="cartao__imagem"
          />
        ) : (
          <span className="cartao__sem-foto">
            <ImageIcon size={28} aria-hidden="true" />
            <span>Sem foto</span>
          </span>
        )}
        <span className="cartao__selo">
          {aoVivo ? (
            <span className="selo-vivo">
              <span className="selo-vivo__ponto" aria-hidden="true" />
              Ao vivo
            </span>
          ) : (
            <Selo status={leilao.status} />
          )}
        </span>
        {!info.final && (
          <span className="cartao__chamada" aria-hidden="true">
            {aoVivo ? 'Entrar na disputa' : 'Ver leilão'} <ArrowRight size={16} />
          </span>
        )}
        {aoVivo && <BarraTempo inicioEm={leilao.inicioEm} terminoEm={leilao.terminoEm} />}
      </div>
      <div className="cartao__corpo">
        <p className="cartao__categoria">{leilao.item.categoriaNome}</p>
        <h3 className="cartao__titulo">{leilao.item.nome}</h3>
        <p className="cartao__preco-rotulo">
          {leilao.status === 'VENDIDO' ? 'Vendido por' : leilao.totalLances > 0 ? 'Lance atual' : 'Lance inicial'}
        </p>
        <p className="cartao__preco">{reais(preco)}</p>
        <div className="cartao__meta">
          <Contador status={leilao.status} inicioEm={leilao.inicioEm} terminoEm={leilao.terminoEm} />
          <span className="cartao__lances">
            <ChartLineSmooth size={14} aria-hidden="true" />
            {leilao.totalLances} {leilao.totalLances === 1 ? 'lance' : 'lances'}
          </span>
        </div>
        <p className="cartao__comitente">Comitente: {leilao.comitente.nome}</p>
      </div>
    </Link>
  );
}

export function GaleriaFotos({
  fotos,
  nome,
  compacta = false,
}: {
  fotos: Array<{ id: number; url: string }>;
  nome: string;
  compacta?: boolean;
}) {
  const [atual, setAtual] = useState(0);
  useEffect(() => {
    setAtual((i) => Math.min(i, Math.max(0, fotos.length - 1)));
  }, [fotos.length]);

  if (fotos.length === 0) {
    return (
      <div className={`galeria galeria--vazia${compacta ? ' galeria--compacta' : ''}`}>
        <span>
          <ImageIcon size={36} aria-hidden="true" />
          <span>Sem fotos deste item</span>
        </span>
      </div>
    );
  }

  const foto = fotos[Math.min(atual, fotos.length - 1)];
  const ir = (delta: number) => setAtual((i) => (i + delta + fotos.length) % fotos.length);

  return (
    <div className={`galeria${compacta ? ' galeria--compacta' : ''}`}>
      <div className="galeria__principal">
        <img src={foto.url} alt={`${nome}, foto ${atual + 1} de ${fotos.length}`} className="galeria__imagem" />
        {fotos.length > 1 && (
          <>
            <Button
              className="galeria__seta galeria__seta--esquerda"
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={ChevronLeft}
              iconDescription="Foto anterior"
              onClick={() => ir(-1)}
            />
            <Button
              className="galeria__seta galeria__seta--direita"
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={ChevronRight}
              iconDescription="Próxima foto"
              onClick={() => ir(1)}
            />
          </>
        )}
        <span className="galeria__contagem">
          {atual + 1} / {fotos.length}
        </span>
      </div>
      {fotos.length > 1 && (
        <div className="galeria__miniaturas">
          {fotos.map((f, i) => (
            <button
              key={f.id}
              type="button"
              aria-label={`Ver foto ${i + 1}`}
              aria-pressed={i === atual}
              className={`galeria__miniatura${i === atual ? ' galeria__miniatura--ativa' : ''}`}
              onClick={() => setAtual(i)}
            >
              <img src={f.url} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function VoltarLink({ para, children = 'Voltar' }: { para: string; children?: ReactNode }) {
  return (
    <Link className="voltar" to={para}>
      <ArrowLeft size={16} aria-hidden="true" />
      {children}
    </Link>
  );
}

export function LinkSeta({ para, children }: { para: string; children: ReactNode }) {
  return (
    <Link className="link-seta" to={para}>
      {children}
      <ArrowRight size={16} aria-hidden="true" />
    </Link>
  );
}

export function Hora({ iso }: { iso: string }) {
  return <span className="hora">{hora(iso)}</span>;
}
