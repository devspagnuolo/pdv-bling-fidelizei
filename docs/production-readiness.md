# Produção

## Infraestrutura (Render)

- API `pdv-bling-fidelizei-api` em plano pago (sem hibernação) e PostgreSQL `pdv-bling-fidelizei-db` em plano pago.
- No painel do serviço da API: **Health Check Path** = `/health` e **Auto-Deploy** = *After CI checks pass*, para que um commit com CI vermelho não seja publicado.
- Build com `npm ci` (o `package-lock.json` está versionado).
- Conferir a política de backup/point-in-time recovery do banco no painel.

## Configuração obrigatória no backend

- `PDV_AUTH_SECRET`, `PDV_ADMIN_PIN` e, durante a transição, `PDV_OPERATOR_PIN` e `PDV_MANAGER_PIN`.
- `PDV_WEB_URL` com o endereço do PDV (CORS e retorno do OAuth).
- `BLING_COMPANY_ID` para restringir webhooks à empresa autorizada.
- Recomendado: `BLING_COMPANY_CNPJ` e `BLING_FINAL_CONSUMER_CONTACT_ID`.
- Servidor de webhooks no aplicativo Bling: `https://pdv-bling-fidelizei-api.onrender.com/webhooks/bling`, com os eventos `product`, `stock`, `virtual_stock`, `order` e `consumer_invoice`.

## PIN individual

1. No Admin, entre com o PIN de administrador e abra **Acesso dos vendedores**.
2. Cadastre um PIN (6 a 12 dígitos) e o perfil de cada vendedor.
3. Quando todos tiverem PIN, defina `PDV_REQUIRE_INDIVIDUAL_PIN=1`. A partir daí os PINs compartilhados deixam de funcionar.

## Controles implementados

- Assinatura HMAC `X-Bling-Signature-256`, idempotência por `eventId`, fila persistente processada em lotes, backoff e estado `DEAD`.
- Login com PIN individual (scrypt) ou compartilhado na transição, token assinado de 12 horas, revogado ao sair.
- Limite de tentativas por IP real (trustProxy), por operador e para o PIN de administrador.
- Em produção, sem autenticação configurada, as rotas operacionais respondem 503.
- Operador acessa apenas as próprias vendas e o próprio caixa; cancelar ou excluir pedido que saiu do atendimento exige gerente e fica na auditoria.
- Só gerente ou administrador inicia a conexão com o Bling.
- Transações do caixa em conexão dedicada do PostgreSQL.
- Proteção contra dupla finalização, cancelamento sob trava da venda e registro de falhas para reconciliação.
- CORS restrito ao endereço do PDV; erros do banco não expõem SQL.
- Dependências fixadas com lockfile; CI roda build, testes e `npm audit`.
