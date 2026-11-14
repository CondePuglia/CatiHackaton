import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Dropdown, RadioButton, RadioButtonGroup, TextArea, TextInput } from '@carbon/react';
import { Add, ArrowRight, Close, Image as ImageIcon } from '@carbon/icons-react';
import {
  agoraNoServidor,
  api,
  centavosParaTexto,
  dataHora,
  ErroApi,
  fusoLocal,
  paraCentavos,
  reais,
  tempo,
  useSessao,
  useTitulo,
  type Config,
  type Leilao,
} from './comuns';
import { Aviso, Selo, VoltarLink } from './ui';

type Foto = { id: number; url: string };
export type AcaoDoFormulario = 'criar' | 'editar' | 'relistar';

const INICIOS = [
  { rotulo: 'Em 1 minuto', segundos: 60 },
  { rotulo: 'Em 5 minutos', segundos: 300 },
  { rotulo: 'Em 1 hora', segundos: 3600 },
  { rotulo: 'Em 1 dia', segundos: 86400 },
];
const DURACOES = [
  { rotulo: '3 minutos', segundos: 180 },
  { rotulo: '10 minutos', segundos: 600 },
  { rotulo: '1 hora', segundos: 3600 },
  { rotulo: '6 horas', segundos: 21600 },
  { rotulo: '1 dia', segundos: 86400 },
  { rotulo: '3 dias', segundos: 259200 },
];

function paraInputLocal(data: Date) {
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}T${dois(data.getHours())}:${dois(data.getMinutes())}`;
}

function Previa({
  nome,
  categoria,
  foto,
  precoCentavos,
  inicioEm,
  terminoEm,
}: {
  nome: string;
  categoria: string;
  foto: Foto | undefined;
  precoCentavos: number | null;
  inicioEm: string;
  terminoEm: string;
}) {
  return (
    <div className="cartao cartao--previa">
      <div className="cartao__media">
        {foto ? (
          <img src={foto.url} alt="" className="cartao__imagem" />
        ) : (
          <span className="cartao__sem-foto">
            <ImageIcon size={28} aria-hidden="true" />
            <span>Sem foto</span>
          </span>
        )}
        <span className="cartao__selo">
          <Selo status="AGENDADO" />
        </span>
      </div>
      <div className="cartao__corpo">
        <p className="cartao__categoria">{categoria || 'Categoria'}</p>
        <h3 className="cartao__titulo">{nome || 'Nome do item'}</h3>
        <p className="cartao__preco">{precoCentavos !== null ? reais(precoCentavos) : 'R$ —'}</p>
        <div className="cartao__meta">
          <span>Abre em {dataHora(inicioEm)}</span>
          <span>Termina em {dataHora(terminoEm)}</span>
        </div>
      </div>
    </div>
  );
}

function Bloco({ titulo, descricao, children }: { titulo: string; descricao?: string; children: React.ReactNode }) {
  return (
    <section className="bloco">
      <div className="bloco__cabecalho">
        <h2>{titulo}</h2>
        {descricao && <p>{descricao}</p>}
      </div>
      <div className="bloco__corpo">{children}</div>
    </section>
  );
}

/** RF05/RF23/RF28: criar, editar ou relistar um leilão. Limites e categorias vêm do servidor (RF06). */
export function NovoLeilao({ acao = 'criar', leilao }: { acao?: AcaoDoFormulario; leilao?: Leilao }) {
  const acrescentando = acao === 'editar' && leilao?.eu?.edicao === 'ACRESCENTAR_DESCRICAO';
  useTitulo(acrescentando ? 'Complementar descrição' : acao === 'editar' ? 'Editar leilão' : acao === 'relistar' ? 'Relistar item' : 'Anunciar item');
  const navegar = useNavigate();
  const { usuario } = useSessao();
  const [config, setConfig] = useState<Config | null>(null);
  const [erroConfig, setErroConfig] = useState('');
  const [nome, setNome] = useState(leilao?.item.nome ?? '');
  const [descricao, setDescricao] = useState(leilao?.item.descricao ?? '');
  const [categoria, setCategoria] = useState(leilao?.item.categoria ?? '');
  const [fotos, setFotos] = useState<Foto[]>(leilao?.item.fotos ?? []);
  const [preco, setPreco] = useState(
    leilao
      ? centavosParaTexto(
          acao === 'relistar' ? (leilao.precoAtualCentavos ?? leilao.precoInicialCentavos) : leilao.precoInicialCentavos,
        )
      : '',
  );
  const [inicio, setInicio] = useState(acao === 'editar' ? 0 : 60);
  const [dataEscolhida, setDataEscolhida] = useState(
    acao === 'editar' && leilao ? paraInputLocal(new Date(leilao.inicioEm)) : '',
  );
  const [duracao, setDuracao] = useState(
    leilao
      ? Math.max(
          60,
          Math.round(
            (new Date(leilao.terminoOriginalEm).getTime() - new Date(leilao.inicioEm).getTime()) / 1000,
          ),
        )
      : 180,
  );
  const [acrescimo, setAcrescimo] = useState('');
  const [campos, setCampos] = useState<Record<string, string>>({});
  const [erroFotos, setErroFotos] = useState('');
  const [erro, setErro] = useState('');
  const [enviandoFotos, setEnviandoFotos] = useState(0);
  const [salvando, setSalvando] = useState(false);
  const inputFotos = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Config>('/config')
      .then((c) => {
        setConfig(c);
        const duracoesValidas = DURACOES.filter(
          (o) => o.segundos >= c.limites.duracaoSegundos.min && o.segundos <= c.limites.duracaoSegundos.max,
        );
        const duracaoValida =
          acao === 'criar' || duracao < c.limites.duracaoSegundos.min || duracao > c.limites.duracaoSegundos.max;
        if (duracaoValida) {
          const escolhida = duracoesValidas.find((o) => o.segundos === 180) ?? duracoesValidas[0];
          setDuracao(escolhida?.segundos ?? c.limites.duracaoSegundos.min);
        }
        const iniciosValidos = INICIOS.filter(
          (o) =>
            o.segundos >= c.limites.antecedenciaSegundos.min && o.segundos <= c.limites.antecedenciaSegundos.max,
        );
        if (inicio > 0 && !iniciosValidos.some((o) => o.segundos === inicio)) {
          setInicio(iniciosValidos[0]?.segundos ?? 0);
        }
      })
      .catch((e) => setErroConfig(e.message));
  }, []);

  const limites = config?.limites;
  const inicioOpcoes = useMemo(() => {
    if (!limites) return INICIOS;
    return INICIOS.filter((o) => o.segundos >= limites.antecedenciaSegundos.min && o.segundos <= limites.antecedenciaSegundos.max);
  }, [limites]);
  const duracaoOpcoes = useMemo(() => {
    if (!limites) return DURACOES;
    const filtradas = DURACOES.filter(
      (o) => o.segundos >= limites.duracaoSegundos.min && o.segundos <= limites.duracaoSegundos.max,
    );
    const base =
      filtradas.length > 0
        ? filtradas
        : [
            { rotulo: tempo(limites.duracaoSegundos.min * 1000), segundos: limites.duracaoSegundos.min },
            { rotulo: tempo(limites.duracaoSegundos.max * 1000), segundos: limites.duracaoSegundos.max },
          ];
    if (duracao && !base.some((o) => o.segundos === duracao)) {
      base.unshift({ rotulo: tempo(duracao * 1000), segundos: duracao });
    }
    return base;
  }, [limites, duracao]);

  const categoriaSelecionada = config?.categorias.find((c) => c.id === categoria) ?? null;
  const precoCentavos = paraCentavos(preco);
  const inicioEm = useMemo(() => {
    if (!config) return new Date().toISOString();
    if (inicio > 0) return new Date(agoraNoServidor() + inicio * 1000).toISOString();
    return dataEscolhida ? new Date(dataEscolhida).toISOString() : new Date().toISOString();
  }, [config, inicio, dataEscolhida]);
  const terminoEm = useMemo(
    () => new Date(new Date(inicioEm).getTime() + duracao * 1000).toISOString(),
    [inicioEm, duracao],
  );

  async function escolherFotos(arquivos: FileList | null) {
    if (!arquivos || !limites) return;
    setErroFotos('');
    const restantes = limites.fotos.max - fotos.length;
    const lista = Array.from(arquivos);
    if (lista.length > restantes) {
      setErroFotos(`Você pode enviar no máximo ${limites.fotos.max} fotos.`);
    }
    for (const arquivo of lista.slice(0, Math.max(0, restantes))) {
      if (!limites.fotos.tipos.includes(arquivo.type)) {
        setErroFotos(`${arquivo.name}: use JPEG, PNG ou WebP.`);
        continue;
      }
      if (arquivo.size > limites.fotos.tamanhoMaxBytes) {
        setErroFotos(`${arquivo.name}: o limite é ${Math.floor(limites.fotos.tamanhoMaxBytes / 1024 / 1024)} MB.`);
        continue;
      }
      setEnviandoFotos((n) => n + 1);
      try {
        const formulario = new FormData();
        formulario.append('arquivo', arquivo);
        const r = await api<{ foto: Foto }>('/fotos', { formulario });
        setFotos((f) => [...f, r.foto]);
      } catch (e) {
        setErroFotos(`${arquivo.name}: ${(e as Error).message}`);
      } finally {
        setEnviandoFotos((n) => n - 1);
      }
    }
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (acao !== 'criar' && !leilao) return;
    setErro('');
    setCampos({});
    if (precoCentavos === null) {
      setCampos({ precoInicialCentavos: 'Informe o valor em reais, por exemplo 150,00.' });
      return;
    }
    if (fotos.length < (limites?.fotos.min ?? 3)) {
      setErroFotos(`Envie pelo menos ${limites?.fotos.min ?? 3} fotos.`);
      return;
    }
    if (inicio === 0 && !dataEscolhida) {
      setCampos({ inicioEm: 'Escolha a data e a hora de início.' });
      return;
    }
    const quando = inicio === 0 ? new Date(dataEscolhida) : new Date(agoraNoServidor() + inicio * 1000);
    if (Number.isNaN(quando.getTime())) {
      setCampos({ inicioEm: 'Data inválida. Escolha outra.' });
      return;
    }
    setSalvando(true);
    try {
      const caminho =
        acao === 'criar' ? '/leiloes' : acao === 'editar' ? `/leiloes/${leilao!.id}` : `/leiloes/${leilao!.id}/relistar`;
      const metodo = acao === 'editar' ? 'PATCH' : 'POST';
      const r = await api<{ leilao: { id: number } }>(caminho, {
        metodo,
        corpo: {
          nome,
          descricao,
          categoria,
          fotoIds: fotos.map((f) => f.id),
          precoInicialCentavos: precoCentavos,
          inicioEm: quando.toISOString(),
          duracaoSegundos: duracao,
        },
      });
      const estado = acao === 'editar' ? { editado: true } : acao === 'relistar' ? { relistado: true } : { criado: true };
      navegar(`/leiloes/${r.leilao.id}`, { state: estado });
    } catch (falha) {
      const f = falha as ErroApi;
      setCampos(f.campos ?? {});
      if (!f.campos || Object.keys(f.campos).length === 0) setErro(f.message);
    } finally {
      setSalvando(false);
    }
  }

  async function salvarAcrescimo(e: FormEvent) {
    e.preventDefault();
    if (!leilao) return;
    setErro('');
    setCampos({});
    if (!acrescimo.trim()) {
      setCampos({ acrescimoDescricao: 'Escreva o complemento da descrição.' });
      return;
    }
    setSalvando(true);
    try {
      const r = await api<{ leilao: { id: number } }>(`/leiloes/${leilao.id}`, {
        metodo: 'PATCH',
        corpo: { acrescimoDescricao: acrescimo },
      });
      navegar(`/leiloes/${r.leilao.id}`, { state: { editado: true } });
    } catch (falha) {
      const f = falha as ErroApi;
      setCampos(f.campos ?? {});
      if (!f.campos || Object.keys(f.campos).length === 0) setErro(f.message);
    } finally {
      setSalvando(false);
    }
  }

  if (erroConfig) {
    return (
      <div className="pagina pagina--estreita">
        <Aviso tipo="erro" titulo="Não foi possível carregar as regras">
          {erroConfig}
        </Aviso>
        <VoltarLink para="/">Catálogo</VoltarLink>
      </div>
    );
  }

  if (!config || !limites) {
    return (
      <div className="pagina">
        <p className="carregando">Carregando regras do leilão…</p>
      </div>
    );
  }

  if (acrescentando && leilao) {
    const restante = limites.descricao.max - leilao.item.descricao.length;
    return (
      <div className="pagina pagina--estreita">
        <div className="detalhe__trilha">
          <VoltarLink para={`/leiloes/${leilao.id}`}>Voltar ao leilão</VoltarLink>
          <span aria-hidden="true">/</span>
          <span>Complementar descrição</span>
        </div>

        <div className="novo__cabecalho">
          <h1>Complementar descrição</h1>
          <p>
            O leilão já está em andamento. Só é possível acrescentar texto ao fim da descrição; o que já existe não
            muda.
          </p>
        </div>

        {erro && (
          <Aviso tipo="erro" titulo="Não foi possível complementar">
            {erro}
          </Aviso>
        )}

        <form onSubmit={salvarAcrescimo} noValidate>
          <section className="bloco">
            <div className="bloco__cabecalho">
              <h2>Descrição atual</h2>
              <p>O complemento entra depois deste texto.</p>
            </div>
            <div className="bloco__corpo">
              <p className="acrescimo__atual">{leilao.item.descricao}</p>
              <TextArea
                id="acrescimo"
                labelText="Complemento"
                value={acrescimo}
                onChange={(e) => setAcrescimo(e.target.value)}
                maxLength={Math.max(1, restante)}
                rows={4}
                invalid={Boolean(campos.acrescimoDescricao)}
                invalidText={campos.acrescimoDescricao}
                helperText={
                  restante > 0
                    ? `Restam ${restante.toLocaleString('pt-BR')} caracteres no limite da descrição.`
                    : 'A descrição já está no limite; não há espaço para complemento.'
                }
                placeholder="Informação nova sobre conservação, procedência ou envio."
              />
              <div className="novo__acoes">
                <Button type="submit" kind="primary" renderIcon={ArrowRight} disabled={salvando || restante <= 0}>
                  {salvando ? 'Salvando…' : 'Acrescentar à descrição'}
                </Button>
                <Button as={Link} to={`/leiloes/${leilao.id}`} kind="tertiary" disabled={salvando}>
                  Cancelar
                </Button>
              </div>
            </div>
          </section>
        </form>
      </div>
    );
  }

  const antecedenciaMin = new Date(agoraNoServidor() + limites.antecedenciaSegundos.min * 1000);
  const fotosRestantes = limites.fotos.max - fotos.length;

  return (
    <div className="pagina">
      <div className="detalhe__trilha">
        <VoltarLink para={leilao ? `/leiloes/${leilao.id}` : '/'}>
          {leilao ? 'Voltar ao leilão' : 'Catálogo'}
        </VoltarLink>
        <span aria-hidden="true">/</span>
        <span>{acao === 'editar' ? 'Editar leilão' : acao === 'relistar' ? 'Relistar item' : 'Anunciar item'}</span>
      </div>

      <div className="novo__cabecalho">
        <div>
          <h1>{acao === 'editar' ? 'Editar leilão' : acao === 'relistar' ? 'Relistar item' : 'Anunciar item'}</h1>
          <p>
            {acao === 'editar'
              ? 'Altere os dados do anúncio. O item continua o mesmo; o leilão mantém o histórico.'
              : acao === 'relistar'
                ? 'Crie um novo leilão para o mesmo item. O anúncio anterior fica no histórico.'
                : 'Descreva o item, envie fotos e defina o preço inicial. A sala abre sozinha no horário marcado e o fechamento é automático.'}
          </p>
        </div>
      </div>

      {erro && (
        <Aviso tipo="erro" titulo={acao === 'editar' ? 'Não foi possível salvar' : acao === 'relistar' ? 'Não foi possível relistar' : 'Não foi possível criar o leilão'}>
          {erro}
        </Aviso>
      )}

      <form className="novo" onSubmit={salvar} noValidate>
        <div className="novo__formulario">
          <Bloco titulo="O item" descricao="O nome e a descrição aparecem no catálogo e na sala.">
            <TextInput
              id="nome"
              labelText="Nome do item"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              maxLength={limites.nomeItem.max}
              invalid={Boolean(campos.nome)}
              invalidText={campos.nome}
              helperText={`De ${limites.nomeItem.min} a ${limites.nomeItem.max} caracteres.`}
              placeholder="Ex.: Relógio automático dos anos 1970"
            />
            <TextArea
              id="descricao"
              labelText="Descrição"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              maxLength={limites.descricao.max}
              rows={5}
              invalid={Boolean(campos.descricao)}
              invalidText={campos.descricao}
              helperText={`De ${limites.descricao.min} a ${limites.descricao.max} caracteres.`}
              placeholder="Estado de conservação, procedência, medidas e o que está incluso."
            />
            <Dropdown
              id="categoria"
              titleText="Categoria"
              label="Escolha uma categoria"
              items={config.categorias}
              itemToString={(item) => (item ? item.nome : '')}
              selectedItem={categoriaSelecionada}
              onChange={({ selectedItem }) => setCategoria(selectedItem?.id ?? '')}
              invalid={Boolean(campos.categoria)}
              invalidText={campos.categoria}
            />
          </Bloco>

          <Bloco
            titulo="Fotos"
            descricao={`De ${limites.fotos.min} a ${limites.fotos.max} imagens. A primeira será a capa do anúncio.`}
          >
            <div className="fotos">
              <input
                ref={inputFotos}
                type="file"
                accept={limites.fotos.tipos.join(',')}
                multiple
                aria-label="Selecionar fotos do item"
                className="sr-only"
                onChange={(e) => {
                  void escolherFotos(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="fotos__area"
                onClick={() => inputFotos.current?.click()}
                disabled={enviandoFotos > 0 || fotosRestantes <= 0}
              >
                <span className="fotos__icone" aria-hidden="true">
                  <Add size={24} />
                </span>
                <span className="fotos__titulo">
                  {fotosRestantes > 0 ? 'Adicionar fotos' : 'Limite de fotos atingido'}
                </span>
                <span className="fotos__dica">
                  JPEG, PNG ou WebP, até {Math.floor(limites.fotos.tamanhoMaxBytes / 1024 / 1024)} MB cada.
                  {' '}
                  {fotosRestantes > 0 && `${fotosRestantes} ${fotosRestantes === 1 ? 'vaga' : 'vagas'} restantes.`}
                </span>
              </button>

              {(fotos.length > 0 || enviandoFotos > 0) && (
                <ul className="fotos__lista" aria-label="Fotos enviadas">
                  {fotos.map((f, i) => (
                    <li key={f.id} className="fotos__item">
                      <img src={f.url} alt="" />
                      {i === 0 && <span className="fotos__capa">Capa</span>}
                      <Button
                        className="fotos__remover"
                        kind="ghost"
                        size="sm"
                        hasIconOnly
                        renderIcon={Close}
                        iconDescription="Remover foto"
                        onClick={() => setFotos((lista) => lista.filter((x) => x.id !== f.id))}
                      />
                    </li>
                  ))}
                  {enviandoFotos > 0 && (
                    <li className="fotos__item fotos__item--enviando">
                      <span>Enviando {enviandoFotos}…</span>
                    </li>
                  )}
                </ul>
              )}
            </div>
            {erroFotos && <p className="campo-erro">{erroFotos}</p>}
            {campos.fotos && <p className="campo-erro">{campos.fotos}</p>}
          </Bloco>

          <Bloco titulo="Leilão" descricao="O preço inicial é o valor mínimo do primeiro lance.">
            <TextInput
              id="preco"
              labelText="Preço inicial (R$)"
              inputMode="decimal"
              placeholder="150,00"
              value={preco}
              onChange={(e) => setPreco(e.target.value)}
              invalid={Boolean(campos.precoInicialCentavos)}
              invalidText={campos.precoInicialCentavos}
              helperText={`A partir de ${reais(limites.precoInicialCentavos.min)}.`}
            />

            <RadioButtonGroup
              legendText="Início"
              name="inicio"
              valueSelected={inicio}
              onChange={(v) => {
                setInicio(Number(v));
                setCampos((c) => ({ ...c, inicioEm: '' }));
              }}
              invalid={Boolean(campos.inicioEm)}
              invalidText={campos.inicioEm}
            >
              {inicioOpcoes.map((o) => (
                <RadioButton key={o.segundos} id={`inicio-${o.segundos}`} labelText={o.rotulo} value={o.segundos} />
              ))}
              <RadioButton id="inicio-custom" labelText="Escolher data e hora" value={0} />
            </RadioButtonGroup>

            {inicio === 0 && (
              <div className="inicio-custom">
                <TextInput
                  id="data-escolhida"
                  type="datetime-local"
                  labelText="Data e hora de início"
                  value={dataEscolhida}
                  min={paraInputLocal(antecedenciaMin)}
                  onChange={(e) => setDataEscolhida(e.target.value)}
                  invalid={Boolean(campos.inicioEm)}
                  invalidText={campos.inicioEm}
                  helperText={`No seu fuso (${fusoLocal}). Antecedência mínima: ${tempo(limites.antecedenciaSegundos.min * 1000)}.`}
                />
              </div>
            )}

            <Dropdown
              id="duracao"
              titleText="Duração"
              label="Escolha a duração"
              items={duracaoOpcoes}
              itemToString={(item) => (item ? item.rotulo : '')}
              selectedItem={duracaoOpcoes.find((o) => o.segundos === duracao) ?? duracaoOpcoes[0]}
              onChange={({ selectedItem }) => selectedItem && setDuracao(selectedItem.segundos)}
              invalid={Boolean(campos.duracaoSegundos)}
              invalidText={campos.duracaoSegundos}
            />
          </Bloco>

          <div className="novo__acoes">
            <Button type="submit" kind="primary" renderIcon={ArrowRight} disabled={salvando || enviandoFotos > 0}>
              {salvando
                ? acao === 'editar'
                  ? 'Salvando…'
                  : acao === 'relistar'
                    ? 'Relistando…'
                    : 'Criando…'
                : acao === 'editar'
                  ? 'Salvar alterações'
                  : acao === 'relistar'
                    ? 'Criar novo leilão'
                    : 'Criar leilão'}
            </Button>
            <Button as={Link} to={leilao ? `/leiloes/${leilao.id}` : '/'} kind="tertiary" disabled={salvando}>
              Cancelar
            </Button>
            <p>
              {acao === 'editar'
                ? 'As alterações são publicadas imediatamente.'
                : acao === 'relistar'
                  ? 'O novo leilão é publicado imediatamente no catálogo.'
                  : 'O leilão é publicado imediatamente no catálogo.'}
            </p>
          </div>
        </div>

        <aside className="novo__previa" aria-label="Prévia do anúncio">
          <p className="novo__previa-rotulo">Prévia do anúncio</p>
          <Previa
            nome={nome}
            categoria={categoriaSelecionada?.nome ?? ''}
            foto={fotos[0]}
            precoCentavos={precoCentavos}
            inicioEm={inicioEm}
            terminoEm={terminoEm}
          />
          <div className="novo__dicas">
            <h2>O que a banca vai ver</h2>
            <ul>
              <li>Fotos reais do item, com a primeira como capa.</li>
              <li>Preço inicial e duração claros antes de publicar.</li>
              <li>A sala abre e fecha sozinha, pelo relógio do servidor.</li>
            </ul>
            <p>Comitente: {usuario?.nome ?? 'você'}.</p>
          </div>
        </aside>
      </form>
    </div>
  );
}
