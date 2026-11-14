import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Accordion, AccordionItem, Button, Modal } from '@carbon/react';
import { ArrowRight, Edit, Renew, Time, User } from '@carbon/icons-react';
import {
  api,
  dataHora,
  fusoLocal,
  reais,
  useSessao,
  useTitulo,
  type Leilao,
} from './comuns';
import { Aviso, Contador, GaleriaFotos, Selo, VoltarLink } from './ui';

export function TextoResultado({
  leilao,
}: {
  leilao: { resultado: any; eu?: { venci?: boolean; vencedorNome?: string | null } | null };
}) {
  const r = leilao.resultado;
  if (!r) return null;
  if (r.tipo === 'VENDIDO') {
    return (
      <Aviso tipo="ok" titulo="Leilão vendido">
        Vencedor: {r.vencedor.apelido}, por {reais(r.valorCentavos)}.
        {leilao.eu?.venci && ' Você venceu este leilão!'}
        {leilao.eu?.vencedorNome && ` Comprador: ${leilao.eu.vencedorNome}.`}
      </Aviso>
    );
  }
  if (r.tipo === 'ENCERRADO_SEM_LANCES') {
    return (
      <Aviso tipo="info" titulo="Encerrado sem lances">
        O prazo terminou e nenhum lance foi dado. O item pode ser relistado pelo comitente.
      </Aviso>
    );
  }
  return (
    <Aviso tipo="info" titulo="Leilão cancelado">
      O comitente cancelou este leilão. Ele continua registrado no histórico.
    </Aviso>
  );
}

function Ficha({ leilao }: { leilao: Leilao }) {
  return (
    <>
      <dl className="ficha">
        <div>
          <dt>
            <User size={14} aria-hidden="true" /> Comitente
          </dt>
          <dd>
            <Link className="link-inline" to={`/comitentes/${leilao.comitente.id}`}>
              {leilao.comitente.nome}
            </Link>
          </dd>
        </div>
        <div>
          <dt>Lance mínimo</dt>
          <dd>{reais(leilao.lanceMinimoCentavos)}</dd>
        </div>
        <div>
          <dt>Início</dt>
          <dd>{dataHora(leilao.inicioEm)}</dd>
        </div>
        <div>
          <dt>Término{leilao.prorrogado ? ' (prorrogado)' : ''}</dt>
          <dd>{dataHora(leilao.terminoEm)}</dd>
        </div>
        <div>
          <dt>Total de lances</dt>
          <dd>{leilao.totalLances}</dd>
        </div>
        <div>
          <dt>Líder</dt>
          <dd>{leilao.lider ? leilao.lider.apelido : '—'}</dd>
        </div>
      </dl>
      <p className="ficha__nota">Horários no seu fuso ({fusoLocal}). O relógio que vale é o do servidor.</p>
    </>
  );
}

/** Detalhe público do leilão; daqui se entra na sala. */
export function Detalhe() {
  const { id } = useParams();
  const { usuario } = useSessao();
  const local = useLocation();
  const [leilao, setLeilao] = useState<Leilao | null>(null);
  const [erro, setErro] = useState('');
  const [cancelando, setCancelando] = useState(false);
  const [modalCancelar, setModalCancelar] = useState(false);
  const [cancelado, setCancelado] = useState(false);
  const [criado, setCriado] = useState(Boolean((local.state as { criado?: boolean } | null)?.criado));
  const [sucesso, setSucesso] = useState<'editado' | 'relistado' | null>(
    (local.state as { editado?: boolean } | null)?.editado
      ? 'editado'
      : (local.state as { relistado?: boolean } | null)?.relistado
        ? 'relistado'
        : null,
  );

  useTitulo(leilao?.item.nome ?? 'Leilão');

  const carregar = useCallback(
    () =>
      api<{ leilao: Leilao }>(`/leiloes/${id}`)
        .then((r) => {
          setLeilao(r.leilao);
          setErro('');
        })
        .catch((e) => setErro(e.message)),
    [id],
  );

  useEffect(() => {
    void carregar();
    const t = setInterval(carregar, 4000);
    return () => clearInterval(t);
  }, [carregar, usuario]);

  async function cancelar() {
    setCancelando(true);
    try {
      const r = await api<{ leilao: Leilao }>(`/leiloes/${id}/cancelar`, { metodo: 'POST' });
      setLeilao(r.leilao);
      setCancelado(true);
      setModalCancelar(false);
      setErro('');
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setCancelando(false);
    }
  }

  if (!leilao) {
    return (
      <div className="pagina pagina--estreita">
        <VoltarLink para="/">Catálogo</VoltarLink>
        {erro ? <Aviso tipo="erro" titulo="Leilão indisponível">{erro}</Aviso> : <p className="carregando">Carregando leilão…</p>}
      </div>
    );
  }

  const ativo = leilao.status === 'AGENDADO' || leilao.status === 'EM_ANDAMENTO';
  const preco = leilao.precoAtualCentavos ?? leilao.precoInicialCentavos;

  return (
    <div className="pagina">
      <div className="detalhe__trilha">
        <VoltarLink para="/">Catálogo</VoltarLink>
        <span aria-hidden="true">/</span>
        <span>{leilao.item.categoriaNome}</span>
      </div>

      {criado && (
        <Aviso tipo="ok" titulo="Leilão publicado" onFechar={() => setCriado(false)}>
          O anúncio está no catálogo. A sala abre sozinha no horário marcado.
        </Aviso>
      )}
      {cancelado && (
        <Aviso tipo="ok" titulo="Leilão cancelado">
          O leilão continua registrado no histórico, com o estado Cancelado.
        </Aviso>
      )}
      {sucesso === 'editado' && (
        <Aviso tipo="ok" titulo="Leilão atualizado" onFechar={() => setSucesso(null)}>
          As alterações já aparecem no catálogo e na sala.
        </Aviso>
      )}
      {sucesso === 'relistado' && (
        <Aviso tipo="ok" titulo="Item relistado" onFechar={() => setSucesso(null)}>
          O novo leilão foi publicado. O anúncio anterior continua no histórico.
        </Aviso>
      )}
      {erro && (
        <Aviso tipo="erro" titulo="Não foi possível atualizar">
          {erro}
        </Aviso>
      )}

      <article className="detalhe">
        <div className="detalhe__galeria">
          <GaleriaFotos fotos={leilao.item.fotos} nome={leilao.item.nome} />
        </div>

        <div className="detalhe__info">
          <div className="detalhe__topo">
            <Selo status={leilao.status} size="md" />
            <span className="detalhe__categoria">{leilao.item.categoriaNome}</span>
          </div>

          <h1>{leilao.item.nome}</h1>
          <p className="detalhe__descricao">{leilao.item.descricao}</p>

          <section className={`painel-preco painel-preco--${ativo ? 'ativo' : 'final'}`} aria-label="Preço e prazo">
            <div className="painel-preco__topo">
              <span>{leilao.precoAtualCentavos === null ? 'Preço inicial' : 'Preço atual'}</span>
              {leilao.status === 'EM_ANDAMENTO' && (
                <span className="painel-preco__vivo">
                  <span className="pulso" aria-hidden="true" /> Ao vivo
                </span>
              )}
            </div>
            <p className="painel-preco__valor">{reais(preco)}</p>
            {ativo ? (
              <Contador
                status={leilao.status}
                inicioEm={leilao.inicioEm}
                terminoEm={leilao.terminoEm}
                preciso
                prefixo={leilao.status === 'AGENDADO' ? 'Abre em' : 'Termina em'}
              />
            ) : (
              <p className="painel-preco__encerrado">Leilão encerrado</p>
            )}
            <div className="painel-preco__rodape">
              <span>
                <Time size={14} aria-hidden="true" /> {leilao.totalLances}{' '}
                {leilao.totalLances === 1 ? 'lance' : 'lances'}
              </span>
              {leilao.prorrogado && <span className="painel-preco__prorrogado">Término prorrogado</span>}
            </div>
          </section>

          <Ficha leilao={leilao} />
          <TextoResultado leilao={leilao} />

          <div className="detalhe__acoes">
            {ativo && (
              <Button as={Link} to={`/leiloes/${leilao.id}/sala`} kind="primary" renderIcon={ArrowRight}>
                {usuario ? 'Entrar na sala' : 'Entrar na sala (exige login)'}
              </Button>
            )}
            {leilao.eu?.edicao && leilao.eu.edicao !== 'NADA' && (
              <Button as={Link} to={`/leiloes/${leilao.id}/editar`} kind="tertiary" renderIcon={Edit}>
                {leilao.eu.edicao === 'ACRESCENTAR_DESCRICAO' ? 'Complementar descrição' : 'Editar leilão'}
              </Button>
            )}
            {leilao.eu?.podeRelistar && (
              <Button as={Link} to={`/leiloes/${leilao.id}/relistar`} kind="tertiary" renderIcon={Renew}>
                Relistar item
              </Button>
            )}
            {leilao.eu?.podeCancelar && (
              <Button kind="danger--tertiary" onClick={() => setModalCancelar(true)} disabled={cancelando}>
                Cancelar leilão
              </Button>
            )}
          </div>

          {leilao.eu?.souComitente && leilao.totalLances > 0 && ativo && (
            <p className="detalhe__nota">Um leilão com lances não pode mais ser cancelado.</p>
          )}
          {leilao.eu?.souComitente && (
            <p className="detalhe__nota">Você é o comitente deste leilão: acompanha a disputa, mas não pode dar lance.</p>
          )}
        </div>
      </article>

      <section className="detalhe__regras" aria-labelledby="titulo-regras">
        <h2 id="titulo-regras">Como este leilão funciona</h2>
        <Accordion>
          <AccordionItem title="Lance mínimo e incremento">
            O primeiro lance pode ser igual ao preço inicial. Depois, cada lance precisa cobrir o preço atual mais o
            incremento da faixa: R$ 1 até R$ 99,99; R$ 5 até R$ 499,99; R$ 10 até R$ 999,99; R$ 50 até R$ 4.999,99; R$
            100 até R$ 24.999,99; R$ 500 a partir de R$ 25.000,00.
          </AccordionItem>
          <AccordionItem title="Prorrogação nos últimos minutos">
            Um lance feito com menos de 2 minutos no relógio do servidor leva o término para 2 minutos depois desse
            lance. A prorrogação acumulada tem limite de 30 minutos.
          </AccordionItem>
          <AccordionItem title="Quem pode dar lance">
            Qualquer pessoa com sessão válida, exceto o comitente e o líder atual. O lance é irrevogável: não existe
            desfazer. Quem chega primeiro tem prioridade em lances simultâneos.
          </AccordionItem>
          <AccordionItem title="Relógio e fechamento">
            O horário que vale é o do servidor. A contagem na tela é só visual. Ao terminar, o leilão vira Vendido (com
            lances) ou Encerrado sem lances, e essas transições não voltam atrás.
          </AccordionItem>
        </Accordion>
      </section>

      <Modal
        open={modalCancelar}
        danger
        modalHeading="Cancelar este leilão?"
        primaryButtonText={cancelando ? 'Cancelando…' : 'Cancelar leilão'}
        secondaryButtonText="Voltar"
        onRequestClose={() => setModalCancelar(false)}
        onRequestSubmit={() => void cancelar()}
        onSecondarySubmit={() => setModalCancelar(false)}
        primaryButtonDisabled={cancelando}
      >
        <p>
          O leilão continua registrado como Cancelado e não pode ser reaberto. Esta ação não apaga o item nem o
          histórico.
        </p>
      </Modal>
    </div>
  );
}
