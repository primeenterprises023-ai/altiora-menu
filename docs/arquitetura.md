# Arquitetura, segurança, privacidade e limites

Este documento explica **como o sistema está construído**, **o que o protege**, **em que pontos se afasta do que foi pedido** e, sobretudo,
**o que não foi testado**. Foi escrito para a pessoa que decide (e para quem vier programar depois), sem exageros: onde algo não foi verificado, diz-se.

## 1. Visão geral

```
Navegador (cliente, empregado, cozinha, gerente, Altiora)
        │  HTTPS
        ▼
Um único servidor (Bun + TypeScript)  ── API · páginas dos painéis · página comercial (HTML gerado no servidor) · ficheiros /a/<id> · tempo real (SSE)
        │
        ▼
PostgreSQL  ── todos os dados, incluindo fotografias e modelos 3D; segurança por restaurante dentro da própria base de dados (RLS)
```

- **Um só serviço.** O mesmo servidor entrega a página comercial, a aplicação web e a API. Não há separação «frontend na Vercel / backend no Render».
- **Dados.** Tudo está no PostgreSQL (esquema `altiora`). As migrações estão em `db/migrations/` (4 ficheiros) e aplicam-se sozinhas ao arrancar, sem apagar dados.
- **Aplicação web.** React 19, desenhada primeiro para telemóvel. O modo 3D (Three.js) só é descarregado quando alguém abre um prato em 3D.
- **Tempo real.** SSE (o servidor envia os eventos). Se a ligação falhar, os ecrãs voltam a consultar sozinhos a cada poucos segundos.

## 2. Quem pode ver o quê (isolamento entre restaurantes)

O pedido original exigia que um restaurante **nunca** veja dados de outro e que a Altiora **não tenha acesso indiscriminado** aos dados dos restaurantes. Foi resolvido assim:

- **Cada tabela tem RLS ativa** (regras de linha da própria base de dados). Cada pedido à API corre numa transação em que o servidor assume um de cinco perfis da base de dados —
  `altiora_public` (cliente), `altiora_waiter`, `altiora_kitchen`, `altiora_manager` e `altiora_platform` — e declara qual é o restaurante da pessoa.
  As regras da base de dados só deixam ver as linhas desse restaurante. **Mesmo que o código do servidor tivesse um erro**, a base de dados recusaria mostrar dados de outro restaurante.
- **O perfil da Altiora (`altiora_platform`) não lê pedidos, menus nem relatórios.** Vê os restaurantes, as assinaturas, os planos, os contactos comerciais, o registo das suas próprias ações e **números agregados**
  (contagens e espaço ocupado), fornecidos por funções que só devolvem totais.
- **Ao arrancar, o servidor verifica a segurança** (RLS ativa em todas as tabelas, perfis sem privilégios a mais). Se a verificação falhar, **recusa arrancar**, em vez de funcionar sem proteção.
- **Operações internas** (início de sessão, criar a primeira conta, consultas públicas por código de mesa) usam um caminho separado e curto, com funções que só devolvem o estritamente necessário.
- **Testes:** existem testes automáticos que tentam, com cada perfil, ler e escrever dados de outros restaurantes e que confirmam que a Altiora não lê pedidos (`server/test/*`), e um ensaio de ponta a ponta de isolamento (`e2e/specs/`).

## 3. Autenticação e sessões

- **Contas próprias** (não usa o Supabase Auth): palavra-passe com `scrypt`, mínimo 10 caracteres, lista de palavras-passe óbvias recusadas, tentativas limitadas por IP e por conta.
- **Sessões:** cookie `HttpOnly`, `SameSite=Lax` e `Secure` em produção; no servidor guarda-se só o **SHA-256** do código da sessão. Expiram por inatividade (12 h) e ao fim de 14 dias.
- **Palavras-passe temporárias** (gerente novo, equipa nova, reposição): mostradas **uma única vez** e obrigam a trocar no primeiro acesso. O gerente repõe a da equipa; a Altiora repõe a dos gerentes. Não há «recuperar por e-mail» (o sistema não envia e-mails).
- **Pedidos forjados entre sites (CSRF):** a API só aceita JSON, verifica a origem (`Origin`) de pedidos que alteram dados e o cookie é `SameSite`.
- **Cabeçalhos de segurança:** CSP sem scripts na própria página (`script-src 'self'`), HSTS em produção, `nosniff`, sem `Referer` (o endereço do menu da mesa contém um segredo), páginas só incorporáveis pelo próprio site.
- **Registos (logs):** nunca registam palavras-passe, códigos de sessão, códigos de mesa ou de pedido, cookies nem o endereço da base de dados.

## 4. Como um pedido é feito (e porque não se pode enganar o sistema)

1. O QR Code de cada mesa leva um **segredo aleatório de 128 bits**. Quem o lê abre uma **sessão de mesa** de duração limitada (`TABLE_SESSION_MINUTES`, 4 h por omissão). Se o código vazar, o gerente gera outro e o antigo morre.
2. O telemóvel envia **só o que escolheu** (prato, tamanho, extras, quantidade, nota). **Os preços e o total são sempre calculados no servidor**, com os dados do restaurante. O preço que o cliente viu nunca é aceite como verdade.
   Se um prato ficou esgotado ou um preço mudou entretanto, o servidor recusa e o telemóvel mostra o que mudou para o cliente confirmar.
3. Cada envio leva uma **chave de idempotência**: duplo toque, rede lenta ou resposta perdida **não criam dois pedidos**.
4. Limites por mesa (pedidos por preparar ao mesmo tempo; intervalo mínimo entre pedidos) e por IP contra abusos.
5. O pedido guarda o **nome e o preço de cada prato no momento do pedido** (mudar o menu não altera pedidos antigos).
6. **Estados:** novo → em preparação → pronto → entregue (ou cancelado). A cozinha avança, o empregado entrega; **só o gerente cancela ou desfaz**, com motivo, e tudo fica no histórico.
7. «Chamar o garçom» cria uma chamada que o empregado vê em tempo real; não há mais nada de interativo no lado do cliente (sem pagamentos).
8. **Restaurantes de demonstração** (`is_demo`) nunca aceitam pedidos nem chamadas.

## 5. Cardápio, fotografias, 3D e realidade aumentada

- **Ficheiros** (logótipo, capa, fotografias, modelos 3D) ficam na tabela `assets` da base de dados e são servidos em `/a/<id>` com o tipo **verificado pelo conteúdo** (não pelo nome nem pelo tipo que o utilizador diz), `nosniff` e uma CSP que impede qualquer execução.
  Aceita JPG, PNG, WebP e **GLB** (sem Draco/Meshopt/KTX2 e sem ficheiros externos). Cada restaurante tem uma **quota** (80 MB por omissão).
- **3D:** Three.js (cópia local em `web/vendor/three`, sem CDN). Só aparece «Ver em 3D» onde existe modelo **e** o plano do restaurante inclui 3D; sem modelo mostra a fotografia («não simular uma experiência 3D inexistente»).
  O endereço do modelo nem sequer é enviado ao telemóvel se o plano não incluir 3D.
- **Realidade aumentada:**
  - **Android:** abre o *Scene Viewer* do Google com o modelo (precisa de HTTPS e de um telemóvel compatível).
  - **iPhone/iPad:** o telemóvel converte o modelo para **USDZ** no próprio aparelho e abre o *AR Quick Look*. As cores «pintadas nos vértices» (as dos modelos de demonstração) são convertidas para uma pequena textura, porque o USDZ não as guarda.
  - Em computadores, ou telemóveis sem suporte, o botão «Ver na minha mesa» **não aparece**.
- **Demonstração «Casa Aurora»:** 12 pratos fictícios (7 com modelo 3D). As imagens e os modelos são **ilustrações geradas por computador** (não são fotografias reais) e os preços são exemplos.
  Os ficheiros estão em `scripts/demo-media/assets/` e foram criados por `scripts/demo-media/build-media.mjs` (testados em `server/test/demo-media.test.ts`).

## 6. Planos, assinaturas e a página comercial

- **Planos** (Starter, Pro, Premium) são linhas na base de dados: nome, frase, preços por mês/ano em várias moedas e a lista de funcionalidades. A Altiora edita tudo no painel; as mudanças chegam aos restaurantes em até 15 segundos.
  **A funcionalidade é verificada no servidor** (não só escondida no ecrã): um restaurante sem o plano recebe «403 PLAN_FEATURE» se tentar usá-la.
- **Assinaturas:** estado ativa, em atraso ou cancelada, mais notas. **Não há cobrança nem registo de pagamentos** da assinatura: a Altiora acerta com o restaurante por fora e atualiza o estado.
  **O sistema não suspende sozinho** restaurantes em atraso: a Altiora decide e usa «Suspender».
- **Página comercial** (`/`): gerada no servidor (rápida e boa para motores de pesquisa), com título, descrição, `canonical`, Open Graph, dados estruturados e `robots.txt`/`sitemap.xml`. Guardada 60 s em memória.
  O **formulário de contacto** guarda a mensagem (com o consentimento marcado) para a Altiora ver no painel; tem limite de pedidos por IP e um campo-armadilha contra robôs.
  A demonstração interativa é o cardápio da «Casa Aurora» incorporado na página.

## 7. Privacidade (resumo; não é aconselhamento jurídico)

- **Clientes dos restaurantes:** não criam conta. O sistema guarda o que o pedido precisa (pratos, notas escritas pelo cliente, mesa, hora). Não pede nome nem telefone no pedido.
  Notas de pedidos são tratadas como texto simples (nunca executadas).
- **Equipas e gerentes:** nome, e-mail, perfil, palavra-passe (só o resultado do `scrypt`).
- **Interessados (formulário comercial):** nome, negócio, telefone, e-mail e mensagem; ficam até a Altiora os apagar (há botão «Apagar»).
- Há uma página `/privacidade`, em linguagem simples. **Nenhum advogado a reviu.** A conformidade com a lei angolana de proteção de dados pessoais (e com outras leis, se tiver clientes noutros países) **não foi avaliada**:
  convém rever o texto, definir prazos de conservação e decidir quem responde a pedidos de acesso ou apagamento.
- Não há cookies de publicidade nem de análise de terceiros. O único cookie é o da sessão de quem entra nos painéis.

## 8. Testes: o que existe

| Tipo | Onde | O que cobre |
|---|---|---|
| Unitários e com base de dados | `server/test`, `shared`, `web/src` (`bun run test`) | Regras dos pedidos e estados, preços, idempotência, RLS e permissões, planos e funcionalidades, página comercial e SEO, ficheiros (validação, quota), QR Codes e PDF, relatórios por fuso horário, configuração, ficheiros de publicação, USDZ (cores), carrinho e pesquisa. |
| Ponta a ponta | `e2e/specs` (`bun run test:e2e`) | Um navegador a sério, com telemóvel simulado e uma base de dados temporária: pedido do QR Code ao acompanhamento, ecrã pequeno (360 px), texto malicioso nas notas, prato esgotado a meio, duplo toque, resposta perdida, pedidos pausados, QR Codes do gerente (lidos por um leitor independente), cozinha, empregado, isolamento, permissões, tempo real, rede lenta e sem rede, «Chamar o garçom» (o cliente chama, o empregado e o gerente veem e atendem, cancelar, sem duplicados, sem botão na demonstração), página comercial, 3D, painel do gerente e da Altiora. As capturas de ecrã ficam em `e2e/output/`. |

Nada foi dado como «feito» sem passar por estes testes. Quando um teste antigo falhou por o desenho do cardápio ter mudado, foi corrigido; duas dessas falhas eram **reais** e foram corrigidas no produto: com os pedidos pausados, o cardápio ainda mostrava os botões «+»; e, depois de tocar em «+», a barra «− 1 +» tapava parte da descrição do prato.

## 9. O que não foi testado e limites conhecidos

**Não foi testado:**

1. **A publicação real** no Render e no Supabase (não havia contas). Seguiu-se a documentação dos serviços, mas pode haver passos que mudem.
2. **A imagem Docker** (`Dockerfile`): não havia Docker nem acesso à internet no ambiente de desenvolvimento. O arranque do servidor construído (`dist/server.js`) foi testado numa pasta limpa, sem o código-fonte e sem `node_modules`, contra uma base de dados sem privilégios de administrador, como o Supabase.
3. **A realidade aumentada em telemóveis verdadeiros** (Android e iPhone). Testou-se, num navegador simulado, a decisão de mostrar ou não o botão, a ligação para o Scene Viewer e a geração do ficheiro USDZ (cuja cor foi verificada contra a especificação, **não** aberto no AR Quick Look).
4. **O 3D em placas gráficas reais:** testou-se com renderização por software. Os modelos de demonstração são leves (menos de 1,2 MB e menos de 60 mil triângulos), mas o desempenho em telemóveis fracos é desconhecido.
5. **Carga e desempenho:** não foi feito teste de carga (muitos clientes ao mesmo tempo).
6. **Mais de uma instância do servidor:** o limitador de pedidos, o cache das funcionalidades (15 s), o cache da página comercial (60 s) e os avisos em tempo real vivem na memória de **cada** instância. Use uma só instância (o `render.yaml` já o faz).
7. **Outros navegadores:** os ensaios usam o Chromium. Safari e Firefox não foram testados (o código segue normas web, mas não há garantia).
8. **Acessibilidade:** houve cuidado (nomes nos botões, foco, contraste, botões grandes), mas **não** houve auditoria nem testes com leitores de ecrã.
9. **Impressão real dos QR Codes** e leitura em papel: os PDF e as imagens foram descodificados por um leitor independente (OpenCV), mas não foram impressos.
10. **Transaction pooler do Supabase** (porta 6543): existe a opção `DATABASE_PREPARE=false`, testada contra PostgreSQL local, mas não contra o serviço real.

**Limites e decisões conhecidas:**

- **Não há envio de e-mails nem SMS.** Os contactos comerciais e as chamadas de mesa veem-se nos painéis; as palavras-passe repõem-se por quem gere.
- **Pedido por WhatsApp** abre o WhatsApp com a mensagem escrita; o sistema **não sabe** se o cliente a enviou, por isso esses pedidos **não entram** nos relatórios.
- **A moeda do restaurante não se muda depois de haver pedidos.** Os preços dos planos podem estar em várias moedas.
- **O PDF dos QR Codes não leva o logótipo** do restaurante (só o nome e a cor).
- **As assinaturas não expiram sozinhas** e não há cobrança.
- **Fotografias e modelos ficam na base de dados**: simples e seguro de copiar, mas a base cresce e não há CDN. Para muito volume, o próximo passo natural é um armazenamento de ficheiros (por exemplo, o Supabase Storage).
- **Pagamentos:** não há (a pedido). Existe, desde as primeiras versões, o **registo manual** de como uma conta foi paga (feito pela equipa); alimenta os relatórios («Pagamentos confirmados», «Por receber»). Pode ser removido; peça-o.

## 10. Em que se afasta do que foi pedido

| Pedido | O que foi feito | Porquê |
|---|---|---|
| React + TypeScript + **Vite** + **Tailwind** | React 19 + TypeScript, construído com **esbuild**, CSS próprio (sem Tailwind) | O ambiente onde o sistema foi construído não tinha acesso ao registo de pacotes (npm), por isso usaram-se só as ferramentas que já lá estavam. Para o utilizador final não muda nada; para quem programa, o CSS está em `web/src/styles/`. |
| **Node/Express** | **Bun** + TypeScript, sem Express (um encaminhador simples e testado) | Menos dependências e arranque mais rápido. Em produção corre no Bun, dentro de Docker. |
| **Supabase** (Auth, Realtime, Storage) e **Vercel** | Só o **PostgreSQL** do Supabase; contas, tempo real (SSE) e ficheiros são do próprio sistema; **um** serviço no Render | Menos peças, menos custos, e a segurança por restaurante fica toda sob controlo (e testada) num só sítio. |
| Pagamentos | Nenhum (a pedido do utilizador), só «Chamar o garçom» | Ver §9. |
| Draco/compressão 3D | Não suportada (ficheiros GLB sem compressão) | Evita descodificadores extra; o sistema recusa com uma frase clara. |

## 11. Para quem vai programar

- Ponto de entrada: `server/src/main.ts` (arranque) e `server/src/app.ts` (`createApp(deps).fetch`, o encaminhador e a ordem das verificações: limites, sessão, permissões, origem).
- Cada tema tem a sua pasta em `server/src/modules/<tema>/routes.ts`, com a lista de rotas, o perfil que pode usá-las e o esquema de validação (`shared/schemas.ts`, zod).
- Acesso à base de dados: `db.as(contexto, fn)` (aplica o perfil e o restaurante → RLS) e `db.system(fn)` (só para o servidor). **Nunca** use `db.system` para responder a um pedido de utilizador sem uma razão forte.
- Regras partilhadas servidor/aplicação: `shared/` (estados, planos, QR, horários, alergénios).
- Adicionar uma migração: novo ficheiro `db/migrations/000N_nome.sql`; o arranque aplica-o e volta a verificar a segurança.
- Depois de alterar o código: `bun run typecheck`, `bun run test`, `bun run test:e2e` e **`bun run build`** (a pasta `dist/` é a que vai para produção).
