/**
 * Configuração central. Todo limite de negócio mora aqui e pode ser trocado por
 * variável de ambiente (RF06), sem mexer em código: é assim que a demo usa
 * leilões que abrem em 1 minuto e duram 3.
 */

function numero(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  const n = Number(bruto);
  if (!Number.isFinite(n)) throw new Error(`Variável de ambiente ${nome} inválida: "${bruto}"`);
  return n;
}

function texto(nome: string, padrao: string): string {
  const bruto = process.env[nome];
  return bruto === undefined || bruto.trim() === '' ? padrao : bruto.trim();
}

function opcional(nome: string): string | undefined {
  const bruto = process.env[nome];
  return bruto === undefined || bruto.trim() === '' ? undefined : bruto.trim();
}

function booleano(nome: string, padrao: boolean): boolean {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(bruto.trim().toLowerCase());
}

const HORA = 3600;
const DIA = 24 * HORA;

/** Decisão da equipe (RF05): categorias fixas, validadas no servidor. */
export const CATEGORIAS = [
  { id: 'eletronicos', nome: 'Eletrônicos' },
  { id: 'veiculos', nome: 'Veículos' },
  { id: 'imoveis', nome: 'Imóveis' },
  { id: 'arte', nome: 'Arte e colecionáveis' },
  { id: 'casa', nome: 'Casa e decoração' },
  { id: 'moda', nome: 'Moda e acessórios' },
  { id: 'esportes', nome: 'Esportes e lazer' },
  { id: 'outros', nome: 'Outros' },
] as const;

export const config = {
  porta: numero('PORT', 3000),
  databaseUrl: texto('DATABASE_URL', 'postgres://leilao:leilao@localhost:5432/leilao'),
  conexoesBanco: numero('DB_POOL', 20),
  /**
   * Banco gerenciado (Bônus 7.2) costuma exigir TLS. Vazio = sem TLS (banco na
   * rede interna do Compose); `verificar` = TLS conferindo o certificado;
   * `sem-verificar` = TLS sem conferir a cadeia (certificado próprio do provedor).
   */
  bancoSsl: texto('DB_SSL', ''),
  /** Se preenchido, GET /api/metricas exige `Authorization: Bearer <token>`. */
  metricasToken: opcional('METRICAS_TOKEN'),
  logLevel: texto('LOG_LEVEL', 'info'),

  /** RF02: 2 h sem uso encerram a sessão; cada uso renova; teto absoluto de 24 h. */
  sessao: {
    cookie: 'sessao',
    inatividadeSegundos: numero('SESSAO_INATIVIDADE_SEGUNDOS', 2 * HORA),
    maximoSegundos: numero('SESSAO_MAXIMO_SEGUNDOS', 24 * HORA),
    cookieSeguro: booleano('COOKIE_SEGURO', false),
  },

  /** RF05: limites de cadastro de leilão. */
  limites: {
    nomeUsuario: { min: 2, max: 40 },
    senha: { min: 8, max: 200 },
    nomeItem: { min: numero('ITEM_NOME_MIN', 3), max: numero('ITEM_NOME_MAX', 80) },
    descricao: { min: numero('ITEM_DESCRICAO_MIN', 10), max: numero('ITEM_DESCRICAO_MAX', 2000) },
    fotos: {
      min: numero('FOTOS_MIN', 3),
      max: numero('FOTOS_MAX', 8),
      tamanhoMaxBytes: numero('FOTO_TAMANHO_MAX_BYTES', 5 * 1024 * 1024),
      tipos: ['image/jpeg', 'image/png', 'image/webp'],
    },
    precoInicialCentavos: {
      min: numero('PRECO_INICIAL_MIN_CENTAVOS', 1_00),
      max: numero('PRECO_INICIAL_MAX_CENTAVOS', 1_000_000_000_00),
    },
    /** quanto tempo antes do início o leilão precisa ser criado */
    antecedenciaSegundos: {
      min: numero('ANTECEDENCIA_MIN_SEGUNDOS', 30),
      max: numero('ANTECEDENCIA_MAX_SEGUNDOS', 30 * DIA),
    },
    duracaoSegundos: {
      min: numero('DURACAO_MIN_SEGUNDOS', 60),
      max: numero('DURACAO_MAX_SEGUNDOS', 7 * DIA),
    },
    /** teto de qualquer lance: mantém os centavos longe do limite de inteiro seguro */
    lanceMaximoCentavos: 100_000_000_000_00,
  },

  /** RF15: lance com menos de `janela` no relógio leva o término para `janela` depois dele. */
  prorrogacao: {
    janelaSegundos: numero('PRORROGACAO_JANELA_SEGUNDOS', 120),
    maximoSegundos: numero('PRORROGACAO_MAXIMO_SEGUNDOS', 30 * 60),
  },

  lances: {
    /** RF09: quantos lances recentes a sala mostra */
    recentes: numero('LANCES_RECENTES', 10),
    /** RF13 (Nível 2): intervalo mínimo entre lances do mesmo usuário */
    intervaloMinimoMs: numero('LANCE_INTERVALO_MIN_MS', 500),
  },

  /** RF23 (Nível 2): a partir de quanto tempo antes do início a edição trava. */
  edicao: {
    bloqueioSegundos: numero('EDICAO_BLOQUEIO_SEGUNDOS', 30 * 60),
  },

  listagem: {
    porPagina: numero('LISTAGEM_POR_PAGINA', 12),
  },

  worker: {
    intervaloMs: numero('WORKER_INTERVALO_MS', 500),
  },

  /** RF07: serviço de armazenamento compatível com S3. */
  armazenamento: {
    bucket: texto('S3_BUCKET', 'leilao-fotos'),
    regiao: texto('AWS_REGION', texto('S3_REGION', 'us-east-1')),
    /** vazio = AWS S3 de verdade; preenchido = MinIO ou outro compatível */
    endpoint: opcional('S3_ENDPOINT'),
    estiloCaminho: booleano('S3_FORCE_PATH_STYLE', false),
    /** vazio = cadeia padrão da AWS (perfil da instância, por exemplo) */
    chaveAcesso: opcional('AWS_ACCESS_KEY_ID'),
    chaveSecreta: opcional('AWS_SECRET_ACCESS_KEY'),
    tokenSessao: opcional('AWS_SESSION_TOKEN'),
    criarBucket: booleano('S3_CRIAR_BUCKET', false),
    prefixo: texto('S3_PREFIXO', 'fotos'),
  },
};

export type Faixa = { min: number; max: number };
