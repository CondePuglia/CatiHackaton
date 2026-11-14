import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tag, TextInput } from '@carbon/react';
import { ChartLineSmooth, Renew } from '@carbon/icons-react';
import { dataHora, tempo, useTitulo } from './comuns';
import { Aviso, VoltarLink } from './ui';

type Amostra = { nome: string; rotulos: Record<string, string>; valor: number };

function analisar(texto: string): Amostra[] {
  const amostras: Amostra[] = [];
  for (const linha of texto.split('\n')) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(limpa);
    if (!m) continue;
    const [, nome, bruto, valorTexto] = m;
    const rotulos: Record<string, string> = {};
    if (bruto) {
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
      let item: RegExpExecArray | null;
      while ((item = re.exec(bruto))) {
        rotulos[item[1]] = item[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    const valor = Number(valorTexto);
    if (Number.isFinite(valor)) amostras.push({ nome, rotulos, valor });
  }
  return amostras;
}

const soma = (amostras: Amostra[], nome: string) =>
  amostras.filter((a) => a.nome === nome).reduce((total, a) => total + a.valor, 0);

const valor = (amostras: Amostra[], nome: string, rotulos: Record<string, string> = {}) =>
  amostras.find(
    (a) => a.nome === nome && Object.entries(rotulos).every(([chave, v]) => a.rotulos[chave] === v),
  )?.valor;

const inteiro = (n: number | undefined) => (n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const segundos = (n: number | undefined) => tempo((n ?? 0) * 1000);
const megabytes = (bytes: number | undefined) =>
  `${((bytes ?? 0) / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
const milissegundos = (s: number | undefined) =>
  `${((s ?? 0) * 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ms`;

/** Bônus 7.2: painel para mostrar as métricas de `/api/metricas` no pitch. */
export function Metricas() {
  useTitulo('Métricas do sistema');
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState('');
  const [protegida, setProtegida] = useState(false);
  const [token, setToken] = useState(() => sessionStorage.getItem('metricas_token') ?? '');
  const [tokenInput, setTokenInput] = useState(token);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);

  const carregar = useCallback(async () => {
    try {
      const resposta = await fetch('/api/metricas', {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        credentials: 'same-origin',
      });
      if (resposta.status === 401 || resposta.status === 403) {
        setProtegida(true);
        setErro('As métricas estão protegidas. Informe o token configurado em METRICAS_TOKEN.');
        return;
      }
      if (!resposta.ok) throw new Error(`A API respondeu ${resposta.status}.`);
      setProtegida(false);
      setTexto(await resposta.text());
      setErro('');
      setAtualizadoEm(new Date());
    } catch (falha) {
      setErro((falha as Error).message);
    }
  }, [token]);

  useEffect(() => {
    void carregar();
    const t = setInterval(carregar, 5000);
    return () => clearInterval(t);
  }, [carregar]);

  const amostras = useMemo(() => analisar(texto), [texto]);
  const transicoesAtrasadas = soma(amostras, 'leilao_transicoes_atrasadas');
  const bancoNoAr = valor(amostras, 'leilao_banco_no_ar') === 1;
  const noAr = valor(amostras, 'leilao_processo_no_ar_segundos') ?? 0;

  const cartoes = [
    {
      rotulo: 'Leilões em andamento',
      valor: inteiro(valor(amostras, 'leilao_leiloes', { status: 'EM_ANDAMENTO' })),
      detalhe: 'status EM_ANDAMENTO no banco',
    },
    {
      rotulo: 'Leilões agendados',
      valor: inteiro(valor(amostras, 'leilao_leiloes', { status: 'AGENDADO' })),
      detalhe: 'status AGENDADO no banco',
    },
    {
      rotulo: 'Lances gravados',
      valor: inteiro(valor(amostras, 'leilao_lances_gravados')),
      detalhe: 'total aceito no banco',
    },
    {
      rotulo: 'Pessoas nas salas',
      valor: inteiro(valor(amostras, 'leilao_pessoas_nas_salas')),
      detalhe: 'distintas em todas as instâncias',
    },
    {
      rotulo: 'Sockets nesta instância',
      valor: inteiro(valor(amostras, 'leilao_sockets_conectados')),
      detalhe: 'conexões de tempo real abertas',
    },
    {
      rotulo: 'Requisições HTTP nesta instância',
      valor: inteiro(soma(amostras, 'leilao_http_requisicoes_total')),
      detalhe: 'desde a subida deste processo',
    },
    {
      rotulo: 'Lances recebidos nesta instância',
      valor: inteiro(soma(amostras, 'leilao_lances_total')),
      detalhe: 'aceitos, reenvios e recusas',
    },
    {
      rotulo: 'Transições atrasadas',
      valor: inteiro(transicoesAtrasadas),
      detalhe: 'zero quando o worker está em dia',
      alerta: transicoesAtrasadas > 0,
    },
    {
      rotulo: 'Maior atraso de transição',
      valor: segundos(valor(amostras, 'leilao_transicao_maior_atraso_segundos')),
      detalhe: 'abrir ou fechar pendente',
    },
    {
      rotulo: 'Latência p99 do event loop',
      valor: milissegundos(valor(amostras, 'leilao_laco_atraso_segundos', { medida: 'p99' })),
      detalhe: 'saúde do processo Node',
    },
    {
      rotulo: 'Memória do processo',
      valor: megabytes(valor(amostras, 'leilao_processo_memoria_bytes')),
      detalhe: 'RSS da API',
    },
    {
      rotulo: 'No ar há',
      valor: segundos(noAr),
      detalhe: 'tempo desde a subida desta instância',
    },
    {
      rotulo: 'Conexões com o banco',
      valor: inteiro(valor(amostras, 'leilao_db_conexoes', { estado: 'abertas' })),
      detalhe: 'abertas no pool',
    },
    {
      rotulo: 'Instâncias com salas',
      valor: inteiro(valor(amostras, 'leilao_instancias_com_salas')),
      detalhe: 'API(s) com presença agora',
    },
  ];

  return (
    <div className="pagina">
      <div className="detalhe__trilha">
        <VoltarLink para="/">Catálogo</VoltarLink>
        <span aria-hidden="true">/</span>
        <span>Métricas</span>
      </div>

      <div className="catalogo__cabecalho">
        <div>
          <h1>Métricas do sistema</h1>
          <p>
            Números reais de <code>/api/metricas</code>, no formato do Prometheus. A tela atualiza a cada 5 segundos.
          </p>
        </div>
        <div className="metricas__acoes">
          <Tag type={bancoNoAr ? 'green' : 'red'} size="sm">
            {bancoNoAr ? 'Banco no ar' : 'Banco fora'}
          </Tag>
          <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={() => void carregar()}>
            Atualizar agora
          </Button>
        </div>
      </div>

      {atualizadoEm && (
        <p className="metricas__atualizacao" role="status">
          Última coleta: {dataHora(atualizadoEm.toISOString())}.
        </p>
      )}

      {erro && (
        <Aviso tipo={protegida ? 'alerta' : 'erro'} titulo={protegida ? 'Métricas protegidas' : 'Não foi possível ler as métricas'}>
          {erro}
        </Aviso>
      )}

      {protegida && (
        <div className="metricas__token">
          <TextInput
            id="metricas-token"
            labelText="Token de métricas"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            helperText="O mesmo valor de METRICAS_TOKEN no servidor."
          />
          <Button
            kind="primary"
            onClick={() => {
              sessionStorage.setItem('metricas_token', tokenInput);
              setToken(tokenInput);
            }}
          >
            Usar token
          </Button>
        </div>
      )}

      {!texto && !erro && <p className="carregando">Coletando métricas…</p>}

      {texto && (
        <>
          <section className="metricas__grade" aria-label="Indicadores">
            {cartoes.map((cartao) => (
              <article key={cartao.rotulo} className={`metrica${cartao.alerta ? ' metrica--alerta' : ''}`}>
                <p className="metrica__rotulo">{cartao.rotulo}</p>
                <p className="metrica__valor">{cartao.valor}</p>
                <p className="metrica__detalhe">{cartao.detalhe}</p>
              </article>
            ))}
          </section>

          <details className="metricas__bruto">
            <summary>
              <ChartLineSmooth size={16} aria-hidden="true" /> Ver séries brutas do Prometheus
            </summary>
            <pre>{texto}</pre>
          </details>
        </>
      )}
    </div>
  );
}
