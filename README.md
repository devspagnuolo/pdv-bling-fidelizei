# PDV independente — Bling + Fidelizei

Base de um PDV que orquestra, sem substituir, Bling (catálogo, pedido e fiscal) e Fidelizei (CRM, benefícios e fidelidade).

## Estrutura

- `apps/api`: API de orquestração.
- `apps/web`: interface do PDV.
- `docs`: arquitetura e modelo de dados.
- `render.yaml`: infraestrutura de implantação no Render.

## Fluxo protegido

1. Operador inicia uma venda e escolhe o vendedor.
2. Cliente é consultado pelo CPF no Fidelizei.
3. Um cupom é validado e reservado com prazo de expiração.
4. O pagamento é confirmado e o pedido é criado no Bling.
5. Só após a confirmação do pedido, a reserva é consumida, pontos/histórico são lançados e a venda guarda todos os IDs externos.

Falhas após o pedido entram em `RECONCILIATION_REQUIRED`, evitando perda silenciosa ou reutilização indevida de benefícios.

## Cliente sem cadastro

Cada venda sem CPF cria no Bling um contato próprio, sem documento, chamado `Consumidor Final - PDV <código>`. Nenhum pedido do PDV compartilha contato com outro, então alterar o cliente de um pedido no Bling não muda os demais. Para identificar o cliente, informe o CPF na etapa *Cliente* do PDV e use **Cadastrar no Bling**: o PDV cria um contato novo e troca apenas o contato da venda em tela.

Vendas antigas que ainda apontam para o Consumidor Final compartilhado recebem um contato próprio na próxima vez que forem salvas ou finalizadas pelo PDV.
