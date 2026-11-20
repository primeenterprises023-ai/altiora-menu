# Publicar o ALTIORA MENU na internet (passo a passo)

Este guia leva-o de «tenho uma pasta com o projeto» até «o sistema está online e os restaurantes podem usá-lo». Não precisa de saber programar:
só de seguir os passos, por ordem, e de copiar e colar.

**Tempo:** entre 45 minutos e 1 hora na primeira vez. (Os nomes dos botões e dos menus do GitHub, do Supabase e do Render podem mudar com o tempo; se algum for diferente, procure o mais parecido.)
**Contas que vai criar (todas com o seu e-mail):** GitHub (guarda o projeto), Supabase (guarda os dados) e Render (põe o sistema online).
**Opcional:** um domínio próprio (por exemplo `menu.altiora.ao`), recomendado antes de imprimir QR Codes.

> **Antes de começar, saiba duas coisas.**
> 1. **Isto ainda não foi experimentado com contas reais do Render e do Supabase.** O sistema foi testado de ponta a ponta no ambiente de desenvolvimento,
>    incluindo uma simulação de uma base de dados sem privilégios de administrador (como a do Supabase). Mas o Docker e a publicação real nunca foram corridos.
>    Se algum passo não correr como descrito, não é culpa sua: veja a secção «Se algo correr mal» no fim.
> 2. **Os preços e as condições do Render e do Supabase mudam.** Confirme nas páginas deles quanto custa e o que inclui cada plano antes de pagar.

---

## O que vai ter no fim

```
Telemóvel do cliente ──►  Render (a aplicação: páginas + API)  ──►  Supabase (a base de dados PostgreSQL)
                          https://o-seu-endereço                    onde ficam restaurantes, menus, pedidos, fotografias e 3D
```

Só há **um** serviço a publicar (no Render). Não precisa de Vercel nem de mais nada. O Supabase serve **apenas** como base de dados:
o sistema não usa o login, o armazenamento de ficheiros nem o tempo real do Supabase (tem os seus próprios, ver `docs/arquitetura.md`).

---

## Parte 1 — Pôr o projeto no GitHub

O Render lê o projeto a partir do GitHub.

1. Crie uma conta em **github.com** (se ainda não tiver) e confirme o e-mail.
2. Instale o **GitHub Desktop** (programa gratuito com botões, sem comandos): `desktop.github.com`. Entre com a sua conta do GitHub.
3. Descompacte o ficheiro `altiora-menu.zip` que recebeu. Fica uma pasta chamada `altiora-pedidos`. Guarde-a num sítio fácil (por exemplo, em Documentos).
4. No GitHub Desktop: **File → Add local repository…** → escolha a pasta `altiora-pedidos`.
   Vai aparecer «This directory does not appear to be a Git repository». Clique em **create a repository** e depois em **Create repository**.
5. Em baixo à esquerda, escreva uma descrição (por exemplo, `Primeira versão`) e clique em **Commit to main**.
6. Clique em **Publish repository**. Dê-lhe o nome `altiora-menu` e **marque «Keep this code private»** (repositório privado). Clique em **Publish repository**.

Pronto: o projeto está no GitHub, privado. (Se preferir não usar o GitHub Desktop, também pode arrastar os ficheiros para o site do GitHub, mas o site só aceita 100
ficheiros de cada vez e o projeto tem cerca de 400.)

> **Importante:** não coloque no GitHub nenhum ficheiro `.env` com palavras-passe. O projeto já está preparado para os ignorar. As palavras-passe vão só no painel do Render.

---

## Parte 2 — Criar a base de dados no Supabase

1. Crie uma conta em **supabase.com** e entre.
2. Clique em **New project**. Escolha uma organização (ou crie uma).
3. Preencha:
   - **Name**: `altiora-menu`
   - **Database Password**: clique em **Generate a password**, e **copie e guarde essa palavra-passe num sítio seguro** (gestor de palavras-passe). Vai precisar dela daqui a pouco.
     Se escolher a sua, use só letras e números (os símbolos como `@`, `#` ou `/` obrigam a passos extra, ver «Se algo correr mal»).
   - **Region**: escolha **Frankfurt (eu-central-1)**, ou o nome mais parecido. É a região mais próxima de Angola entre as que o Render também tem. (O `render.yaml` já usa Frankfurt.)
4. Clique em **Create new project** e espere 1 a 2 minutos.
5. Obtenha o endereço da base de dados: clique no botão **Connect** (no topo da página do projeto) e procure **Session pooler**
   (se houver uma lista «Method», escolha «Session pooler»). Copie o endereço. Tem este aspeto:

   `postgresql://postgres.abcdefghij:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`

6. Troque `[YOUR-PASSWORD]` (com os parêntesis retos) pela palavra-passe da base de dados do passo 3. **Guarde este endereço completo**: é o `DATABASE_URL`.

> **Porquê «Session pooler»?** Porque funciona com o Render (que só liga por IPv4) e aceita tudo o que o sistema precisa. Evite o «Transaction pooler» (porta 6543);
> se for mesmo preciso usá-lo, veja «Se algo correr mal».
>
> Não precisa de criar tabelas à mão: o sistema cria tudo sozinho quando arranca pela primeira vez.

---

## Parte 3 — Criar o serviço no Render

1. Crie uma conta em **render.com** (pode entrar com o GitHub) e, nas definições da conta, **adicione um cartão** se escolher um plano pago.
2. No painel do Render: **New + → Blueprint**.
3. Ligue o GitHub (**Connect GitHub**), autorize o acesso ao repositório `altiora-menu` e selecione-o.
4. O Render lê o ficheiro `render.yaml` do projeto e mostra o serviço **altiora-menu** (Docker, região Frankfurt, plano **Starter**).
   - Para **apenas testar** sem pagar, abra o `render.yaml` no GitHub, troque `plan: starter` por `plan: free` e guarde (commit) antes deste passo.
     No plano gratuito o serviço adormece ao fim de 15 minutos sem visitas e demora cerca de 1 minuto a acordar: serve para experimentar, **não para restaurantes a funcionar**.
5. O Render pede-lhe três valores. Preencha:

   | Campo | O que escrever |
   |---|---|
   | `DATABASE_URL` | O endereço completo do Supabase (Parte 2, passo 6). |
   | `BOOTSTRAP_ADMIN_EMAIL` | O seu e-mail de administrador da Altiora, por exemplo `admin@altiora.ao`. |
   | `BOOTSTRAP_ADMIN_PASSWORD` | Uma palavra-passe **temporária** com pelo menos 10 caracteres (será obrigado a trocá-la no primeiro acesso). |

6. Clique em **Apply** (ou **Deploy Blueprint**). O Render constrói e arranca o serviço (3 a 6 minutos). Acompanhe em **Logs**.
7. Está bem quando nos registos aparecer `servidor a ouvir` e o estado do serviço ficar **Live** (verde).
8. Abra o endereço do serviço (algo como `https://altiora-menu.onrender.com`). Deve ver a página comercial do ALTIORA MENU.
   Em `/api/health` (por exemplo `https://altiora-menu.onrender.com/api/health`) deve aparecer `"status":"ok"`.

> O restaurante de demonstração **«Casa Aurora»** (fictício) é criado automaticamente no primeiro arranque e aparece na página comercial e em `/r/demo`.
> As imagens e os modelos 3D dele são **ilustrações geradas por computador**, e os preços são exemplos.

---

## Parte 4 — Primeiro acesso como administrador da Altiora

1. Vá a `https://o-seu-endereço/entrar`.
2. Entre com o e-mail e a palavra-passe temporária que definiu na Parte 3.
3. O sistema obriga-o a **escolher uma palavra-passe nova** (mínimo 10 caracteres, difícil de adivinhar). Escolha e guarde-a num gestor de palavras-passe.
4. **Agora apague as variáveis temporárias.** No Render → o seu serviço → **Environment**: apague `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD`
   e guarde. O Render volta a arrancar o serviço (1 a 2 minutos). Isto não apaga a sua conta; só retira a palavra-passe temporária do painel.

---

## Parte 5 — Preparar a Altiora (planos, preços e contactos)

1. **Planos e preços:** entre como administrador → **Planos**. Para cada plano (Starter, Pro, Premium) defina o preço **por mês** (e, se quiser, **por ano** e noutras moedas) e, se quiser, ajuste
   o nome, a frase de apresentação e as funcionalidades. **Enquanto não definir o preço, a página comercial mostra «Preço sob consulta».**
2. **Contactos comerciais** (aparecem na página comercial e no painel do gerente): no Render → **Environment → Add Environment Variable**, acrescente
   as que quiser (as que não preencher não aparecem):

   | Variável | Exemplo |
   |---|---|
   | `COMMERCIAL_EMAIL` | `comercial@altiora.ao` |
   | `COMMERCIAL_PHONE` | `+244 900 000 000` |
   | `COMMERCIAL_WHATSAPP` | `+244900000000` (com o indicativo; dá o botão «Falar no WhatsApp») |
   | `COMMERCIAL_ADDRESS` | `Luanda, Angola` |

   Guarde: o serviço reinicia sozinho.
3. **Mensagens recebidas:** quando alguém preenche o formulário da página comercial, a mensagem aparece em **Contactos**, no painel da Altiora
   (estados «novo», «contactado», «arquivado»). O sistema **não envia e-mails**: tem de ver o painel de vez em quando.
4. Reveja o texto de **privacidade** (`/privacidade`) com o seu advogado antes de divulgar o site: foi escrito em linguagem simples, mas não substitui aconselhamento jurídico.

---

## Parte 6 — Criar o primeiro restaurante a sério

1. No painel da Altiora → **Restaurantes → Novo restaurante**.
2. Preencha o nome do restaurante, a **moeda dos preços do menu** (Kwanza por omissão; **não se pode mudar depois de haver pedidos**), o plano e os dados do gerente (nome e e-mail).
3. Ao criar, aparece um cartão com a **palavra-passe temporária do gerente. Só é mostrada esta vez.** Copie-a e envie-a ao gerente por um meio seguro. No primeiro acesso, o gerente é obrigado a trocá-la.
4. O gerente entra em `/entrar` e passa a gerir o restaurante: menu, mesas, equipa e QR Codes (ver `docs/manual.md`).

---

## Parte 7 — Domínio próprio (recomendado)

O endereço `...onrender.com` funciona, mas é longo e muda se mudar de serviço. **Os QR Codes impressos levam o endereço do sistema.** Se mudar de endereço depois de os imprimir, os cartões deixam de funcionar.
Por isso, **escolha o domínio definitivo antes de imprimir os QR Codes.**

1. Compre um domínio (ou use um que já tenha), por exemplo `menu.altiora.ao`.
2. No Render → o seu serviço → **Settings → Custom Domains → Add Custom Domain** e siga as instruções: o Render diz que registo (CNAME) deve criar no sítio onde o domínio está registado. Pode demorar de minutos a algumas horas.
3. Quando o Render indicar que o domínio está verificado (com cadeado, HTTPS), vá a **Environment → Add Environment Variable** e acrescente `PUBLIC_BASE_URL` com o endereço novo, por exemplo `https://menu.altiora.ao`. Guarde.
4. **Só depois** descarregue e imprima os PDF dos QR Codes (o gerente: **Mesas e QR Codes**).

---

## Parte 8 — Manutenção

**Cópias de segurança.** Os dados (incluindo fotografias e modelos 3D) estão todos na base de dados do Supabase. Confirme no Supabase o que o seu plano inclui (cópias diárias e restauro) e, para
dados importantes, não dependa só do plano gratuito. Eu não verifiquei o que os planos atuais incluem. Teste um restauro **antes** de ter clientes reais.

**Atualizar o sistema.** Quando receber uma versão nova do projeto: substitua os ficheiros na pasta (mantendo a pasta `.git` escondida), abra o GitHub Desktop, escreva uma descrição, **Commit to main** e **Push origin**.
O Render atualiza sozinho. As alterações à base de dados aplicam-se automaticamente ao arrancar, **sem apagar dados**.

**Ver se está bem.** `https://o-seu-endereço/api/health` deve mostrar `"status":"ok"`. No Render, **Logs** mostra o que o sistema regista (nunca palavras-passe nem códigos dos clientes).

**Restaurante de demonstração.** Se já não quiser a «Casa Aurora» na página comercial, no painel da Altiora **suspenda** o restaurante `demo` (a página comercial deixa de o mostrar). Apague também a variável `SEED_SHOWCASE` no Render
para ele não ser criado de novo se o apagar. Para o ter de volta, ponha `SEED_SHOWCASE=true`.

**Várias cópias do servidor.** O sistema foi pensado para **uma** instância no Render. Com mais do que uma, os avisos em tempo real entre instâncias não são partilhados e algumas
informações guardadas na memória (limites de pedidos, planos e página comercial) ficam por instância. Não foi testado.

---

## Antes de abrir a clientes reais (lista de verificação)

- [ ] O serviço no Render está num **plano pago** (o gratuito adormece).
- [ ] Tem **domínio próprio** e `PUBLIC_BASE_URL` definido **antes** de imprimir QR Codes.
- [ ] Trocou a palavra-passe do administrador e **apagou** `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD` do Render.
- [ ] Definiu os **preços dos planos** e os **contactos comerciais**.
- [ ] Sabe como é a **cópia de segurança** da base de dados e testou o restauro.
- [ ] Criou um restaurante de teste, uma mesa, **imprimiu um QR Code** e fez um pedido completo com **dois telemóveis diferentes** (cliente e cozinha). Experimentou também «Chamar o garçom».
- [ ] Testou a **realidade aumentada** num telemóvel Android e num iPhone de verdade (não foi possível testar aqui).
- [ ] Reviu com um advogado o aviso de privacidade (`/privacidade`) e a forma como recolhe os contactos dos interessados.
- [ ] O gerente sabe que a palavra-passe da equipa é reposta por ele, e a do gerente é reposta pela Altiora.

---

## Se algo correr mal

| O que vê | O que fazer |
|---|---|
| Nos registos: «Não foi possível ligar à base de dados» | Confirme o `DATABASE_URL`: tem de ser o do **Session pooler**, com a palavra-passe certa no lugar de `[YOUR-PASSWORD]` (sem os parêntesis retos). Confirme que o projeto do Supabase não está em pausa (os projetos gratuitos pausam depois de uma semana sem atividade: no painel do Supabase, clique em **Restore**). |
| A palavra-passe da base de dados tem símbolos (`@`, `#`, `/`, `:`, `%`, `?`) | Num endereço, estes símbolos têm de ser escritos em «código». O mais simples: no Supabase, **Project Settings → Database → Reset database password** e escolha uma palavra-passe só com letras e números; atualize o `DATABASE_URL` no Render. |
| Erros do tipo «prepared statement … does not exist» | Está a usar o «Transaction pooler» (porta 6543). Troque para o **Session pooler** (porta 5432). Se não puder, acrescente no Render a variável `DATABASE_PREPARE` com o valor `false`. |
| Nos registos: «verificação de segurança» a falhar e o serviço não arranca | A base de dados recusou criar as regras de segurança. Confirme que está a usar a base de dados `postgres` do projeto e a palavra-passe do utilizador `postgres` (não uma chave «anon» ou «service_role»). Se persistir, guarde os registos e peça ajuda. O sistema recusa arrancar de propósito, para nunca funcionar sem a proteção entre restaurantes. |
| «A configuração tem problemas» | O registo diz qual a variável. Corrija em **Environment** (o endereço público tem de começar por `https://`). |
| Não consigo entrar como administrador | O administrador inicial só é criado **se ainda não existir nenhum** e só se `BOOTSTRAP_ADMIN_EMAIL` e `BOOTSTRAP_ADMIN_PASSWORD` estiverem os dois preenchidos no primeiro arranque (a palavra-passe com pelo menos 10 caracteres e não demasiado óbvia). Veja os registos do primeiro arranque. |
| A página comercial não mostra o restaurante de demonstração | Verifique `SEED_SHOWCASE=true` e `DEMO_RESTAURANT_SLUG=demo`; veja nos registos a frase «restaurante de demonstração». Se já existir um restaurante com o endereço `demo`, o sistema não lhe toca. |
| O serviço demora ~1 minuto a abrir | Está no plano gratuito do Render (adormece). Suba para um plano pago. |
| Os QR Codes imprimidos «não abrem» | O endereço do QR Code é o `PUBLIC_BASE_URL` do momento em que foram gerados. Confirme que o endereço ainda existe. Se o mudou, gere e imprima de novo. |
| Fotografias ou modelos 3D «não cabem» | Cada restaurante tem um espaço máximo (80 MB por omissão; `ASSET_QUOTA_MB`). Use fotografias JPG/PNG/WebP leves e modelos 3D GLB leves. |
