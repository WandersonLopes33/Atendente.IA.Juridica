# 🚀 Guia de Início Rápido - 5 Minutos

## Passo 1: Instalar Evolution API (WhatsApp)

### Opção A: Docker (Recomendado)

```bash
docker run -d \
  --name evolution-api \
  -p 8080:8080 \
  -e AUTHENTICATION_API_KEY=sua-chave-segura-aqui \
  atendai/evolution-api:latest
```

### Opção B: Manual

```bash
git clone https://github.com/EvolutionAPI/evolution-api
cd evolution-api
npm install
npm start
```

Acesse: http://localhost:8080

## Passo 2: Configurar Backend

```bash
cd backend-whatsapp

# Instalar dependências
npm install

# Copiar configurações
cp .env.example .env

# Editar .env (OBRIGATÓRIO!)
nano .env
```

**Variáveis ESSENCIAIS:**
```env
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=sua-chave-segura-aqui
ANTHROPIC_API_KEY=sk-ant-sua-chave-anthropic
```

## Passo 3: Criar Banco de Dados

```bash
npm run migrate
```

Vai criar:
- ✅ Tabelas
- ✅ Índices
- ✅ Configurações padrão
- ✅ Usuário admin

## Passo 4: Iniciar Servidor

```bash
npm start
```

Você verá:
```
🚀 Servidor iniciado na porta 3000
📍 Ambiente: development
📚 Documentação: http://localhost:3000/docs
💚 Health check: http://localhost:3000/health
```

## Passo 5: Conectar WhatsApp

### Método 1: Via Browser

1. Acesse: http://localhost:3000/api/whatsapp/qrcode
2. Copie o QR Code base64
3. Cole em: https://base64.guru/converter/decode/image
4. Escaneie com WhatsApp

### Método 2: Via Evolution API UI

1. Acesse: http://localhost:8080
2. Crie instância "viagemexpress"
3. Escaneie QR Code
4. Configure webhook:
   ```
   URL: http://localhost:3000/webhook
   Events: messages.upsert, messages.update, connection.update
   ```

## ✅ Testar Funcionamento

1. **Envie mensagem** para o número conectado

2. **Verifique logs:**
```bash
tail -f logs/combined.log
```

3. **Veja no dashboard:**
```bash
curl http://localhost:3000/api/analytics/dashboard
```

## 🎯 Comandos Úteis

```bash
# Ver conversas
curl http://localhost:3000/api/conversations

# Ver mensagens de uma conversa
curl http://localhost:3000/api/messages/1

# Ver pedidos
curl http://localhost:3000/api/orders

# Alterar configuração
curl -X PUT http://localhost:3000/api/settings/ai_tone \
  -H "Content-Type: application/json" \
  -d '{"value":"professional"}'

# Health check
curl http://localhost:3000/health
```

## 🐛 Problemas Comuns

### WhatsApp não conecta
```bash
# Verificar Evolution API
curl http://localhost:8080

# Ver status
curl http://localhost:3000/api/whatsapp/status
```

### Erro "ANTHROPIC_API_KEY"
```bash
# Obter chave: https://console.anthropic.com/
# Adicionar no .env:
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### Banco de dados locked
```bash
# Parar servidor
# Deletar .db-shm e .db-wal
rm database/*.db-shm database/*.db-wal
# Reiniciar
npm start
```

## 📱 Próximos Passos

1. ✅ **Personalize** - Edite rotas/preços em `services/claudeAI.js`
2. ✅ **Configure** - Ajuste tom, horários via `/api/settings`
3. ✅ **Teste** - Faça conversas simuladas
4. ✅ **Deploy** - Coloque em produção (Railway, VPS)
5. ✅ **Monitore** - Acompanhe logs e métricas

## 🚀 Deploy Rápido (Railway)

```bash
# 1. Criar conta: https://railway.app
# 2. Conectar GitHub
# 3. Deploy automático
# 4. Adicionar variáveis de ambiente
# 5. Obter URL pública
# 6. Atualizar webhook na Evolution API
```

## 📚 Recursos

- [Documentação Evolution API](https://doc.evolution-api.com/)
- [Documentação Anthropic](https://docs.anthropic.com/)
- [Guia SQLite](https://www.sqlite.org/docs.html)

---

**Está funcionando? Parabéns! 🎉**

Agora você tem um atendente virtual profissional rodando!

Precisa de ajuda? Consulte o [README.md](README.md) completo.
