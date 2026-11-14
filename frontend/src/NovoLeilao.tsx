import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Aviso, Campo, ErroApi, agoraNoServidor, api, botao, campo, fusoLocal, paraCentavos, reais, tempo } from './comuns';

type Foto = { id: number; url: string };

const INICIOS = [
  { rotulo: 'Em 1 minuto', segundos: 60 },
  { rotulo: 'Em 5 minutos', segundos: 300 },
  { rotulo: 'Em 1 hora', segundos: 3600 },
  { rotulo: 'Escolher data e hora', segundos: 0 },
];
const DURACOES = [
  { rotulo: '3 minutos', segundos: 180 },
  { rotulo: '10 minutos', segundos: 600 },
  { rotulo: '1 hora', segundos: 3600 },
  { rotulo: '1 dia', segundos: 86400 },
];

/** RF05: anunciar um item. Limites e categorias vêm do servidor (RF06). */
export function NovoLeilao() {
  const navegar = useNavigate();
  const [cfg, setCfg] = useState<any>(null);
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [categoria, setCategoria] = useState('');
  const [fotos, setFotos] = useState<Foto[]>([]);
  const [preco, setPreco] = useState('');
  const [inicio, setInicio] = useState(60);
  const [dataEscolhida, setDataEscolhida] = useState('');
  const [duracao, setDuracao] = useState(180);
  const [campos, setCampos] = useState<Record<string, string>>({});
  const [erro, setErro] = useState('');
  const [enviandoFotos, setEnviandoFotos] = useState(0);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api('/config').then(setCfg).catch((e) => setErro(e.message));
  }, []);

  async function escolherFotos(arquivos: FileList | null) {
    if (!arquivos) return;
    setCampos((c) => ({ ...c, fotos: '' }));
    for (const arquivo of Array.from(arquivos)) {
      setEnviandoFotos((n) => n + 1);
      try {
        const formulario = new FormData();
        formulario.append('arquivo', arquivo);
        const r = await api('/fotos', { formulario });
        setFotos((f) => [...f, r.foto]);
      } catch (e) {
        setCampos((c) => ({ ...c, fotos: `${arquivo.name}: ${(e as Error).message}` }));
      } finally {
        setEnviandoFotos((n) => n - 1);
      }
    }
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    const precoInicialCentavos = paraCentavos(preco);
    if (precoInicialCentavos === null) {
      setCampos({ precoInicialCentavos: 'Informe o valor em reais, por exemplo 150,00.' });
      return;
    }
    // O início é calculado com a hora do servidor; a data escolhida vai com o fuso do navegador.
    const inicioEm =
      inicio > 0
        ? new Date(agoraNoServidor() + inicio * 1000).toISOString()
        : dataEscolhida
          ? new Date(dataEscolhida).toISOString()
          : '';
    setSalvando(true);
    try {
      const r = await api('/leiloes', {
        corpo: { nome, descricao, categoria, fotoIds: fotos.map((f) => f.id), precoInicialCentavos, inicioEm, duracaoSegundos: duracao },
      });
      navegar(`/leiloes/${r.leilao.id}`);
    } catch (falha) {
      const f = falha as ErroApi;
      setCampos(f.campos ?? {});
      if (!f.campos || Object.keys(f.campos).length === 0) setErro(f.message);
    } finally {
      setSalvando(false);
    }
  }

  if (!cfg) return erro ? <Aviso>{erro}</Aviso> : <p className="text-sm text-slate-500">Carregando…</p>;
  const lim = cfg.limites;

  return (
    <form onSubmit={salvar} className="mx-auto max-w-2xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" noValidate>
      <h1 className="text-xl font-bold">Anunciar item</h1>
      {erro && <Aviso>{erro}</Aviso>}

      <Campo rotulo="Nome do item" erro={campos.nome} dica={`De ${lim.nomeItem.min} a ${lim.nomeItem.max} caracteres.`}>
        <input className={campo} value={nome} onChange={(e) => setNome(e.target.value)} maxLength={lim.nomeItem.max} />
      </Campo>

      <Campo rotulo="Descrição" erro={campos.descricao} dica={`De ${lim.descricao.min} a ${lim.descricao.max} caracteres.`}>
        <textarea className={campo} rows={4} value={descricao} onChange={(e) => setDescricao(e.target.value)} maxLength={lim.descricao.max} />
      </Campo>

      <Campo rotulo="Categoria" erro={campos.categoria}>
        <select className={campo} value={categoria} onChange={(e) => setCategoria(e.target.value)}>
          <option value="">Escolha…</option>
          {cfg.categorias.map((c: { id: string; nome: string }) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
      </Campo>

      <Campo
        rotulo={`Fotos (${fotos.length} de ${lim.fotos.min} a ${lim.fotos.max})`}
        erro={campos.fotos}
        dica={`JPEG, PNG ou WebP, até ${Math.floor(lim.fotos.tamanhoMaxBytes / 1024 / 1024)} MB cada.`}
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="block w-full text-sm"
          onChange={(e) => {
            void escolherFotos(e.target.files);
            e.target.value = '';
          }}
        />
      </Campo>
      {(fotos.length > 0 || enviandoFotos > 0) && (
        <ul className="flex flex-wrap gap-2">
          {fotos.map((f) => (
            <li key={f.id} className="relative">
              <img src={f.url} alt="" className="h-20 w-20 rounded-lg object-cover" />
              <button
                type="button"
                aria-label="Remover foto"
                className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-slate-800 text-xs text-white"
                onClick={() => setFotos((lista) => lista.filter((x) => x.id !== f.id))}
              >
                ×
              </button>
            </li>
          ))}
          {enviandoFotos > 0 && <li className="flex h-20 items-center px-2 text-xs text-slate-500">Enviando…</li>}
        </ul>
      )}

      <Campo
        rotulo="Preço inicial (R$)"
        erro={campos.precoInicialCentavos}
        dica={`Valor mínimo do primeiro lance. A partir de ${reais(lim.precoInicialCentavos.min)}.`}
      >
        <input className={campo} inputMode="decimal" placeholder="150,00" value={preco} onChange={(e) => setPreco(e.target.value)} />
      </Campo>

      <div className="grid gap-4 sm:grid-cols-2">
        <Campo rotulo="Início" erro={campos.inicioEm} dica={`Antecedência mínima: ${tempo(lim.antecedenciaSegundos.min * 1000)}.`}>
          <select className={campo} value={inicio} onChange={(e) => setInicio(Number(e.target.value))}>
            {INICIOS.map((o) => (
              <option key={o.segundos} value={o.segundos}>
                {o.rotulo}
              </option>
            ))}
          </select>
          {inicio === 0 && (
            <>
              <input className={`${campo} mt-2`} type="datetime-local" value={dataEscolhida} onChange={(e) => setDataEscolhida(e.target.value)} />
              <span className="mt-1 block text-xs text-slate-500">No seu fuso: {fusoLocal}.</span>
            </>
          )}
        </Campo>
        <Campo rotulo="Duração" erro={campos.duracaoSegundos}>
          <select className={campo} value={duracao} onChange={(e) => setDuracao(Number(e.target.value))}>
            {DURACOES.filter((o) => o.segundos >= lim.duracaoSegundos.min && o.segundos <= lim.duracaoSegundos.max).map((o) => (
              <option key={o.segundos} value={o.segundos}>
                {o.rotulo}
              </option>
            ))}
          </select>
        </Campo>
      </div>

      <button className={botao} disabled={salvando || enviandoFotos > 0}>
        {salvando ? 'Criando…' : 'Criar leilão'}
      </button>
    </form>
  );
}
