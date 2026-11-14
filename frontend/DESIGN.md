# Design — Cati Leilões

## Ideia

Uma casa de leilões que parece uma casa de leilões, não um dashboard genérico. O produto é uma tela de operação: o visitante precisa entender o item, o preço e o prazo em segundos, e dar lance sem procurar. A identidade vem de três decisões:

1. **Cabeçalho escuro e tipografia serifada** — a marca "Cati" e os títulos em IBM Plex Serif dão o tom editorial de catálogo; o corpo em Plex Sans mantém a legibilidade de aplicação.
2. **Painel ao vivo escuro** — preço, contagem, líder e lance mínimo ficam num bloco de alto contraste, separado do restante da página. O olho vai direto para o que muda.
3. **Destaque com a foto real do item** — a home usa o leilão em andamento como assunto principal, com o preço e a contagem sobre a imagem. Nada de ilustração genérica.

## Sistema

- **Carbon** é a autoridade dos componentes: botões, tags, inputs, dropdowns, modal, paginação, notificações, accordion e ícones.
- **Tailwind** entra apenas como utilitário de layout; o preflight foi desligado para não brigar com o reset do Carbon.
- **Tokens próprios** ficam em `:root` (`src/estilo.css`) e apontam para a paleta do Carbon: papel `#f4f4f4`, tinta `#161616`, azul de ação `#0f62fe`, verde de "ao vivo" `#24a148`, vermelho de erro `#da1e28`, roxo de "vendido" `#8a3ffc`.
- **Tipografia**: Plex Serif para títulos e preços; Plex Sans para texto; Plex Mono para contagem, horários e valores tabulares.
- **Cantos retos** (raio 0) e bordas de 1px, como o Carbon. A hierarquia vem de escala, peso e espaço, não de sombras coloridas.
- **Largura máxima** de 1312px, com gutters que crescem em telas largas.
- **Breakpoints**: 1100px (relógio do header), 980px (uma coluna), 720px (filtros, ficha e header compactos) e 480px (ajustes de cartão).

## Telas

### Home / catálogo

- Abertura curta: uma frase, dois CTAs e um destaque com o leilão ao vivo (foto, preço, contagem).
- Estatísticas reais de `/api/leiloes`: ao vivo e agendados. Não há número inventado.
- Filtros por situação e categoria, busca por nome e persistência na URL (`?status=...&categoria=...&q=...`).
- Grade de cartões com status, categoria, preço, contagem e total de lances. Paginação Carbon.
- Atualização automática a cada 5 s.

### Detalhe

- Galeria com miniaturas e navegação por teclado.
- Painel de preço com "Ao vivo", contagem precisa e prorrogação.
- Ficha com comitente, lance mínimo, início, término, total e líder.
- CTA para a sala; cancelamento com modal de confirmação; resultado do leilão.
- Regras em accordion: incremento, prorrogação, quem pode dar lance e relógio.

### Sala

- No desktop, item à esquerda e disputa à direita; no mobile, a disputa vem primeiro, porque o objetivo é dar lance.
- Painel escuro com preço atual, contagem, líder, mínimo, total, presença e status da conexão.
- Formulário com sugestões de lance calculadas a partir de `/api/config`.
- Modo espectador: acompanha preço, lances e presença; pode virar participante sem sair da sala.
- Aviso de "seu lance foi superado" (evento `lance:superado`), confirmação de lance aceito e resumo acessível para leitores de tela.
- Lista dos últimos lances, com o seu lance destacado.
- Reconexão automática do Socket.IO; estado fora de ordem é descartado pela `versao`; `sala:item` recarrega a descrição editada.

### Anunciar item

- Formulário em blocos: item, fotos e leilão.
- Limites e categorias vindos da API.
- Upload com validação de tipo/tamanho, capa e remoção.
- Prévia do anúncio ao vivo, com o mesmo cartão do catálogo.
- Início por atalho (1 min, 5 min, 1 h, 1 dia) ou data/hora no fuso local.

### Comitentes

- Busca por nome de exibição e lista com data de entrada e quantidade de leilões.
- Perfil público com leilões em andamento, agendados e encerrados; sem e-mail e sem reputação.
- O nome do comitente no detalhe e na sala leva ao perfil.

### Participações

- Lista os leilões em que o usuário deu lance, com situação (liderando, superado, vencedor, não venceu).
- Filtro por situação, paginação local e atualização automática a cada 8 s.
- Mostra o maior lance do usuário, o preço atual/final e o total de lances.

### Editar e relistar

- **Editar tudo**: só para leilão agendado com mais de 30 min; o formulário vem preenchido e mantém fotos.
- **Complementar descrição**: para leilão em andamento; só acrescenta texto ao fim, sem alterar o que existe.
- **Relistar**: novo leilão para o mesmo item a partir de encerrado sem lances ou cancelado; o anterior fica no histórico.
- A política de edição vem de `eu.edicao`; a tela não tenta adivinhar permissão.

### Bônus 7.1 — pontuação, comitente e crédito

- **Cadastro** pede a renda mensal em reais, convertida para centavos; a API devolve o erro no campo certo.
- **Pontuação** (0–100) fica fixa no cabeçalho, ao lado do nome; no menu mobile aparece como "Pontuação: X de 100".
- **Quero vender** substitui "Anunciar item" para quem ainda não é comitente. Com 50 pontos, habilita e abre o formulário; abaixo disso, um modal explica a pontuação e o mínimo.
- **Crédito disponível** aparece no formulário de lance e é reavaliado a cada `sala:estado`, depois do meu lance e ao ser superado.
- **Sem crédito**, a sala coloca a pessoa como espectadora e mostra o aviso do servidor; tentar virar participante exibe o motivo e o disponível, sem trocar o papel.
- **Minhas participações** mostra o total reservado nos leilões em que o usuário lidera e o disponível.

### Minha conta (pontuação, crédito e compras)

- Página `/minha-conta`, aberta pela pontuação no cabeçalho.
- **Anel de pontuação** com a marca do mínimo para vender e as quatro parcelas do RF29 em barras (renda, tempo de conta, compras, total comprado), com os tetos de cada uma.
- **Crédito** em bloco escuro: disponível, limite, reservado e a regra em uma frase.
- **Liderando agora** (reservas) e **Histórico de compras**, vindos de `GET /api/eu/compras`.
- "Quero vender" aparece aqui quando a pontuação permite; abaixo do mínimo, diz quantos pontos faltam.

### Sensação de "ao vivo"

- Selo **Ao vivo** com ponto pulsante e **barra de tempo** nos cartões, no destaque e na sala; a barra fica vermelha no último minuto.
- Na sala, o preço se destaca a cada novo lance, uma faixa diz se você **está na frente** ou se **cobriram seu lance** (com o valor para voltar), e um gráfico mostra a evolução do preço nos últimos lances.
- O formulário de lance mostra o crédito em barra: reservado em outros leilões, este lance e o limite.
- Cada lance novo entra na lista com animação; o da frente leva a etiqueta "na frente".
- Catálogo com fichas de categoria com ícone, chamada no hover do cartão e a faixa "Como funciona" com as três garantias.
- Fotos de demonstração: o seed desenha a silhueta de cada item em cena de estúdio (`backend/src/png.ts`), em três enquadramentos.

### Conta

- Split screen: painel escuro com a proposta e fatos do produto; formulário branco.
- Contas de demonstração clicáveis para a banca (senha `demo1234`).
- Redirecionamento seguro de volta (`volta` só aceita caminho interno).

## Movimento e estados

- Hover de cartão com elevação e leve zoom na imagem; anel de foco visível em tudo.
- Pulso apenas no indicador de conexão real da sala.
- `prefers-reduced-motion` desliga animações e transições.
- Estados de carregamento (skeleton), vazio, erro, desabilitado, enviando e reconectando.

## Fora de escopo desta entrega

- Bônus 7.2 de nuvem/operação: banco gerenciado, HTTPS com domínio, deploy automatizado, várias instâncias, métricas e teste de carga.
- Tema escuro global; o escuro é reservado ao cabeçalho, ao painel ao vivo e ao rodapé.
