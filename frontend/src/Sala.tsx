import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Tag, TextInput } from '@carbon/react';
import { ArrowRight, ArrowUp, Renew, Time, Trophy, User, View, WarningAltFilled } from '@carbon/icons-react';
import { io, type Socket } from 'socket.io-client';
import {
  acertarRelogio,
  api,
  centavosParaTexto,
  dataHora,
  hora,
  incrementoAtual,
  paraCentavos,
  reais,
  tempoPreciso,
  useAgora,
  useConfig,
  useCredito,
  useTitulo,
  type EstadoSala,
  type Leilao,
} from './comuns';
import { Aviso, BarraTempo, GaleriaFotos, Selo, VoltarLink } from './ui';
import { TextoResultado } from './Detalhe';

type Retorno = { tipo: 'ok' | 'erro' | 'info'; texto: string; detalhe?: string; titulo?: string };

/** Chave por tentativa (RF12); `randomUUID` exige contexto seguro, então há fallback. */
function novaChave(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Evolução do preço nos últimos lances, do mais antigo ao mais novo. */
function Evolucao({ lances, inicial }: { lances: EstadoSala['ultimosLances']; inicial: number }) {
  if (lances.length < 2) return null;
  const valores = [...lances].sort((x, y) => x.sequencia - y.sequencia).map((l) => l.valorCentavos);
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const L = 300;
  const A = 56;
  const x = (i: number) => (i / (valores.length - 1)) * L;
  const y = (v: number) => (max === min ? A / 2 : A - 6 - ((v - min) / (max - min)) * (A - 12));
  const linha = valores.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const primeiro = valores[0];
  const alta = primeiro > 0 ? ((max - Math.min(primeiro, inicial)) / Math.min(primeiro, inicial)) * 100 : 0;
  return (
    <div className="evolucao">
      <div className="evolucao__topo">
        <span>Preço nos últimos {valores.length} lances</span>
        <span className="evolucao__alta">
          <ArrowUp size={12} aria-hidden="true" />
          {alta.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% sobre o inicial
        </span>
      </div>
      <svg viewBox={`0 0 ${L} ${A}`} preserveAspectRatio="none" role="img" aria-label="Gráfico da evolução do preço">
        <path d={`${linha} L${L},${A} L0,${A} Z`} className="evolucao__area" />
        <path d={linha} className="evolucao__linha" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function SkeletonSala() {
  return (
    <div className="pagina">
      <p className="carregando">Entrando na sala…</p>
    </div>
  );
}

/**
 * Sala em tempo real (RF09). A tela não calcula nada: mostra a fotografia que o
 * servidor manda a cada mudança. O lance mínimo, o líder e o tempo vêm de lá.
 */
export function Sala() {
  const leilaoId = Number(useParams().id);
  const { config } = useConfig();
  const { credito, recarregar: recarregarCredito } = useCredito();
  const [item, setItem] = useState<Leilao | null>(null);
  const [estado, setEstado] = useState<EstadoSala | null>(null);
  const [eu, setEu] = useState<{ papel: string; numero: number | null; aviso?: string }>({
    papel: '',
    numero: null,
  });
  const [conectado, setConectado] = useState(false);
  const [falha, setFalha] = useState('');
  const [valor, setValor] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [mudandoPapel, setMudandoPapel] = useState(false);
  const [presenca, setPresenca] = useState<{ participantes: number; espectadores: number } | null>(null);
  const [retorno, setRetorno] = useState<Retorno | null>(null);
  const [superado, setSuperado] = useState('');
  const socket = useRef<Socket | null>(null);
  // RF12: uma chave por tentativa. Clique duplo e reenvio usam a mesma; só troca
  // depois de uma resposta definitiva do servidor.
  const chave = useRef(novaChave());
  const liderAnterior = useRef<number | null>(null);
  const agora = useAgora();

  useTitulo(item?.item.nome ?? 'Sala ao vivo');

  // Ao trocar de leilão sem desmontar a rota, limpa o estado da sala anterior.
  useEffect(() => {
    setEstado(null);
    setEu({ papel: '', numero: null });
    setValor('');
    setRetorno(null);
    setSuperado('');
    setFalha('');
    setEnviando(false);
    setMudandoPapel(false);
    setPresenca(null);
    liderAnterior.current = null;
    chave.current = novaChave();
  }, [leilaoId]);

  useEffect(() => {
    api<{ leilao: Leilao }>(`/leiloes/${leilaoId}`)
      .then((r) => setItem(r.leilao))
      .catch((e) => setFalha(e.message));
  }, [leilaoId]);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    socket.current = s;

    const receber = (novo: EstadoSala) => {
      if (novo.leilaoId !== leilaoId) return;
      acertarRelogio(novo.agora);
      // A versão desempata mensagens fora de ordem: estado velho é ignorado.
      setEstado((atual) => (atual && atual.versao > novo.versao ? atual : novo));
      // RF31: ser superado ou liderar muda a reserva; reavalia a cada fotografia.
      void recarregarCredito();
    };

    // Vale para a primeira conexão e para cada reconexão: entra de novo e recebe o estado inteiro.
    s.on('connect', () => {
      setConectado(true);
      s.emit('sala:entrar', { leilaoId }, (r: any) => {
        if (!r?.ok) return setFalha(r?.erro?.mensagem ?? 'Não foi possível entrar na sala.');
        setFalha('');
        setEu(r.eu);
        setPresenca(r.presenca ?? null);
        receber(r.estado);
      });
    });
    s.on('disconnect', () => setConectado(false));
    s.on('connect_error', (e) => {
      setConectado(false);
      if (e.message === 'NAO_AUTENTICADO') setFalha('Sua sessão expirou. Entre de novo para voltar à sala.');
    });
    s.on('sala:estado', receber);
    s.on('sala:presenca', (p: { leilaoId: number; participantes: number; espectadores: number }) => {
      if (p.leilaoId === leilaoId) setPresenca({ participantes: p.participantes, espectadores: p.espectadores });
    });
    s.on('sala:item', (d: { leilaoId: number }) => {
      if (d.leilaoId !== leilaoId) return;
      api<{ leilao: Leilao }>(`/leiloes/${leilaoId}`)
        .then((r) => setItem(r.leilao))
        .catch(() => {});
    });
    s.on('lance:superado', (d: { leilaoId: number; itemNome: string; valorCentavos: number }) => {
      if (d.leilaoId !== leilaoId) return;
      setSuperado(`Seu lance foi superado em ${d.itemNome}. O novo preço é ${reais(d.valorCentavos)}.`);
      void recarregarCredito();
    });
    return () => {
      s.close();
    };
  }, [leilaoId, recarregarCredito]);

  const minimo = estado?.lanceMinimoCentavos ?? null;
  const aberto = estado?.status === 'EM_ANDAMENTO';
  const souLider = eu.numero !== null && estado?.lider?.numero === eu.numero;
  const souComitente = eu.papel === 'COMITENTE';
  const espectador = eu.papel === 'ESPECTADOR';
  const preco = estado ? (estado.precoAtualCentavos ?? estado.precoInicialCentavos) : null;

  // Aviso de superação (RF26): quando o líder deixa de ser você.
  useEffect(() => {
    const atual = estado?.lider?.numero ?? null;
    if (eu.numero !== null && liderAnterior.current === eu.numero && atual !== null && atual !== eu.numero) {
      setSuperado(`Seu lance foi superado por ${estado?.lider?.apelido}. O novo preço é ${reais(estado?.precoAtualCentavos ?? 0)}.`);
    }
    liderAnterior.current = atual;
  }, [estado?.lider?.numero, estado?.precoAtualCentavos, eu.numero]);

  // Mantém o campo sempre em um valor que ainda vale: se o mínimo subiu, o campo sobe junto.
  useEffect(() => {
    if (minimo === null) return;
    setValor((v) => {
      const digitado = paraCentavos(v);
      return digitado === null || digitado < minimo ? centavosParaTexto(minimo) : v;
    });
  }, [minimo]);

  const valorCentavos = paraCentavos(valor);
  const valorInvalido = valorCentavos !== null && minimo !== null && valorCentavos < minimo;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setSuperado('');
    if (valorCentavos === null) {
      return setRetorno({ tipo: 'erro', texto: 'Informe o valor em reais, por exemplo 150,00.' });
    }
    if (minimo !== null && valorCentavos < minimo) {
      return setRetorno({ tipo: 'erro', texto: `O lance mínimo agora é ${reais(minimo)}.` });
    }
    if (!socket.current || enviando) return;
    setEnviando(true);
    setRetorno(null);

    let resposta: any = null;
    // Falha de rede: reenvia a MESMA tentativa. O servidor devolve a resposta original (RF12).
    for (let tentativa = 0; tentativa < 4 && !resposta; tentativa++) {
      try {
        const r = await socket.current.timeout(4000).emitWithAck('lance:enviar', {
          leilaoId,
          valorCentavos,
          chave: chave.current,
        });
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
      // A chave é mantida: depois do login, o mesmo lance pode ser reenviado.
      return setFalha('Sua sessão expirou. Entre de novo para voltar à sala.');
    }
    chave.current = novaChave(); // resposta definitiva: a próxima é outra tentativa
    if (resposta.aceito) {
      setEu((x) => ({ ...x, numero: resposta.meuNumero, aviso: undefined }));
      void recarregarCredito();
      setRetorno({
        tipo: 'ok',
        texto: `Lance de ${reais(resposta.lance.valorCentavos)} aceito. Você é o líder.`,
        detalhe: resposta.prorrogou ? 'O término foi prorrogado em 2 minutos.' : undefined,
      });
    } else {
      const detalhes = [
        resposta.lanceMinimoCentavos ? `Lance mínimo atual: ${reais(resposta.lanceMinimoCentavos)}.` : '',
        resposta.motivo === 'CREDITO_INSUFICIENTE' && credito
          ? `Crédito disponível: ${reais(credito.disponivelCentavos)}.`
          : '',
      ].filter(Boolean);
      if (resposta.motivo === 'CREDITO_INSUFICIENTE') void recarregarCredito();
      setRetorno({
        tipo: 'erro',
        texto: resposta.mensagem,
        titulo: resposta.motivo === 'CREDITO_INSUFICIENTE' ? 'Crédito insuficiente' : undefined,
        detalhe: detalhes.length ? detalhes.join(' ') : undefined,
      });
    }
  }

  function usarValor(centavos: number) {
    setValor(centavosParaTexto(centavos));
    setRetorno(null);
  }

  async function mudarPapel(papel: 'PARTICIPANTE' | 'ESPECTADOR') {
    if (!socket.current || mudandoPapel) return;
    setMudandoPapel(true);
    setRetorno(null);
    try {
      const r: any = await socket.current.timeout(4000).emitWithAck('sala:papel', { leilaoId, papel });
      if (r?.ok) {
        setEu((atual) => ({ ...atual, papel: r.eu.papel, aviso: undefined }));
        setRetorno({
          tipo: 'info',
          texto:
            papel === 'ESPECTADOR'
              ? 'Agora você está assistindo. Pode voltar a participar quando quiser.'
              : 'Agora você participa da disputa. O formulário de lance está liberado.',
        });
      } else {
        const codigo = r?.erro?.codigo;
        if (codigo === 'CREDITO_INSUFICIENTE') void recarregarCredito();
        setRetorno({
          tipo: 'erro',
          texto: r?.erro?.mensagem ?? 'Não foi possível mudar seu papel na sala.',
          titulo: codigo === 'CREDITO_INSUFICIENTE' ? 'Crédito insuficiente' : undefined,
          detalhe:
            codigo === 'CREDITO_INSUFICIENTE' && credito
              ? `Crédito disponível: ${reais(credito.disponivelCentavos)}.`
              : undefined,
        });
      }
    } catch {
      setRetorno({ tipo: 'erro', texto: 'Sem resposta do servidor. Tente de novo.' });
    } finally {
      setMudandoPapel(false);
    }
  }

  if (!estado) {
    if (falha) {
      return (
        <div className="pagina pagina--estreita">
          <Aviso tipo="erro" titulo="Não foi possível entrar na sala">
            {falha}{' '}
            <Link className="link-inline" to={`/entrar?volta=/leiloes/${leilaoId}/sala`}>
              Entrar de novo
            </Link>
          </Aviso>
          <VoltarLink para={`/leiloes/${leilaoId}`}>Voltar ao leilão</VoltarLink>
        </div>
      );
    }
    return <SkeletonSala />;
  }

  const restante = new Date(estado.terminoEm).getTime() - agora;
  const paraAbrir = new Date(estado.inicioEm).getTime() - agora;
  const urgente = aberto && restante > 0 && restante < 60_000;
  const quem = (numero: number, apelido: string) => (numero === eu.numero ? `${apelido} (você)` : apelido);
  const incremento = preco !== null && config ? incrementoAtual(preco, config.incrementos) : 0;
  const rapidos = minimo !== null && incremento > 0 ? [minimo, minimo + incremento, minimo + incremento * 2] : [];
  // já dei lance aqui e alguém passou na frente
  const fuiSuperado = aberto && !souLider && eu.numero !== null && estado.ultimosLances.some((l) => l.numero === eu.numero);
  const limite = credito?.limiteCentavos ?? 0;
  const reservadoPct = limite > 0 && credito ? Math.min(100, (credito.reservadoCentavos / limite) * 100) : 0;
  const lancePct =
    limite > 0 && valorCentavos !== null && !souLider ? Math.min(100 - reservadoPct, (valorCentavos / limite) * 100) : 0;

  return (
    <div className="pagina sala">
      <div className="sala__trilha">
        <VoltarLink para={`/leiloes/${leilaoId}`}>Voltar ao leilão</VoltarLink>
        {eu.papel === 'ESPECTADOR' ? (
          <Tag type="outline" size="sm">
            Espectador
          </Tag>
        ) : eu.papel === 'COMITENTE' ? (
          <Tag type="outline" size="sm">
            Comitente
          </Tag>
        ) : (
          eu.numero !== null && (
            <Tag type="outline" size="sm">
              Você é Participante {eu.numero}
            </Tag>
          )
        )}
      </div>

      {falha && (
        <Aviso tipo="erro" titulo="Conexão com a sala" onFechar={() => setFalha('')}>
          {falha}{' '}
          <Link className="link-inline" to={`/entrar?volta=/leiloes/${leilaoId}/sala`}>
            Entrar de novo
          </Link>
        </Aviso>
      )}

      <div className="sala__grade">
        <section className="sala__item" aria-labelledby="sala-titulo">
          <GaleriaFotos fotos={item?.item.fotos ?? []} nome={item?.item.nome ?? 'Item do leilão'} compacta />
          <div className="sala__item-texto">
            <p className="sala__categoria">{item?.item.categoriaNome ?? 'Leilão'}</p>
            <h1 id="sala-titulo">{item?.item.nome ?? 'Sala ao vivo'}</h1>
            <Link className="link-inline" to={`/leiloes/${leilaoId}`}>
              Ver descrição completa <ArrowRight size={14} aria-hidden="true" />
            </Link>
            {item && (
              <p className="sala__comitente">
                <User size={14} aria-hidden="true" /> Comitente:{' '}
                <Link className="link-inline" to={`/comitentes/${item.comitente.id}`}>
                  {item.comitente.nome}
                </Link>
              </p>
            )}
            {item?.item.descricao && <p className="sala__descricao">{item.item.descricao}</p>}
            <dl className="sala__ficha">
              <div>
                <dt>Início</dt>
                <dd>{dataHora(estado.inicioEm)}</dd>
              </div>
              <div>
                <dt>Término{estado.prorrogado ? ' (prorrogado)' : ''}</dt>
                <dd>{dataHora(estado.terminoEm)}</dd>
              </div>
            </dl>
            <p className="sala__regra">
              O relógio que vale é o do servidor. Um lance nos últimos 2 minutos prorroga o término, até o limite de 30
              minutos acumulados.
            </p>
          </div>
        </section>

        <section className="sala__lado" aria-label="Disputa ao vivo">
          <div
            className={`sala__painel${urgente ? ' sala__painel--urgente' : ''}${
              aberto && souLider ? ' sala__painel--lider' : ''
            }${fuiSuperado ? ' sala__painel--superado' : ''}`}
          >
            <div className="sala__status">
              <Selo status={estado.status} />
              <span className={conectado ? 'status-vivo' : 'status-reconectando'} role="status">
                <span className={`pulso${conectado ? '' : ' pulso--parado'}`} aria-hidden="true" />
                {conectado ? 'Ao vivo' : 'Reconectando…'}
              </span>
            </div>

            <p className="sala__painel-nome">{item?.item.nome ?? 'Leilão ao vivo'}</p>

            <p className="sala__rotulo">{estado.precoAtualCentavos === null ? 'Preço inicial' : 'Preço atual'}</p>
            {/* a chave refaz o elemento a cada novo preço: é o que dispara o destaque */}
            <p key={preco ?? 'sem'} className={`sala__preco${estado.totalLances > 0 ? ' sala__preco--novo' : ''}`}>
              {preco !== null ? reais(preco) : '—'}
            </p>

            {aberto && souLider && (
              <p className="sala__posicao sala__posicao--lider">
                <Trophy size={16} aria-hidden="true" /> Você está na frente
              </p>
            )}
            {fuiSuperado && minimo !== null && (
              <p className="sala__posicao sala__posicao--superado">
                <WarningAltFilled size={16} aria-hidden="true" /> Cobriram seu lance. Para voltar à frente: {reais(minimo)}
              </p>
            )}

            <div className="sala__tempo">
              <span>{estado.status === 'AGENDADO' ? 'Abre em' : 'Termina em'}</span>
              <strong className={urgente ? 'sala__tempo--urgente' : ''}>
                {estado.status === 'AGENDADO'
                  ? tempoPreciso(paraAbrir)
                  : aberto
                    ? restante > 0
                      ? tempoPreciso(restante)
                      : 'Encerrando…'
                    : '—'}
              </strong>
            </div>

            {aberto && <BarraTempo inicioEm={estado.inicioEm} terminoEm={estado.terminoEm} inversa />}

            <dl className="sala__stats">
              <div>
                <dt>
                  <Trophy size={14} aria-hidden="true" /> Líder
                </dt>
                <dd>{estado.lider ? quem(estado.lider.numero, estado.lider.apelido) : '—'}</dd>
              </div>
              <div>
                <dt>Lance mínimo</dt>
                <dd>{minimo !== null ? reais(minimo) : '—'}</dd>
              </div>
              <div>
                <dt>
                  <Time size={14} aria-hidden="true" /> Lances
                </dt>
                <dd>{estado.totalLances}</dd>
              </div>
            </dl>

            {presenca && (
              <p className="sala__presenca">
                <span>
                  <User size={14} aria-hidden="true" /> {presenca.participantes}{' '}
                  {presenca.participantes === 1 ? 'participante' : 'participantes'}
                </span>
                <span>
                  <View size={14} aria-hidden="true" /> {presenca.espectadores}{' '}
                  {presenca.espectadores === 1 ? 'espectador' : 'espectadores'}
                </span>
              </p>
            )}

            <Evolucao lances={estado.ultimosLances} inicial={estado.precoInicialCentavos} />

            {estado.prorrogado && (
              <Tag type="warm-gray" size="sm" className="sala__prorrogado">
                Término prorrogado
              </Tag>
            )}
          </div>

          <p className="sr-only" aria-live="polite">
            {estado.lider
              ? `Líder ${estado.lider.apelido}, preço ${reais(estado.precoAtualCentavos ?? estado.precoInicialCentavos)}.`
              : 'Nenhum lance ainda.'}
          </p>

          {superado && (
            <Aviso tipo="alerta" titulo="Seu lance foi superado" onFechar={() => setSuperado('')}>
              {superado}
            </Aviso>
          )}

          {eu.aviso && (
            <Aviso
              tipo="alerta"
              titulo="Você entrou como espectador"
              onFechar={() => setEu((atual) => ({ ...atual, aviso: undefined }))}
            >
              {eu.aviso}
            </Aviso>
          )}

          <TextoResultado leilao={{ resultado: estado.resultado, eu: { venci: estado.status === 'VENDIDO' && souLider } }} />

          {estado.status === 'AGENDADO' && (
            <Aviso tipo="info" titulo="A sala abre sozinha">
              Não precisa recarregar a página. A contagem acima usa o relógio do servidor.
            </Aviso>
          )}

          {aberto && souComitente && (
            <Aviso tipo="info" titulo="Você é o comitente">
              Acompanhe a disputa. O comitente não pode dar lance no próprio leilão.
            </Aviso>
          )}

          {aberto && !souComitente && (
            <div className="sala__papel">
              <p>{espectador ? 'Você está assistindo à disputa.' : 'Você está participando da disputa.'}</p>
              {espectador ? (
                <Button
                  kind="primary"
                  renderIcon={User}
                  onClick={() => void mudarPapel('PARTICIPANTE')}
                  disabled={mudandoPapel || !conectado}
                >
                  {mudandoPapel ? 'Entrando…' : 'Participar do leilão'}
                </Button>
              ) : (
                <Button
                  kind="ghost"
                  renderIcon={View}
                  onClick={() => void mudarPapel('ESPECTADOR')}
                  disabled={mudandoPapel || !conectado}
                >
                  {mudandoPapel ? 'Mudando…' : 'Assistir sem dar lance'}
                </Button>
              )}
            </div>
          )}

          {aberto && !souComitente && espectador && !eu.aviso && (
            <Aviso tipo="info" titulo="Modo espectador">
              Você acompanha preço, lances e presença em tempo real. Para dar lance, entre na disputa.
            </Aviso>
          )}

          {aberto && !souComitente && !espectador && (
            <form className="lance" onSubmit={enviar} noValidate>
              <div className="lance__cabecalho">
                <h2>Seu lance</h2>
                {minimo !== null && <span>Mínimo {reais(minimo)}</span>}
              </div>

              {credito && (
                <div
                  className={`lance__credito${
                    minimo !== null && credito.disponivelCentavos < minimo ? ' lance__credito--baixo' : ''
                  }`}
                >
                  <p>
                    Crédito disponível: <strong>{reais(credito.disponivelCentavos)}</strong>
                    {minimo !== null && credito.disponivelCentavos < minimo && ' — não cobre o mínimo atual.'}
                    <Link className="link-inline lance__credito-link" to="/minha-conta">
                      Ver crédito
                    </Link>
                  </p>
                  {limite > 0 && (
                    <>
                      <div className="barra barra--credito" aria-hidden="true">
                        <span className="barra__valor barra__valor--reserva" style={{ width: `${reservadoPct}%` }} />
                        <span className="barra__valor barra__valor--lance" style={{ width: `${lancePct}%` }} />
                      </div>
                      <p className="lance__credito-legenda">
                        <span>
                          <i className="ponto ponto--reserva" aria-hidden="true" /> reservado em outros lances
                        </span>
                        <span>
                          <i className="ponto ponto--lance" aria-hidden="true" /> este lance
                        </span>
                        <span>limite {reais(limite)}</span>
                      </p>
                    </>
                  )}
                </div>
              )}

              <TextInput
                id="valor"
                labelText="Valor em reais"
                placeholder={minimo !== null ? centavosParaTexto(minimo) : '150,00'}
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                invalid={valorInvalido}
                invalidText={`O lance mínimo agora é ${minimo !== null ? reais(minimo) : ''}.`}
                helperText="Use vírgula para os centavos. O valor é conferido pelo servidor."
                disabled={enviando || !conectado}
              />

              {rapidos.length > 0 && (
                <div className="lance__rapidos" aria-label="Sugestões de lance">
                  {rapidos.map((v, i) => (
                    <Button
                      key={v}
                      type="button"
                      size="sm"
                      kind={i === 0 ? 'primary' : 'tertiary'}
                      onClick={() => usarValor(v)}
                      disabled={enviando || !conectado}
                    >
                      {i === 0 ? 'Mínimo' : `+${reais(v - (minimo ?? 0))}`} ({reais(v)})
                    </Button>
                  ))}
                </div>
              )}

              <Button
                type="submit"
                kind="primary"
                renderIcon={ArrowRight}
                disabled={enviando || !conectado || souLider || valorInvalido}
                className="lance__enviar"
              >
                {enviando ? 'Enviando…' : souLider ? 'Você é o líder' : 'Dar lance'}
              </Button>

              <p className="lance__nota">
                {souLider
                  ? 'Você lidera. Só precisa dar outro lance se alguém cobrir.'
                  : 'O lance é irrevogável: não existe desfazer. Quem chega primeiro tem prioridade.'}
              </p>
            </form>
          )}

          {retorno && (
            <Aviso
              tipo={retorno.tipo}
              titulo={retorno.titulo ?? (retorno.tipo === 'ok' ? 'Lance aceito' : undefined)}
              onFechar={() => setRetorno(null)}
            >
              {retorno.texto}
              {retorno.detalhe ? ` ${retorno.detalhe}` : ''}
            </Aviso>
          )}

          {estado.status !== 'EM_ANDAMENTO' && estado.status !== 'AGENDADO' && (
            <Button as={Link} to={`/leiloes/${leilaoId}`} kind="tertiary" renderIcon={Renew}>
              Ver detalhes do leilão
            </Button>
          )}

          <section className="lances" aria-labelledby="titulo-lances">
            <div className="lances__cabecalho">
              <h2 id="titulo-lances">Últimos lances</h2>
              <span>{estado.ultimosLances.length} de {estado.totalLances}</span>
            </div>
            {estado.ultimosLances.length === 0 ? (
              <p className="lances__vazio">Nenhum lance ainda. O primeiro pode ser igual ao preço inicial.</p>
            ) : (
              <ol className="lances__lista">
                {estado.ultimosLances.map((l, i) => (
                  <li
                    key={l.sequencia}
                    className={`lances__linha${l.numero === eu.numero ? ' lances__linha--eu' : ''}${
                      i === 0 ? ' lances__linha--lider' : ''
                    }`}
                  >
                    <span className="lances__pessoa">
                      <span className="lances__ordem">{l.sequencia}º</span>
                      {quem(l.numero, l.apelido)}
                      {i === 0 && (
                        <span className="lances__lider">
                          <Trophy size={12} aria-hidden="true" /> na frente
                        </span>
                      )}
                    </span>
                    <span className="lances__valor">{reais(l.valorCentavos)}</span>
                    <span className="lances__hora">{hora(l.em)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </section>
      </div>
    </div>
  );
}
