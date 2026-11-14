import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, TextInput } from '@carbon/react';
import { ArrowRight, Time, Trophy, User } from '@carbon/icons-react';
import { api, ErroApi, paraCentavos, useTitulo, useSessao, type Usuario } from './comuns';
import { Aviso, Marca } from './ui';

const DEMO = [
  { email: 'carla@demo.dev', papel: 'Comitente habilitada' },
  { email: 'ana@demo.dev', papel: 'Conta antiga, crédito alto' },
  { email: 'bruno@demo.dev', papel: 'Crédito de R$ 2.700' },
  { email: 'caio@demo.dev', papel: 'Crédito de R$ 120, entra como espectador' },
];

function Formulario({ cadastro }: { cadastro: boolean }) {
  useTitulo(cadastro ? 'Criar conta' : 'Entrar');
  const { usuario, definir } = useSessao();
  const navegar = useNavigate();
  const [busca] = useSearchParams();
  const voltaBruta = busca.get('volta') || '/';
  const volta = voltaBruta.startsWith('/') && !voltaBruta.startsWith('//') ? voltaBruta : '/';
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [renda, setRenda] = useState('');
  const [erro, setErro] = useState<ErroApi | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (usuario) return <Navigate to={volta} replace />;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const rendaMensalCentavos = cadastro ? paraCentavos(renda) : undefined;
    if (cadastro && rendaMensalCentavos === null) {
      setErro(
        new ErroApi(422, 'VALIDACAO', 'Confira a renda mensal.', {
          rendaMensalCentavos: 'Informe a renda mensal em reais, por exemplo 3.000,00.',
        }),
      );
      return;
    }
    setEnviando(true);
    setErro(null);
    try {
      const r = await api<{ usuario: Usuario }>(cadastro ? '/usuarios' : '/sessao', {
        corpo: cadastro ? { nome, email, senha, rendaMensalCentavos } : { email, senha },
      });
      definir(r.usuario);
      navegar(volta, { replace: true });
    } catch (falha) {
      setErro(falha as ErroApi);
    } finally {
      setEnviando(false);
    }
  }

  function usarDemo(emailDemo: string) {
    setEmail(emailDemo);
    setSenha('demo1234');
    setErro(null);
  }

  const campos = erro?.campos ?? {};
  return (
    <div className="pagina conta">
      <section className="conta__marca" aria-labelledby="conta-titulo">
        <Marca />
        <h1 id="conta-titulo">Sua próxima disputa começa aqui.</h1>
        <p className="conta__frase">
          Entre para dar lances, acompanhar a sala em tempo real e fechar negócio quando o relógio do servidor chegar a
          zero.
        </p>
        <ul className="conta__fatos">
          <li>
            <Time size={18} aria-hidden="true" />
            <span>
              <strong>Lances em tempo real.</strong> Preço, líder e prazo mudam sem recarregar a página.
            </span>
          </li>
          <li>
            <Trophy size={18} aria-hidden="true" />
            <span>
              <strong>Fechamento automático.</strong> Ao terminar, o maior lance vence — sem intervenção manual.
            </span>
          </li>
          <li>
            <User size={18} aria-hidden="true" />
            <span>
              <strong>Identidade protegida.</strong> Na sala, todos aparecem como Participante N.
            </span>
          </li>
        </ul>
      </section>

      <section className="conta__formulario" aria-labelledby="form-titulo">
        <div className="conta__caixa">
          <h2 id="form-titulo">{cadastro ? 'Criar conta' : 'Entrar'}</h2>
          <p className="conta__apoio">
            {cadastro
              ? 'Informe nome, e-mail, senha e renda. A renda define seu limite de crédito e a pontuação para vender.'
              : 'Use a conta de demonstração ou entre com a sua.'}
          </p>

          {erro && Object.keys(campos).length === 0 && (
            <Aviso tipo="erro" titulo={cadastro ? 'Não foi possível criar a conta' : 'Não foi possível entrar'}>
              {erro.message}
            </Aviso>
          )}

          <form onSubmit={enviar} className="conta__form" noValidate>
            {cadastro && (
              <TextInput
                id="nome"
                labelText="Nome de exibição"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                autoComplete="name"
                invalid={Boolean(campos.nome)}
                invalidText={campos.nome}
                helperText="É o nome que aparece no catálogo e no histórico."
              />
            )}
            {cadastro && (
              <TextInput
                id="renda"
                labelText="Renda mensal (R$)"
                inputMode="decimal"
                value={renda}
                onChange={(e) => setRenda(e.target.value)}
                placeholder="3.000,00"
                invalid={Boolean(campos.rendaMensalCentavos)}
                invalidText={campos.rendaMensalCentavos}
                helperText="Usada para calcular sua pontuação e limite de crédito. Pode ser 0."
              />
            )}
            <TextInput
              id="email"
              type="email"
              labelText="E-mail"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              invalid={Boolean(campos.email)}
              invalidText={campos.email}
              placeholder="voce@exemplo.com"
            />
            <TextInput
              id="senha"
              type="password"
              labelText="Senha"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              autoComplete={cadastro ? 'new-password' : 'current-password'}
              invalid={Boolean(campos.senha)}
              invalidText={campos.senha}
              helperText={cadastro ? 'Pelo menos 8 caracteres.' : undefined}
            />
            <Button type="submit" kind="primary" renderIcon={ArrowRight} disabled={enviando} className="conta__enviar">
              {enviando ? 'Enviando…' : cadastro ? 'Criar conta' : 'Entrar'}
            </Button>
          </form>

          <p className="conta__troca">
            {cadastro ? 'Já tem conta? ' : 'Ainda não tem conta? '}
            <Link to={`${cadastro ? '/entrar' : '/cadastro'}?volta=${encodeURIComponent(volta)}`}>
              {cadastro ? 'Entrar' : 'Criar conta'}
            </Link>
          </p>

          {!cadastro && (
            <div className="demo">
              <div className="demo__cabecalho">
                <h3>Contas de demonstração</h3>
                <span>Senha: demo1234</span>
              </div>
              <p>Clique para preencher o formulário. São os dados do seed do hackathon.</p>
              <ul className="demo__lista">
                {DEMO.map((d) => (
                  <li key={d.email}>
                    <button type="button" onClick={() => usarDemo(d.email)}>
                      <span>
                        <strong>{d.email}</strong>
                        <small>{d.papel}</small>
                      </span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export const Entrar = () => <Formulario cadastro={false} />;
export const Cadastro = () => <Formulario cadastro />;
