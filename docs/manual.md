# Manual de utilização

Cada pessoa vê só o que lhe diz respeito. Este manual está dividido por perfil: **cliente**, **empregado**, **cozinha**, **gerente** e **administração da Altiora**.
Todos os painéis funcionam no telemóvel, no tablet e no computador, no navegador (não há nada para instalar).

Os painéis de trabalho abrem em **`/entrar`** (por exemplo, `https://o-seu-endereço/entrar`). Depois de entrar, cada pessoa é levada ao seu painel.

---

## 1. Cliente (à mesa ou em casa)

O cliente **não cria conta nem instala nada**.

### Pedir à mesa
1. **Ler o QR Code da mesa** com a câmara do telemóvel. Abre o cardápio do restaurante, já com «Mesa N» identificada.
2. **Procurar:** escreva no campo «Pesquisar pratos e ingredientes» (a pesquisa é instantânea e não depende de acentos) ou escolha uma categoria.
3. **Alergias:** toque no botão de filtros de alergénios e marque o que quer evitar. Os pratos que contêm esses alergénios deixam de aparecer.
   Só aparecem os alergénios que o restaurante declarou. **Em caso de dúvida, pergunte sempre à equipa.**
4. **Ver um prato:** toque nele. Vê a fotografia, a descrição, os ingredientes, os alergénios («Contém»), o preço, os tamanhos e os extras.
   - **«Ver em 3D»** (só nos pratos que têm modelo): roda e aproxima o prato com o dedo. **«Ver fotografia»** volta à imagem.
   - **«Ver na minha mesa»** (só nos pratos com modelo, em telemóveis compatíveis): mostra o prato em tamanho real sobre a sua mesa, através da câmara (realidade aumentada).
     Se o telemóvel não suportar, o botão não aparece. O sistema não finge um 3D que não existe: se o prato não tem modelo, mostra a fotografia.
5. **Adicionar ao pedido:** escolha o tamanho, os extras, escreva uma nota para a cozinha (por exemplo, «sem cebola») e toque em **«Adicionar ao pedido»**.
   Pratos esgotados aparecem marcados e não se podem pedir.
6. **Ver pedido:** a barra em baixo mostra o total. Toque em **«Ver pedido»**, reveja, mude as quantidades e toque em **«Enviar pedido»**.
   O preço final é sempre calculado pelo servidor, com os preços do restaurante. Se um preço ou um prato mudou, o sistema avisa e mostra o que mudou antes de enviar.
7. **Acompanhar:** depois de enviar, aparece o **estado do pedido** («Pedido recebido» → «Em preparação» → «Pronto, a caminho da sua mesa» → «Entregue»), atualizado sozinho. Guarde ou partilhe o endereço dessa página.
   Em **«Os meus pedidos»** vê todos os pedidos feitos nesta mesa durante a visita.
8. **«Chamar o garçom»:** botão sempre à mão, em baixo à esquerda. Toque, confirme em **«Chamar agora»** e o botão passa a **«Garçom chamado»**.
   O empregado vê a chamada, com o número da mesa, no ecrã dele (com aviso sonoro, se ativado). Quando ele atender, o botão volta ao normal e aparece um aviso.
   Se já não precisar, toque em **«Garçom chamado»** e depois em **«Cancelar a chamada»**. Chamar outra vez da mesma mesa não cria uma segunda chamada,
   e depois de 6 toques em 10 minutos o sistema pede para aguardar um momento. O botão só existe nos restaurantes cujo plano inclui pedidos, e só no cardápio lido a partir da mesa
   (não existe na página do restaurante sem mesa nem no cardápio de demonstração).

Se enviar duas vezes sem querer (duplo toque, ligação lenta), o sistema só regista **um** pedido.

### Pedir por WhatsApp (nos restaurantes que o ativaram)
Em vez de «Enviar pedido» aparece **«Enviar por WhatsApp»**: abre o WhatsApp do restaurante com o pedido já escrito. Também funciona na **página do restaurante** (sem mesa).

### Sem mesa: a página do restaurante
Em `…/r/o-restaurante` qualquer pessoa vê o cardápio, o horário, a morada e os contactos, e pode montar o pedido para enviar por WhatsApp (se o restaurante o tiver).

### Se os pedidos estiverem pausados
O gerente pode pausar os pedidos por QR Code (por exemplo, quando a cozinha está cheia). O cliente vê um aviso, continua a ver o cardápio e pode «Chamar o garçom».

---

## 2. Empregado

Entre em `/entrar` com a conta que o gerente lhe criou. Na primeira vez tem de **trocar a palavra-passe** (mínimo 10 caracteres).

O ecrã do empregado tem quatro separadores:

- **A entregar:** pedidos **prontos**. Leve-os à mesa e toque em **«Confirmar entrega»**.
- **Em curso:** pedidos recebidos ou em preparação.
- **Mesas:** a lista das mesas e o que cada uma tem em curso. O botão **«Novo pedido»** (no topo, ou dentro de cada mesa) serve para **registar pedidos feitos à mão** (cliente sem telemóvel).
- **Por pagar:** pedidos entregues e por pagar. O empregado **regista** que a conta foi paga e como (dinheiro, TPA…). O sistema **não cobra** nada: só guarda o registo, para os relatórios.

No topo aparecem as **chamadas das mesas** («Chamar o garçom»), com o número da mesa e há quanto tempo esperam (passados 3 minutos, o tempo fica a vermelho). Toque em **«Atender»** quando for à mesa.
No separador **Mesas**, a mesa que chamou aparece marcada «A chamar o garçom». O gerente vê as mesmas chamadas no ecrã **Pedidos** e também as pode atender; a cozinha não as vê.
Ative o interruptor **«Avisar com som quando uma mesa chamar ou um pedido ficar pronto»** ao começar o turno: os navegadores só deixam tocar sons depois de a pessoa tocar no ecrã.

---

## 3. Cozinha

Entre em `/entrar`. O ecrã da cozinha tem colunas: **novos**, **em preparação** e **prontos**.

1. Um pedido novo chega com um aviso sonoro. Toque em **«Iniciar preparação»**.
2. Quando estiver pronto, toque em **«Marcar como pronto»**. O empregado é avisado.
3. Toque em **«Pratos esgotados»** para marcar o que acabou: deixa de se poder pedir e o cardápio mostra «Esgotado». Quando voltar a haver, desmarque.

As notas dos clientes (por exemplo, «sem cebola») aparecem como **texto simples** em cada prato. As alergias são sempre confirmadas com o cliente.
A cozinha não cancela pedidos: **só o gerente** pode cancelar um pedido (ou desfazer um passo dado por engano), e tem de escrever o motivo, que fica no histórico.

---

## 4. Gerente

Entre em `/entrar`. O menu do topo tem: **Pedidos, Menu, Mesas e QR Codes, Equipa, Relatórios, Atividade, Definições, Plano**.
Algumas secções dependem do plano do restaurante. Nos planos como vêm de origem: **Pedidos**, **gestão de mesas** (um QR Code por mesa), **Relatórios** e a **cor do restaurante** são do plano **Pro** (e do Premium); **3D**, **realidade aumentada**, **Atividade**, a exportação **CSV**, o **estilo da letra** e a **remoção da marca Altiora** são do **Premium**. A Altiora pode alterar o que cada plano inclui. Uma secção que o plano não inclui mostra a explicação e como pedir a mudança de plano.
O gerente pode ainda **«Ver como cozinha»** e **«Ver como empregado»**.

### Menu
- **Categorias:** crie, ordene e esconda (por exemplo, Entradas, Pratos, Sobremesas, Bebidas).
- **Pratos:** nome, descrição, preço (na moeda do restaurante), **ingredientes**, **alergénios** (lista oficial: glúten, crustáceos, ovos, peixe, amendoim, soja, leite, frutos de casca rija, aipo, mostarda, sésamo, sulfitos, tremoço, moluscos), **fotografia** (JPG, PNG ou WebP) e, no plano Premium, **modelo 3D** (ficheiro **GLB**, sem compressão e com tudo incluído no ficheiro).
  O sistema confere o conteúdo do ficheiro: um ficheiro que não é o que diz ser, ou que depende de ficheiros externos, é recusado com uma frase a explicar porquê.
  Tamanhos e extras têm preço próprio. Marque como **esgotado** ou **escondido** sem apagar.
- **Preços:** o cliente vê o preço pelo valor que o gerente definir; o total do pedido é recalculado no servidor.

### Mesas e QR Codes
1. **Criar mesas**, uma a uma ou com **«Criar várias mesas»**.
2. **Descarregar o PDF** com os cartões de QR Code (4 por folha A4, com linhas de corte) ou **«Imprimir daqui»**. Há também a **folha do restaurante** (um QR Code para a página do restaurante).
3. Cada mesa tem o seu código secreto. **Se um QR Code for roubado ou fotografado por quem já saiu, abra a mesa e toque em «Gerar novo QR Code»**: o antigo deixa de funcionar e tem de imprimir o novo.
4. **Antes de imprimir em quantidade, confirme o endereço do sistema** (ver `docs/publicar.md`, Parte 7): os QR Codes levam esse endereço.
5. Teste sempre: leia o QR Code impresso com um telemóvel e faça um pedido de teste.

### Equipa
Crie contas de **empregado**, **cozinha** (e outros gerentes). Ao criar, aparece a **palavra-passe temporária, uma única vez**: copie-a e entregue-a à pessoa. Ela é obrigada a trocá-la no primeiro acesso.
Pode **repor a palavra-passe** de uma pessoa, **desativar** (a pessoa deixa de entrar na hora) ou reativar. A palavra-passe de **outro gerente** só a Altiora a repõe.

### Relatórios (plano Pro ou superior)
Escolha o período (botões rápidos ou «De… Até…»). Mostra **vendas registadas**, **pagamentos confirmados**, **por receber** e **cancelados**, os **métodos de pagamento** usados, os **pratos mais pedidos** e o resumo **por dia**, sempre **no fuso horário do restaurante**.
Os valores de pagamento vêm do **registo que a equipa faz** (o sistema não cobra nada). **Exportar CSV** faz parte do plano Premium (Gestão avançada).

### Atividade (plano Premium)
O registo do que a equipa alterou (menu, mesas, pedidos), para a gestão avançada.

### Definições
- **«Aceitar pedidos dos clientes»:** interruptor para **pausar** os pedidos por QR Code. O cardápio continua visível.
- Nome, descrição, morada, localização no mapa, telefone, e-mail, **WhatsApp para pedidos**, **horário** da semana.
- **Logótipo** e **imagem de capa**.
- **Taxa de serviço (%)** e **fuso horário** (Africa/Luanda por omissão).
- **Cor** do restaurante (plano Pro ou superior) e, no Premium, o **estilo da letra** e a **remoção da marca Altiora**.

### Plano
Mostra o plano atual, o estado da assinatura (**ativa**, **em atraso**, **cancelada**), o que o plano inclui e **como contactar a Altiora** para mudar.
**Não há pagamentos no sistema**: a assinatura é acertada diretamente com a Altiora e registada por ela.

---

## 5. Administração da Altiora

Entre em `/entrar` com a conta de administrador. O menu tem: **Restaurantes, Planos, Contactos**.

**A Altiora não vê os pedidos, os menus nem os relatórios dos restaurantes.** Vê apenas os dados necessários para gerir o serviço (nome, plano, estado, quantos pratos e quantos pedidos, sem o conteúdo).

### Restaurantes
- **Novo restaurante:** nome, moeda dos preços, plano e dados do gerente. Aparece a **palavra-passe temporária do gerente (uma única vez)**.
- Em cada restaurante: **mudar de plano**, **estado da assinatura** (ativa, em atraso, cancelada), **notas da assinatura** (só a Altiora as vê) e **suspender / reativar**.
  Um restaurante **suspenso** deixa de abrir o cardápio ao público e a equipa deixa de poder entrar; **os dados ficam guardados** e voltam quando reativar.
- **Repor a palavra-passe** de um gerente.
- **Números gerais** no topo: restaurantes ativos (e assinaturas em atraso), pedidos em 30 dias (soma de todos), pratos com 3D e espaço ocupado por fotografias e modelos. Só números: nunca o conteúdo dos pedidos.
- Um **registo das ações da própria Altiora** (quem criou, suspendeu, mudou de plano…).

### Planos
Crie e edite planos: **nome**, frase de apresentação, **ordem**, **plano em destaque**, se está **disponível para novos restaurantes**, **preço por mês** (e por ano, e noutras moedas) e **as funcionalidades de cada plano**:
cardápio digital, QR Code, gestão de produtos, pedidos digitais, WhatsApp, mesas, estatísticas, personalização, 3D, realidade aumentada, personalização exclusiva, gestão avançada.
**Os preços não vêm preenchidos:** enquanto não os definir, a página comercial mostra «Preço sob consulta».
A mudança de funcionalidades de um plano aplica-se a todos os restaurantes nesse plano em poucos segundos (as páginas guardam o plano durante 15 segundos).

### Contactos
Os pedidos de contacto que chegam pelo formulário da página comercial: mude o estado de **novo** para **contactado** e **arquivado**, ou **«Apagar»** o contacto quando já não for preciso.
O sistema não envia e-mails nem notificações: tem de abrir esta página. Respeite a vontade de quem pediu contacto e **apague os dados quando já não forem precisos**.

---

## Dúvidas frequentes (equipa)

**Um cliente diz que não consegue pedir.** Veja se o restaurante está com **«Aceitar pedidos dos clientes»** ligado (Definições), se o plano inclui **Pedidos digitais**, se a assinatura não está **cancelada** e se o restaurante não está **suspenso**.

**Mudei um preço e o cliente ainda vê o antigo.** O cliente que já tinha o cardápio aberto vê o preço novo ao enviar (o sistema avisa e pede confirmação). Quem abre agora vê o preço novo.

**Preciso de apagar um prato.** Prefira **esconder** ou marcar como **esgotado**: os pedidos antigos mantêm o nome e o preço que tinham no momento.

**O tempo real parou.** Os painéis voltam a consultar sozinhos a cada poucos segundos. Atualize a página se persistir.

**Esqueci-me da palavra-passe.** Empregado e cozinha: peça ao gerente. Gerente: peça à Altiora.
