# Arquitetura

```text
React PDV ──► API de Orquestração ──► BlingAdapter ──► Bling API
                  │                       │
                  ├──► FidelizeiAdapter ──┴──► Fidelizei API
                  ├──► PostgreSQL (vendas, auditoria, outbox)
                  ├──► Fila/outbox (retentativas e webhooks)
                  └──► Serviço de impressão térmica local
```

O PDV não acessa Bling ou Fidelizei diretamente. Tokens ficam no servidor; cada adaptador traduz o contrato interno para a API do fornecedor. Eventos recebidos e enviados carregam uma chave de idempotência.

## Fiscal e impressão

`FiscalService` é uma porta: a primeira implementação deve solicitar NFC-e/DANFE ao Bling quando a API/conta o suportar. A impressão recebe um `Receipt` normalizado e pode usar ESC/POS por um agente local autenticado. Não marque venda como fiscalmente autorizada antes do retorno assinado/autorizado.
