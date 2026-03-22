# 📐 ARQUITETURA DO SISTEMA - ViagemExpress

## 🏗️ Visão Geral

```
┌─────────────┐
│   Cliente   │
│  (WhatsApp) │
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│  Evolution API   │ ◄──── Gerencia conexão WhatsApp
│   (WhatsApp)     │
└────────┬─────────┘
         │ Webhook
         ▼
┌─────────────────────────────────────────┐
│         BACKEND NODE.JS (Express)        │
│                                          │
│  ┌───────────┐      ┌──────────────┐   │
│  │  Webhook  │──────│  Controller  │   │
│  │  Handler  │      │              │   │
│  └───────────┘      └──────┬───────┘   │
│                            │            │
│  ┌─────────────────────────▼─────────┐ │
│  │        SERVICES LAYER             │ │
│  │                                    │ │
│  │  ┌──────────┐    ┌─────────────┐ │ │
│  │  │ Claude   │    │ Evolution   │ │ │
│  │  │ AI Svc   │    │ API Service │ │ │
│  │  └─────┬────┘    └──────┬──────┘ │ │
│  └────────┼──────────────────┼───────┘ │
│           │                  │         │
│           ▼                  ▼         │
│  ┌──────────────┐   ┌──────────────┐  │
│  │   Database   │   │    Logger    │  │
│  │   SQLite     │   │   Winston    │  │
│  └──────────────┘   └──────────────┘  │
└─────────────────────────────────────────┘
         │                      │
         ▼                      ▼
┌────────────────┐    ┌──────────────┐
│ Anthropic API  │    │    Logs      │
│  (Claude AI)   │    │ error.log    │
└────────────────┘    │ combined.log │
                      └──────────────┘
```

## 🔄 Fluxo de Dados

### 1. Mensagem Recebida

```
Cliente (WhatsApp)
    │
    ▼
Evolution API
    │
    ▼ POST /webhook
Webhook Handler
    │
    ├─► Salvar no DB
    ├─► Marcar como lida
    └─► Processar
```

### 2. Processamento IA

```
Webhook Handler
    │
    ▼
Claude AI Service
    │
    ├─► Buscar histórico (DB)
    ├─► Buscar configurações (DB)
    ├─► Gerar system prompt
    ├─► Chamar Anthropic API
    │
    ▼
Resposta gerada
    │
    ├─► Salvar resposta (DB)
    ├─► Enviar via Evolution API
    └─► Atualizar métricas
```

### 3. Envio de Resposta

```
Claude AI Service
    │
    ▼
Evolution API Service
    │
    ├─► Simular digitação
    ├─► Enviar mensagem
    └─► Confirmar envio
    │
    ▼
Cliente (WhatsApp)
```

## 🗄️ Estrutura do Banco de Dados

```sql
┌─────────────────┐
│  conversations  │
├─────────────────┤
│ id (PK)         │
│ phone_number    │
│ customer_name   │
│ status          │
│ created_at      │
│ updated_at      │
└────────┬────────┘
         │
         │ 1:N
         ▼
┌─────────────────┐
│    messages     │
├─────────────────┤
│ id (PK)         │
│ conversation_id │
│ sender          │
│ content         │
│ is_from_me      │
│ created_at      │
└─────────────────┘

┌─────────────────┐
│     orders      │
├─────────────────┤
│ id (PK)         │
│ conversation_id │
│ order_number    │
│ customer_name   │
│ total_price     │
│ status          │
└─────────────────┘

┌─────────────────┐
│   analytics     │
├─────────────────┤
│ id (PK)         │
│ date            │
│ total_convs     │
│ total_orders    │
│ total_revenue   │
└─────────────────┘

┌─────────────────┐
│    settings     │
├─────────────────┤
│ key (PK)        │
│ value           │
│ description     │
└─────────────────┘
```

## 📡 APIs Externas

### Anthropic Claude API
```
Endpoint: https://api.anthropic.com/v1/messages
Método: POST
Headers:
  - x-api-key: API_KEY
  - Content-Type: application/json
  - anthropic-version: 2023-06-01

Payload:
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 1000,
  "system": "...",
  "messages": [...]
}
```

### Evolution API
```
Endpoints principais:
  - POST /message/sendText/{instance}
  - GET  /instance/connectionState/{instance}
  - POST /webhook/set/{instance}
  - GET  /instance/qrcode/{instance}

Headers:
  - apikey: API_KEY
  - Content-Type: application/json
```

## 🔐 Segurança

```
┌─────────────┐
│   Cliente   │
└──────┬──────┘
       │
       ▼
┌──────────────┐
│ Rate Limiter │ ◄─── 100 req/15min por IP
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Helmet     │ ◄─── Security headers
└──────┬───────┘
       │
       ▼
┌──────────────┐
│     CORS     │ ◄─── Cross-origin control
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Validação   │ ◄─── Input sanitization
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Handler    │
└──────────────┘
```

## 📊 Métricas Coletadas

```
Analytics Daily:
├─ Total conversas
├─ Conversas ativas
├─ Total mensagens
│  ├─ Do bot
│  └─ Dos clientes
├─ Total pedidos
├─ Receita total
├─ Taxa de conversão
└─ Tempo médio resposta
```

## 🔄 Estados da Conversa

```
          ┌──────┐
          │ NEW  │
          └───┬──┘
              │
              ▼
          ┌────────┐
    ┌────│ ACTIVE │────┐
    │    └────────┘    │
    │                  │
    ▼                  ▼
┌─────────┐      ┌──────────┐
│ BUYING  │      │ WAITING  │
└────┬────┘      └────┬─────┘
     │                │
     │                │
     ▼                ▼
┌──────────┐    ┌────────────┐
│ CLOSED   │◄───│TRANSFERRED │
└──────────┘    └────────────┘
```

## 🚀 Performance

### Otimizações Implementadas

1. **Database Indexes**
   - phone_number, status, created_at
   - Melhora queries em 80%

2. **Connection Pooling**
   - SQLite com better-sqlite3
   - Sync mais rápido que async para SQLite

3. **Caching Potencial**
   - Redis para session management
   - Bull para job queues

4. **Rate Limiting**
   - Protege de DDoS
   - 100 requests / 15 min

## 📦 Deploy

```
Desenvolvimento          Staging            Produção
    │                       │                  │
    ▼                       ▼                  ▼
┌────────┐            ┌─────────┐        ┌─────────┐
│ Local  │            │Railway/ │        │   VPS   │
│Port    │────push───▶│ Vercel  │───────▶│  NGINX  │
│ 3000   │            │         │        │  PM2    │
└────────┘            └─────────┘        └─────────┘
```

## 🔧 Extensões Futuras

1. **Multi-tenancy**: Suporte para várias empresas
2. **Redis**: Cache e filas
3. **PostgreSQL**: Para maior escala
4. **Monitoring**: Grafana + Prometheus
5. **ML**: Análise de sentimento avançada
6. **CRM**: Integração com Pipedrive/HubSpot
7. **Pagamentos**: Integração com gateways
8. **Relatórios**: PDFs automatizados

---

**Última atualização**: Fevereiro 2025
**Versão da arquitetura**: 1.0
