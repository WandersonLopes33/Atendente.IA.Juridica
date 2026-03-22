# 🤖 Dr. Rick — Sistema de Atendimento Jurídico via WhatsApp
### Lopes Advocacia | Dr. Wanderson Mailson Machado Lopes | OAB/MA

---

## 📋 Índice

- [Visão Geral](#visão-geral)
- [Funcionalidades](#funcionalidades)
- [Arquitetura](#arquitetura)
- [Estrutura de Pastas](#estrutura-de-pastas)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração (.env)](#configuração-env)
- [Banco de Dados](#banco-de-dados)
- [Serviços](#serviços)
- [Fluxo de Mensagens](#fluxo-de-mensagens)
- [API de Comandos WhatsApp](#api-de-comandos-whatsapp)
- [Monitoramento e Logs](#monitoramento-e-logs)
- [Solução de Problemas](#solução-de-problemas)
- [Roadmap](#roadmap)

---

## 🎯 Visão Geral

O **Dr. Rick** é um assistente jurídico virtual que opera via WhatsApp, desenvolvido para o escritório **Lopes Advocacia**. O sistema automatiza o atendimento inicial de clientes, consultas processuais em tempo real via DataJud/CNJ, coleta de novos casos, e notificação de movimentações processuais por e-mail.

**Stack principal:**
- **Runtime:** Node.js 18+
- **WhatsApp:** Evolution API v2.3.7
- **IA:** Groq (Llama 3.3 70B Versatile)
- **Banco:** PostgreSQL 14+
- **E-mail:** IMAP (Gmail)
- **Processos:** DataJud API Pública CNJ

---

## ✅ Funcionalidades

### Atendimento Inteligente
| Funcionalidade | Descrição |
|---|---|
| 🕐 Saudação por horário | "Bom dia/Boa tarde/Boa noite" automático pelo fuso de Brasília |
| 📝 Coleta de nome | Solicita nome completo na primeira mensagem |
| 🔄 Buffer de mensagens | Agrupa mensagens rápidas (3s) em uma única intenção |
| 🧠 Síntese de intenção | IA une múltiplas mensagens curtas em uma frase clara |
| 🚫 Filtro pessoal/profissional | IA detecta e ignora conversas pessoais acidentais |
| 👋 Opt-out inteligente | Detecta encerramento por contexto, não por palavra-chave |
| 🔁 Reativação de conversa | Reabre conversa pendente ou cria nova conforme contexto |
| 👨‍💼 Transferência para humano | Encaminha ao Dr. Wanderson quando solicitado |

### Consulta Processual
| Funcionalidade | Descrição |
|---|---|
| ⚖️ Consulta DataJud | Busca processo em tempo real via API CNJ |
| 📋 Extração de número CNJ | Detecta formato `0000000-00.0000.8.10.0000` na mensagem |
| 💾 Cache no banco | Salva resultado para evitar consultas repetidas |
| ⚠️ Fallback sem API key | Informa cliente quando sistema não tem acesso configurado |

### Gestão de Casos
| Funcionalidade | Descrição |
|---|---|
| 📂 Coleta de novo caso | Fluxo guiado para coletar dados do caso por área do direito |
| 🗂️ Categorização por área | Trabalhista, Família, Consumidor, Criminal, Previdenciário, Cível |
| 💾 Rascunho automático | Salva dados parciais a cada resposta |
| ✅ Finalização com protocolo | Cria processo no banco e gera número de protocolo |

### Documentos
| Funcionalidade | Descrição |
|---|---|
| 📄 Recebimento via WhatsApp | Aceita PDF, DOCX, TXT, JPG, PNG |
| 🔍 Extração de texto | pdf-parse, mammoth, Tesseract.js (OCR) |
| 🏷️ Categorização automática | CTPS, RG, CPF, Certidão, Contrato, Petição, Sentença, etc. |
| 🤖 Análise IA | Resumo e informações relevantes extraídas automaticamente |

### E-mail e Movimentações
| Funcionalidade | Descrição |
|---|---|
| 📧 Monitoramento IMAP | Verifica caixa de entrada a cada 60 segundos |
| ⚖️ Detector de movimentação | Identifica e-mails do tribunal com número de processo |
| 📱 Notificação automática | Notifica cliente e advogado via WhatsApp |
| 🔍 Busca por comando | `#email hoje`, `#email de remetente`, `#email assunto X` |
| 📝 Categorização IA | Urgente, Comercial, Jurídico, Financeiro, Spam |

### Recuperação de Conversas
| Funcionalidade | Descrição |
|---|---|
| ⏰ Verificação a cada 4h | Identifica conversas abandonadas |
| 🤖 Análise de necessidade | IA avalia se cliente ainda precisa de follow-up |
| 📤 Mensagem de recuperação | Envia mensagem personalizada ao cliente |
| 🔒 Limite de tentativas | Máximo 1 tentativa por conversa |

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENTE                                  │
│                    (WhatsApp Pessoal)                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Mensagem
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EVOLUTION API v2.3.7                          │
│              (Gateway WhatsApp — Porta 8080)                     │
│         Instance: Juridico | State: open                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Webhook POST /webhook
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  BACKEND JURÍDICO (Porta 3001)                   │
│                    Node.js + Express                             │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    WEBHOOK.JS                            │    │
│  │                                                          │    │
│  │  1. fromMe / grupo → ignorar                             │    │
│  │  2. conversationTypeDetector → pessoal? ignorar          │    │
│  │  3. #email → emailService (sem buffer)                   │    │
│  │  4. conversa closed → analisar reativação (IA)           │    │
│  │  5. res.status(200) + markAsRead (async)                 │    │
│  │  6. Mídia → documentprocessor (async, fora do buffer)    │    │
│  │  7. Buffer 3s → processar mensagem combinada:            │    │
│  │     a. e-mail linguagem natural (advogado)               │    │
│  │     b. buscar/criar cliente e conversa                   │    │
│  │     c. salvar mensagem no banco                          │    │
│  │     d. processoHandler (consulta DataJud)                │    │
│  │     e. opt-out via IA                                    │    │
│  │     f. transferência para humano                         │    │
│  │     g. newcasecollector (caso em coleta ativo)           │    │
│  │     h. sendTyping → groqAI → sendTyping off              │    │
│  │     i. enviar resposta                                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  groqAI.js   │  │evolutionAPI  │  │  emailService.js     │  │
│  │              │  │    .js       │  │                      │  │
│  │ • getSaudacao│  │ • sendText   │  │ • checkEmails (60s)  │  │
│  │ • getPrompt  │  │ • sendTyping │  │ • handleCommand      │  │
│  │ • synthesize │  │ • markAsRead │  │ • categorizeEmail    │  │
│  │ • extractName│  │ • getState   │  │ • processMovement →  │  │
│  │ • generate   │  │              │  │   notifier           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ processoWA   │  │ conversation │  │  conversationType    │  │
│  │ Handler.js   │  │ Recovery.js  │  │  Detector.js         │  │
│  │              │  │              │  │                      │  │
│  │ • detecta nº │  │ • verif. 4h  │  │ • keywords pessoais  │  │
│  │ • dataJud    │  │ • analise IA │  │ • keywords profiss.  │  │
│  │ • formata    │  │ • recupera   │  │ • IA para ambíguos   │  │
│  │ • salva banco│  │ • encerra    │  │ • saveFilterLog      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │Newcasecollect│  │Documentproces│  │ Processmovementnoti  │  │
│  │   or.js      │  │   sor.js     │  │     fier.js          │  │
│  │              │  │              │  │                      │  │
│  │ • identifica │  │ • download   │  │ • detecta tribunal   │  │
│  │   área       │  │ • valida     │  │ • extrai nº processo │  │
│  │ • extrai info│  │ • OCR/PDF    │  │ • resumo IA          │  │
│  │ • pergunta   │  │ • categoriza │  │ • notifica cliente   │  │
│  │ • salva banco│  │ • analise IA │  │ • notifica advogado  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
┌─────────────────┐ ┌────────────┐ ┌──────────────────┐
│   PostgreSQL    │ │  Groq API  │ │  DataJud CNJ     │
│   (Porta 5432)  │ │ (Llama 3.3)│ │  (TJMA público)  │
│                 │ │            │ │                  │
│ conversations   │ │ • resposta │ │ • dados processo │
│ messages        │ │ • sintese  │ │ • movimentações  │
│ clientes        │ │ • análise  │ │ • situação atual │
│ processos       │ │ • opt-out  │ │                  │
│ movimentacoes   │ │ • reativaç.│ └──────────────────┘
│ documentos      │ └────────────┘
│ casos_em_coleta │
│ advogados       │
└─────────────────┘
```

---

## 📁 Estrutura de Pastas

```
C:\sat\backend-juridico\
│
├── routes\
│   ├── webhook.js              ← Ponto de entrada de todas as mensagens
│   ├── whatsapp.js             ← QR code, status da instância
│   ├── conversations.js        ← CRUD de conversas
│   ├── messages.js             ← CRUD de mensagens
│   ├── analytics.js            ← Métricas e relatórios
│   ├── settings.js             ← Configurações do sistema
│   ├── recovery.js             ← Trigger manual de recuperação
│   ├── ai.js                   ← Endpoint de teste da IA
│   ├── processos-routes.js     ← CRUD de processos
│   └── advogados-routes.js     ← CRUD de advogados
│
├── services\
│   ├── groqAI.js               ← IA principal (Llama 3.3 via Groq)
│   ├── evolutionAPI.js         ← Wrapper da Evolution API
│   ├── database.js             ← Pool de conexões PostgreSQL
│   ├── emailService.js         ← IMAP + notificações + comandos #email
│   ├── conversationRecovery.js ← Recuperação de conversas abandonadas
│   ├── dataJudService.js       ← Integração DataJud CNJ
│   ├── processoWhatsAppHandler.js ← Detecção e consulta de processos
│   ├── monitoramentoProcessualService.js ← Monitor periódico de processos
│   ├── conversationTypeDetector.js ← Filtro pessoal/profissional
│   ├── Newcasecollector.js     ← Coleta estruturada de novos casos
│   ├── Documentprocessor.js    ← Processamento de documentos enviados
│   └── Processmovementnotifier.js ← Notificação de movimentações
│
├── database\
│   ├── connection.js           ← Configuração do pool
│   ├── migrate.js              ← Runner de migrations
│   ├── schema.sql              ← Schema principal
│   └── schema-processos.sql    ← Schema de processos
│
├── utils\
│   ├── logger.js               ← Winston logger
│   └── cache.js                ← Cache em memória
│
├── src\
│   └── server.js               ← Entry point, registra rotas e serviços
│
├── documents\                  ← Documentos recebidos via WhatsApp
│   ├── clientes\
│   ├── processos\
│   └── temp\
│
├── logs\
│   └── combined.log            ← Logs da aplicação
│
├── .env                        ← Variáveis de ambiente
└── package.json
```

---

## 🔧 Pré-requisitos

- **Node.js** 18 ou superior
- **PostgreSQL** 14 ou superior
- **Evolution API** v2.3.7 rodando na porta 8080
- **Conta Groq** com API Key (https://console.groq.com)
- **Gmail** com senha de app configurada (IMAP habilitado)

---

## 🚀 Instalação

```bash
# 1. Clonar/copiar o projeto
cd C:\sat\backend-juridico

# 2. Instalar dependências
npm install

# 3. Instalar dependências de documentos
npm install pdf-parse mammoth tesseract.js sharp

# 4. Criar pasta de documentos
mkdir documents\clientes documents\processos documents\temp

# 5. Configurar o .env (ver seção abaixo)
# Copiar .env.example para .env e preencher

# 6. Criar banco de dados
psql -U viagemexpress_user -h localhost -d juridico
# Executar: \i database/schema.sql
# Executar: \i database/schema-processos.sql

# 7. Rodar migrations de novas funcionalidades
# Executar os ALTERs e CREATEs do guia de migrations

# 8. Iniciar em desenvolvimento
npm run dev

# 9. Iniciar em produção
node src/server.js
```

---

## ⚙️ Configuração (.env)

```env
# ── Servidor ──────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3001

# ── Banco de Dados ─────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/juridico
DB_HOST=localhost
DB_PORT=5432
DB_NAME=juridico
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_POOL_MIN=2
DB_POOL_MAX=20

# ── IA (Groq) ──────────────────────────────────────────────────────────────
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_MAX_TOKENS=8000
GROQ_TEMPERATURE=0.7

# ── Evolution API (WhatsApp) ───────────────────────────────────────────────
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=sua_chave_aqui
EVOLUTION_INSTANCE_NAME=Juridico
EVOLUTION_INSTANCE=Juridico
WEBHOOK_URL=http://localhost:3001/webhook

# ── E-mail (Gmail IMAP) ────────────────────────────────────────────────────
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_TLS=true
EMAIL_USER=seu_email@gmail.com
EMAIL_PASSWORD=senha_de_app_gmail   # Não a senha normal — gerar em: myaccount.google.com/apppasswords
EMAIL_NOTIFY_PHONE=5599XXXXXXXXX     # Número do advogado (recebe todas as notificações)
EMAIL_CHECK_INTERVAL_MS=60000        # 60 segundos

# ── Empresa ────────────────────────────────────────────────────────────────
COMPANY_NAME=Lopes Advocacia
COMPANY_LOCATION=Imperatriz, Maranhão
CALENDLY_LINK=https://calendly.com/escritorio/consulta
AI_TONE=formal
BUSINESS_HOURS_START=08:00
BUSINESS_HOURS_END=18:00

# ── DataJud (Consulta Processual CNJ) ─────────────────────────────────────
DATAJUD_API_URL=https://api-publica.datajud.cnj.jus.br
DATAJUD_TRIBUNAL=tjma                # Código do tribunal: tjma, tjsp, tjrj, etc.

# ── Documentos ─────────────────────────────────────────────────────────────
DOCUMENTS_PATH=C:\sat\backend-juridico\documents
MAX_FILE_SIZE=10485760               # 10MB em bytes

# ── Recuperação de Conversas ───────────────────────────────────────────────
RECOVERY_ENABLED=true
RECOVERY_CHECK_INTERVAL=14400000     # 4 horas em ms
ABANDONED_THRESHOLD=14400000         # Considera abandonada após 4h

# ── Segurança ──────────────────────────────────────────────────────────────
SESSION_SECRET=32_caracteres_aleatorios_aqui
JWT_SECRET=32_caracteres_aleatorios_aqui
CORS_ORIGIN=*
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# ── Features ───────────────────────────────────────────────────────────────
FEATURE_AUTO_TRANSFER_TO_HUMAN=true
FEATURE_ANALYTICS_ENABLED=true
FEATURE_AI_FALLBACK_ENABLED=true
REDIS_ENABLED=false
```

---

## 🗄️ Banco de Dados

### Tabelas Principais

| Tabela | Descrição |
|---|---|
| `advogados` | Cadastro de advogados do escritório |
| `clientes` | Clientes atendidos via WhatsApp |
| `conversations` | Conversas ativas e encerradas |
| `messages` | Todas as mensagens (cliente e bot) |
| `processos` | Processos judiciais cadastrados |
| `movimentacoes` | Histórico de movimentações processuais |
| `consultas_processuais` | Cache de consultas ao DataJud |
| `casos_em_coleta` | Novos casos em processo de triagem |
| `documentos` | Documentos recebidos e processados |
| `message_filters` | Log de mensagens filtradas (opcional) |
| `settings` | Configurações do sistema |

### Estados de Conversa (`ultimo_estado`)

| Estado | Significado |
|---|---|
| `aguardando_nome` | Bot solicitou nome, aguardando resposta |
| `nome_coletado` | Nome foi coletado e salvo |
| `nova_conversa` | Conversa reaberta após assunto resolvido |
| `reaberta` | Conversa reaberta pois assunto estava pendente |
| `opt_out_cliente` | Cliente pediu para encerrar |
| `consulta_processo` | Última ação foi consulta processual |
| `caso_coletado` | Novo caso foi finalizado e registrado |
| `recuperacao_automatica` | Bot tentou recuperar conversa abandonada |
| `recuperacao_ignorada` | Cliente ignorou tentativa de recuperação |

---

## 🔌 Serviços

### groqAI.js
Motor de IA do sistema. Responsável por:
- Gerar respostas conversacionais com contexto de 15 mensagens
- Sintetizar múltiplas mensagens curtas em uma intenção única
- Extrair nome do cliente da mensagem
- Detectar opt-out por contexto
- Analisar reativação de conversa encerrada

**Métodos principais:**
```javascript
groqAI.generateResponse(conversationId, userMessage)
groqAI.synthesizeIntent(mensagensNaoRespondidas)
groqAI.extractNameFromMessage(userMessage)
groqAI.getSaudacao()  // "Bom dia" | "Boa tarde" | "Boa noite"
```

### evolutionAPI.js
Wrapper da Evolution API. Métodos:
```javascript
evolutionAPI.sendTextMessage(phone, text)
evolutionAPI.sendTyping(phone, isTyping)
evolutionAPI.markAsRead(phone, messageId)
evolutionAPI.getConnectionState()
```

### emailService.js
Monitor de e-mails com dois fluxos:
1. **Movimentação processual** → `Processmovementnotifier` → notifica cliente + advogado
2. **E-mail genérico** → categoriza com IA → notifica só o advogado

### conversationTypeDetector.js
Filtro de mensagens pessoais vs. profissionais:
- **Keywords**: análise imediata por palavras-chave
- **IA (confidence < 0.5)**: consulta Groq para casos ambíguos
- **Log opcional**: salva decisões na tabela `message_filters`

---

## 🔄 Fluxo de Mensagens

```
Mensagem recebida
│
├── fromMe? → ignorar
├── grupo? → ignorar
├── sem texto e não é mídia? → ignorar
│
├── conversationTypeDetector → pessoal? → ignorar
│
├── #email? → emailService.handleWhatsAppCommand() → return
│
├── conversa closed? → analisar com IA:
│   ├── opt_out_cliente/recuperacao_ignorada → nova conversa
│   ├── assunto resolvido → nova conversa
│   └── assunto pendente → reabrir mesma conversa
│
├── res.status(200) + markAsRead (async)
│
├── É mídia (imagem/documento)?
│   └── documentprocessor.handleWhatsAppDocument() → return
│
└── Buffer 3s (aguarda mais mensagens)
    │
    ├── detectEmailRequest (advogado)? → emailService → return
    ├── buscar/criar cliente e conversa
    ├── salvar mensagem no banco
    │
    ├── processoHandler.processar() → processo detectado?
    │   └── consulta DataJud → responde → return
    │
    ├── detectOptOutComIA() → opt-out?
    │   └── despedida → fecha conversa → return
    │
    ├── transferKeywords → transferência?
    │   └── avisa cliente → return
    │
    ├── casos_em_coleta ativo?
    │   ├── collect → próxima pergunta → return
    │   └── complete → finaliza caso → return
    │
    └── sendTyping(true) → groqAI.generateResponse() → sendTyping(false) → envia
```

---

## 📱 API de Comandos WhatsApp

Comandos disponíveis para o advogado (número em `EMAIL_NOTIFY_PHONE`):

| Comando | Descrição | Exemplo |
|---|---|---|
| `#email hoje` | E-mails do dia | `#email hoje` |
| `#email de X` | E-mails de um remetente | `#email de cliente@gmail.com` |
| `#email assunto X` | E-mails por assunto | `#email assunto contrato` |
| `#email buscar X` | Busca no corpo | `#email buscar proposta` |

Comandos em linguagem natural (detectados automaticamente):
- *"Tem e-mail novo?"*
- *"Mostra os e-mails de hoje"*
- *"Verifique a caixa de entrada"*

---

## 📊 Monitoramento e Logs

### Logs
Os logs ficam em `logs/combined.log`. Níveis: `info`, `warn`, `error`, `debug`.

```bash
# Ver últimas 50 linhas
Get-Content "C:\sat\backend-juridico\logs\combined.log" | Select-Object -Last 50

# Filtrar erros
Get-Content "C:\sat\backend-juridico\logs\combined.log" | Select-String "ERROR"

# Acompanhar em tempo real
Get-Content "C:\sat\backend-juridico\logs\combined.log" -Wait -Tail 20
```

### Health Check
```
GET http://localhost:3001/health
```

### Verificar WhatsApp
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/instance/connectionState/Juridico" `
  -Headers @{"apikey"="ViagemExpress_SecretKey_2025"}
```

---

## 🔧 Solução de Problemas

### WhatsApp desconectado (AggregateError)
Erro de rede — Evolution API inacessível momentaneamente.
```powershell
# Verificar estado
Invoke-RestMethod -Uri "http://localhost:8080/instance/connectionState/Juridico" `
  -Headers @{"apikey"="ViagemExpress_SecretKey_2025"}

# Se 'close', reconectar via QR:
# Acessar http://localhost:8080 e escanear QR code
```

### E-mail não conecta (ENOTFOUND imap.gmail.com)
Problema de rede temporário. Verificar:
1. Conexão com a internet
2. Senha de app do Gmail (não a senha normal)
3. IMAP habilitado em: myaccount.google.com → Segurança → Acesso de apps menos seguros

### Bot não responde
1. Confirmar `npm run dev` rodando
2. Confirmar webhook configurado na Evolution API apontando para `http://localhost:3001/webhook`
3. Ver logs: `combined.log`

### Consulta DataJud retorna vazio
1. Confirmar formato CNJ: `0000000-00.0000.8.10.0000`
2. Confirmar que `8.10` está no número (código TJMA)
3. Testar diretamente: `https://api-publica.datajud.cnj.jus.br`

### Reabrir conversa de teste manualmente
```sql
UPDATE conversations 
SET status = 'active', ultimo_estado = NULL 
WHERE telefone = '5599XXXXXXXXX';
```

---

## 🗺️ Roadmap

- [ ] Dashboard web com métricas em tempo real
- [ ] Replicar para backend-odonto (Porto 3002)
- [ ] Replicar para atendentedepassagens (Porto 3000)
- [ ] API Key DataJud com acesso autenticado
- [ ] Notificação de prazo processual (D-5, D-1)
- [ ] Integração com Google Agenda para agendamentos
- [ ] Multi-tenancy (suporte a múltiplos escritórios)
- [ ] App de acompanhamento para o cliente

---

## 👨‍💻 Desenvolvido para

**Lopes Advocacia**
Dr. Wanderson Mailson Machado Lopes — OAB/MA
Imperatriz, Maranhão — Brasil

---

*Sistema Dr. Rick — Atendimento Jurídico Inteligente via WhatsApp*#   i a J u r i d i c a  
 