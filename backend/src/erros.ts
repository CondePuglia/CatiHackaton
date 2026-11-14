/** Erro de negócio com status HTTP, código estável e mensagem para o usuário. */
export class ErroApp extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    mensagem: string,
    public readonly campos?: Record<string, string>,
  ) {
    super(mensagem);
    this.name = 'ErroApp';
  }
}

export const naoAutenticado = () =>
  new ErroApp(401, 'NAO_AUTENTICADO', 'Faça login para continuar.');

export const proibido = (mensagem: string, codigo = 'PROIBIDO') => new ErroApp(403, codigo, mensagem);

export const naoEncontrado = (o: string) => new ErroApp(404, 'NAO_ENCONTRADO', `${o} não encontrado.`);

export const conflito = (codigo: string, mensagem: string) => new ErroApp(409, codigo, mensagem);
