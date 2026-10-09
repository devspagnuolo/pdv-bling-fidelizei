# Produção

## Bloqueadores que exigem configuração

- Alterar o serviço `pdv-bling-fidelizei-api` do plano gratuito para um plano sem hibernação.
- Alterar `pdv-bling-fidelizei-db` para um PostgreSQL persistente antes de 6 de novembro de 2026 e ativar backups.
- Configurar `PDV_AUTH_SECRET`, `PDV_OPERATOR_PIN` e `PDV_MANAGER_PIN` no backend.
- Configurar `BLING_COMPANY_ID` para restringir webhooks à empresa autorizada.
- Configurar no aplicativo Bling o servidor `https://pdv-bling-fidelizei-api.onrender.com/webhooks/bling`.
- Habilitar os webhooks `product`, `stock`, `virtual_stock`, `order` e `consumer_invoice`.
- Confirmar os escopos OAuth correspondentes e reconectar o Bling após qualquer alteração de escopo.

## Controles implementados

- Assinatura HMAC `X-Bling-Signature-256`.
- Idempotência por `eventId`, fila persistente, backoff e estado `DEAD`.
- Login com operador do Bling, PIN no servidor e token assinado de 12 horas.
- Perfil gerente para sincronização manual, sangria, suprimento, fechamento, estorno e pendências.
- Venda vinculada ao caixa aberto e operador obtido do token quando a autenticação está ativa.
- Proteção contra dupla finalização e registro de falhas para reconciliação.
- Health check de banco, Bling, autenticação, criptografia, webhooks e filas pendentes.
- CORS restrito ao endereço do PDV.
- Dependências fixadas e build/auditoria automatizados no GitHub.
