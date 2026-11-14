import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { gerarPng } from '../../src/png.js';

/**
 * Apoio dos testes de sistema. Eles são caixa-preta: falam com a pilha em pé
 * (proxy, API, worker, banco e bucket de verdade) só por HTTP e Socket.IO,
 * como o navegador. O acesso direto ao banco serve apenas para simular o que
 * não dá para esperar acontecer (uma sessão expirar) e para conferir o que
 * ficou gravado.
 */

export const URL_BASE = (process.env.URL_SISTEMA ?? 'http://localhost:8081').replace(/\/$/, '');
export const SENHA = 'senha-de-sistema';

export const banco = new pg.Pool({ connectionString: process.env.DATABASE_URL_SISTEMA, max: 3 });
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const chave = (): string => randomUUID();

export type Resposta = { status: number; corpo: any; cabecalhos: Headers };

export type Estado = {
  leilaoId: number;
  versao: number;
  status: string;
  agora: string;
  inicioEm: string;
  terminoEm: string;
  terminoOriginalEm: string;
  prorrogado: boolean;
  encerradoEm: string | null;
  precoInicialCentavos: number;
  precoAtualCentavos: number | null;
  lanceMinimoCentavos: number | null;
  totalLances: number;
  lider: { numero: number; apelido: string } | null;
  ultimosLances: Array<{ sequencia: number; numero: number; apelido: string; valorCentavos: number; em: string }>;
  resultado: any;
};

let configuracao: any = null;
/**
 * Limites em vigor no sistema, lidos da própria API. Guarda também a diferença
 * entre o relógio do servidor e o do teste: horários de leilão são sempre
 * calculados com o relógio do servidor.
 */
export async function configDoSistema(): Promise<any> {
  if (!configuracao) {
    const antes = Date.now();
    const cfg = (await (await fetch(`${URL_BASE}/api/config`)).json()) as any;
    cfg.defasagemMs = new Date(cfg.agora).getTime() - Math.round((antes + Date.now()) / 2);
    configuracao = cfg;
  }
  return configuracao;
}

export async function agoraNoServidor(): Promise<number> {
  return Date.now() + (await configDoSistema()).defasagemMs;
}

/** Espera a pilha responder (usado depois de subir ou reiniciar contêineres). */
export async function aguardarSistema(segundos = 60): Promise<void> {
  for (let i = 0; i < segundos * 2; i++) {
    try {
      const r = await fetch(`${URL_BASE}/api/saude`);
      if (r.ok) return;
    } catch {
      // ainda subindo
    }
    await dormir(500);
  }
  throw new Error(`o sistema não respondeu em ${URL_BASE} depois de ${segundos} s`);
}

/** Um "navegador": guarda o cookie de sessão e abre sockets com ele. */
export class Cliente {
  cookie = '';
  usuario!: { id: number; nome: string; email: string };
  private sockets: Socket[] = [];

  static async novo(nome = 'Pessoa', opcoes: { rendaCentavos?: number; comitente?: boolean } = {}): Promise<Cliente> {
    const c = new Cliente();
    const email = `${nome.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${randomUUID()}@sistema.dev`;
    const r = await c.req('POST', '/api/usuarios', {
      nome,
      email,
      senha: SENHA,
      rendaMensalCentavos: opcoes.rendaCentavos ?? 100_000_00,
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    c.usuario = r.corpo.usuario;
    if (opcoes.comitente ?? true) {
      const h = await c.req('POST', '/api/eu/comitente');
      assert.equal(h.status, 200, JSON.stringify(h.corpo));
    }
    return c;
  }

  /** Mesmo usuário, outro "navegador" (novo login, nova sessão). */
  async outroNavegador(): Promise<Cliente> {
    const c = new Cliente();
    const r = await c.req('POST', '/api/sessao', { email: this.usuario.email, senha: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    c.usuario = r.corpo.usuario;
    return c;
  }

  async req(metodo: string, caminho: string, corpo?: unknown): Promise<Resposta> {
    const r = await fetch(URL_BASE + caminho, {
      method: metodo,
      headers: {
        ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    this.guardarCookie(r.headers);
    const texto = await r.text();
    let json: any = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = texto;
    }
    return { status: r.status, corpo: json, cabecalhos: r.headers };
  }

  private guardarCookie(cabecalhos: Headers): void {
    for (const linha of cabecalhos.getSetCookie()) {
      const par = linha.split(';')[0];
      if (par.startsWith('sessao=')) this.cookie = par === 'sessao=' ? '' : par;
    }
  }

  async enviarFoto(dados: Buffer = gerarPng(16, 12, (x, y) => [x * 15, y * 20, 150]), nome = 'foto.png'): Promise<Resposta> {
    const formulario = new FormData();
    formulario.append('arquivo', new Blob([new Uint8Array(dados)], { type: 'image/png' }), nome);
    const r = await fetch(`${URL_BASE}/api/fotos`, {
      method: 'POST',
      headers: this.cookie ? { cookie: this.cookie } : {},
      body: formulario,
    });
    return { status: r.status, corpo: await r.json().catch(() => null), cabecalhos: r.headers };
  }

  async fotos(quantidade = 3): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < quantidade; i++) {
      const r = await this.enviarFoto();
      assert.equal(r.status, 201, JSON.stringify(r.corpo));
      ids.push(r.corpo.foto.id);
    }
    return ids;
  }

  /** Cria um leilão que abre em `inicioSegundos` e dura `duracaoSegundos`. */
  async criarLeilao(inicioSegundos: number, duracaoSegundos: number, extras: Record<string, unknown> = {}): Promise<any> {
    const fotoIds = await this.fotos();
    const r = await this.req('POST', '/api/leiloes', {
      nome: 'Câmera fotográfica antiga',
      descricao: 'Câmera analógica dos anos 70, funcionando, com estojo de couro.',
      categoria: 'eletronicos',
      fotoIds,
      precoInicialCentavos: 100_00,
      inicioEm: new Date((await agoraNoServidor()) + inicioSegundos * 1000).toISOString(),
      duracaoSegundos,
      ...extras,
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    return r.corpo.leilao;
  }

  conectar(opcoes: { reconectar?: boolean } = {}): Promise<Socket> {
    const socket = io(URL_BASE, {
      transports: ['websocket'],
      extraHeaders: this.cookie ? { cookie: this.cookie } : {},
      reconnection: opcoes.reconectar ?? false,
      reconnectionDelay: 200,
      reconnectionDelayMax: 500,
      forceNew: true,
    });
    this.sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (erro) => {
        if (!(opcoes.reconectar ?? false)) socket.close();
        reject(erro);
      });
    });
  }

  async entrar(leilaoId: number, opcoes: { reconectar?: boolean } = {}): Promise<Sala> {
    return Sala.entrar(await this.conectar(opcoes), leilaoId);
  }

  fechar(): void {
    for (const s of this.sockets) s.close();
    this.sockets = [];
  }
}

/** A sala vista por um socket: guarda todo estado recebido e deixa esperar por uma condição. */
export class Sala {
  readonly estados: Estado[] = [];
  eu: { papel: string; numero: number | null } = { papel: '', numero: null };
  private ouvintes = new Set<() => void>();

  private constructor(
    readonly socket: Socket,
    readonly leilaoId: number,
  ) {
    socket.on('sala:estado', (estado: Estado) => {
      if (estado.leilaoId !== leilaoId) return;
      this.estados.push(estado);
      for (const avisar of this.ouvintes) avisar();
    });
  }

  static async entrar(socket: Socket, leilaoId: number): Promise<Sala> {
    const sala = new Sala(socket, leilaoId);
    await sala.reentrar();
    return sala;
  }

  /** Emite sala:entrar (de novo, depois de uma reconexão) e guarda a fotografia devolvida. */
  async reentrar(): Promise<any> {
    const r = await this.socket.timeout(8000).emitWithAck('sala:entrar', { leilaoId: this.leilaoId });
    assert.equal(r.ok, true, JSON.stringify(r));
    this.eu = r.eu;
    this.estados.push(r.estado);
    for (const avisar of this.ouvintes) avisar();
    return r;
  }

  /** O estado mais novo que este socket conhece (maior versão). */
  get atual(): Estado {
    return this.estados.reduce((a, b) => (b.versao >= a.versao ? b : a));
  }

  aguardar(condicao: (e: Estado) => boolean, ms = 15_000, descricao = 'condição'): Promise<Estado> {
    return new Promise((resolve, reject) => {
      const conferir = () => {
        const achado = this.estados.find(condicao);
        if (!achado) return false;
        clearTimeout(timer);
        this.ouvintes.delete(conferir);
        resolve(achado);
        return true;
      };
      const timer = setTimeout(() => {
        this.ouvintes.delete(conferir);
        reject(new Error(`a sala não chegou em "${descricao}" em ${ms} ms; último estado: ${JSON.stringify(this.atual)}`));
      }, ms);
      if (!conferir()) this.ouvintes.add(conferir);
    });
  }

  lance(valorCentavos: number, k: string = chave()): Promise<any> {
    return this.socket.timeout(8000).emitWithAck('lance:enviar', { leilaoId: this.leilaoId, valorCentavos, chave: k });
  }
}

export async function linha(leilaoId: number): Promise<any> {
  const { rows } = await banco.query('SELECT * FROM leiloes WHERE id = $1', [leilaoId]);
  return rows[0];
}

export async function lancesGravados(leilaoId: number): Promise<any[]> {
  const { rows } = await banco.query('SELECT * FROM lances WHERE leilao_id = $1 ORDER BY sequencia', [leilaoId]);
  return rows;
}

export async function expirarSessoes(usuarioId: number): Promise<void> {
  await banco.query(`UPDATE sessoes SET expira_em = clock_timestamp() - interval '1 second' WHERE usuario_id = $1`, [
    usuarioId,
  ]);
}
