import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Tag } from '@carbon/react';
import { ArrowRight, CheckmarkFilled, Locked, Purchase, Time, Trophy, Wallet } from '@carbon/icons-react';
import {
  api,
  dataHora,
  reais,
  useCredito,
  useSessao,
  useTitulo,
  type HistoricoCompras,
} from './comuns';
import { Aviso, ModalQueroVender, useQueroVender } from './ui';

/** Anel de pontuação: 0 a 100, com a marca do mínimo para vender. */
function AnelPontuacao({ pontos, minimo }: { pontos: number; minimo: number }) {
  const raio = 52;
  const volta = 2 * Math.PI * raio;
  const angulo = (minimo / 100) * 2 * Math.PI - Math.PI / 2;
  const habilita = pontos >= minimo;
  return (
    <div className="anel" role="img" aria-label={`Pontuação ${pontos} de 100. Mínimo para vender: ${minimo}.`}>
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle cx="64" cy="64" r={raio} className="anel__trilho" />
        <circle
          cx="64"
          cy="64"
          r={raio}
          className={`anel__valor${habilita ? ' anel__valor--ok' : ''}`}
          strokeDasharray={`${(Math.min(100, pontos) / 100) * volta} ${volta}`}
          transform="rotate(-90 64 64)"
        />
        <line
          x1={64 + Math.cos(angulo) * (raio - 9)}
          y1={64 + Math.sin(angulo) * (raio - 9)}
          x2={64 + Math.cos(angulo) * (raio + 9)}
          y2={64 + Math.sin(angulo) * (raio + 9)}
          className="anel__marca"
        />
      </svg>
      <div className="anel__centro">
        <strong>{pontos}</strong>
        <span>de 100</span>
      </div>
    </div>
  );
}

function Parcela({
  rotulo,
  detalhe,
  pontos,
  maximo,
}: {
  rotulo: string;
  detalhe: string;
  pontos: number;
  maximo: number;
}) {
  return (
    <li className="parcela">
      <div className="parcela__topo">
        <span className="parcela__rotulo">{rotulo}</span>
        <span className="parcela__pontos">
          <b>{pontos.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</b> / {maximo}
        </span>
      </div>
      <div className="barra" aria-hidden="true">
        <span className="barra__valor" style={{ width: `${Math.min(100, (pontos / maximo) * 100)}%` }} />
      </div>
      <p className="parcela__detalhe">{detalhe}</p>
    </li>
  );
}

/**
 * Bônus 7.1 (RF29–RF31): de onde vem a pontuação, quanto de crédito há, o que
 * está reservado agora e o histórico de compras. Os números vêm do servidor; a
 * tela só mostra a conta já feita.
 */
export function MinhaConta() {
  useTitulo('Minha conta');
  const { usuario } = useSessao();
  const { credito, erro, recarregar } = useCredito();
  const [historico, setHistorico] = useState<HistoricoCompras | null>(null);
  const queroVender = useQueroVender();

  useEffect(() => {
    let vivo = true;
    const carregar = () => {
      void recarregar();
      api<HistoricoCompras>('/eu/compras')
        .then((h) => vivo && setHistorico(h))
        .catch(() => {});
    };
    carregar();
    const t = setInterval(carregar, 8000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [recarregar]);

  if (!usuario) return null;

  const minimo = credito?.pontuacaoMinimaComitente ?? 50;
  const pontos = credito?.pontuacao ?? usuario.pontuacao;
  const renda = credito?.rendaMensalCentavos ?? 0;
  const dias = credito?.diasDeConta ?? 0;
  const compras = credito?.compras ?? 0;
  const total = credito?.totalCompradoCentavos ?? 0;
  const limite = credito?.limiteCentavos ?? 0;
  const reservado = credito?.reservadoCentavos ?? 0;
  const disponivel = credito?.disponivelCentavos ?? 0;
  const usado = limite > 0 ? Math.min(100, (reservado / limite) * 100) : 0;

  return (
    <div className="pagina conta-painel">
      <header className="conta-painel__topo">
        <div>
          <p className="conta-painel__sobre">Minha conta</p>
          <h1>{usuario.nome}</h1>
          <p className="conta-painel__email">
            {usuario.email}
            {usuario.criadoEm ? ` · na Cati desde ${new Date(usuario.criadoEm).toLocaleDateString('pt-BR')}` : ''}
          </p>
        </div>
        <div className="conta-painel__papeis">
          <Tag type="blue" size="md">
            Comprador
          </Tag>
          {usuario.comitente ? (
            <Tag type="green" size="md" renderIcon={CheckmarkFilled}>
              Comitente habilitado
            </Tag>
          ) : (
            <Tag type="gray" size="md" renderIcon={Locked}>
              Ainda não vende
            </Tag>
          )}
        </div>
      </header>

      {erro && !credito && <Aviso tipo="erro">{erro}</Aviso>}

      <div className="conta-painel__grade">
        <section className="quadro quadro--pontuacao" aria-labelledby="titulo-pontuacao">
          <h2 id="titulo-pontuacao">Pontuação</h2>
          <div className="pontuacao">
            <AnelPontuacao pontos={pontos} minimo={minimo} />
            <ul className="pontuacao__parcelas">
              <Parcela
                rotulo="Renda mensal"
                detalhe={`${reais(renda)} declarados · teto em R$ 10.000`}
                pontos={50 * Math.min(renda / 1_000_000, 1)}
                maximo={50}
              />
              <Parcela
                rotulo="Tempo de conta"
                detalhe={`${dias} ${dias === 1 ? 'dia' : 'dias'} · teto em 180 dias`}
                pontos={20 * Math.min(dias / 180, 1)}
                maximo={20}
              />
              <Parcela
                rotulo="Compras concluídas"
                detalhe={`${compras} ${compras === 1 ? 'leilão vencido' : 'leilões vencidos'} · teto em 10`}
                pontos={15 * Math.min(compras / 10, 1)}
                maximo={15}
              />
              <Parcela
                rotulo="Total comprado"
                detalhe={`${reais(total)} · teto em R$ 20.000`}
                pontos={15 * Math.min(total / 2_000_000, 1)}
                maximo={15}
              />
            </ul>
          </div>

          <div className={`vender${usuario.comitente ? ' vender--ok' : ''}`}>
            {usuario.comitente ? (
              <>
                <p>
                  <strong>Você pode anunciar itens.</strong> A habilitação veio da pontuação, sem aprovação manual.
                </p>
                <Button as={Link} to="/leiloes/novo" kind="primary" size="md" renderIcon={ArrowRight}>
                  Anunciar item
                </Button>
              </>
            ) : pontos >= minimo ? (
              <>
                <p>
                  <strong>Sua pontuação já permite vender.</strong> A habilitação é na hora.
                </p>
                <Button
                  kind="primary"
                  size="md"
                  renderIcon={ArrowRight}
                  onClick={() => void queroVender.habilitar()}
                  disabled={queroVender.carregando}
                >
                  {queroVender.carregando ? 'Verificando…' : 'Quero vender'}
                </Button>
              </>
            ) : (
              <p>
                <strong>
                  Faltam {minimo - pontos} {minimo - pontos === 1 ? 'ponto' : 'pontos'} para vender.
                </strong>{' '}
                São necessários {minimo}. Vencer leilões e o tempo de conta aumentam a pontuação.
              </p>
            )}
          </div>
        </section>

        <section className="quadro quadro--credito" aria-labelledby="titulo-credito">
          <h2 id="titulo-credito">
            <Wallet size={20} aria-hidden="true" /> Crédito para lances
          </h2>
          <p className="credito__rotulo">Disponível agora</p>
          <p className="credito__valor">{reais(disponivel)}</p>
          <div
            className="barra barra--credito"
            role="img"
            aria-label={`${reais(reservado)} reservados de um limite de ${reais(limite)}`}
          >
            <span className="barra__valor barra__valor--reserva" style={{ width: `${usado}%` }} />
          </div>
          <dl className="credito__numeros">
            <div>
              <dt>Limite</dt>
              <dd>{reais(limite)}</dd>
            </div>
            <div>
              <dt>
                <i className="ponto ponto--reserva" aria-hidden="true" /> Reservado
              </dt>
              <dd>{reais(reservado)}</dd>
            </div>
            <div>
              <dt>
                <i className="ponto ponto--livre" aria-hidden="true" /> Livre
              </dt>
              <dd>{reais(disponivel)}</dd>
            </div>
          </dl>
          <p className="credito__regra">
            Limite = renda mensal × 6 × pontuação ÷ 100. O valor do lance fica reservado enquanto você lidera e volta
            quando alguém cobre ou o leilão termina.
          </p>
        </section>
      </div>

      <div className="conta-painel__grade conta-painel__grade--listas">
        <section className="quadro" aria-labelledby="titulo-reservas">
          <div className="quadro__cabecalho">
            <h2 id="titulo-reservas">
              <Time size={20} aria-hidden="true" /> Liderando agora
            </h2>
            <span>{historico ? reais(historico.reservadoCentavos) : '—'}</span>
          </div>
          {!historico || historico.reservas.length === 0 ? (
            <p className="quadro__vazio">
              Nenhuma reserva. Quando você lidera um leilão em andamento, o valor do lance aparece aqui.
            </p>
          ) : (
            <ul className="movimentos">
              {historico.reservas.map((r) => (
                <li key={r.leilaoId}>
                  <Link to={`/leiloes/${r.leilaoId}/sala`} className="movimento">
                    <span className="movimento__icone movimento__icone--vivo">
                      <Trophy size={16} aria-hidden="true" />
                    </span>
                    <span className="movimento__texto">
                      <b>{r.itemNome}</b>
                      <small>Último lance em {dataHora(r.em)}</small>
                    </span>
                    <span className="movimento__valor">{reais(r.valorCentavos)}</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="quadro" aria-labelledby="titulo-compras">
          <div className="quadro__cabecalho">
            <h2 id="titulo-compras">
              <Purchase size={20} aria-hidden="true" /> Histórico de compras
            </h2>
            <span>{historico ? reais(historico.totalCompradoCentavos) : '—'}</span>
          </div>
          {!historico || historico.compras.length === 0 ? (
            <p className="quadro__vazio">Você ainda não venceu nenhum leilão. Cada compra soma na pontuação.</p>
          ) : (
            <ul className="movimentos">
              {historico.compras.map((c) => (
                <li key={c.leilaoId}>
                  <Link to={`/leiloes/${c.leilaoId}`} className="movimento">
                    <span className="movimento__icone">
                      <Purchase size={16} aria-hidden="true" />
                    </span>
                    <span className="movimento__texto">
                      <b>{c.itemNome}</b>
                      <small>Vencido em {dataHora(c.em)}</small>
                    </span>
                    <span className="movimento__valor">{reais(c.valorCentavos)}</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ModalQueroVender estado={queroVender} />
    </div>
  );
}
