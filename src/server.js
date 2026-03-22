require('dotenv').config(); // <--- ADICIONADO: Carregar variáveis do .env

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const logger = require('../utils/logger');          // raiz/utils/
const db = require('../services/database');         // raiz/services/

// Serviços
const evolutionAPI = require('../services/evolutionAPI');
const groqAI = require('../services/groqAI');
const conversationRecovery = require('../services/conversationRecovery');
const emailService = require('../services/emailService');
const monitoramentoProcessual = require('../services/monitoramentoProcessualService');

// Rotas
const webhookRoutes = require('../routes/webhook');
const whatsappRoutes = require('../routes/whatsapp');
const conversationsRoutes = require('../routes/conversations');
const messagesRoutes = require('../routes/messages');
const analyticsRoutes = require('../routes/analytics');
const settingsRoutes = require('../routes/settings');
const recoveryRoutes = require('../routes/recovery');
const aiRoutes = require('../routes/ai');
const processosRoutes = require('../routes/processos-routes');
const advogadosRoutes = require('../routes/advogados-routes');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middlewares ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) }
}));

// ── Rotas ─────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: {
            database: db.getPoolStats ? db.getPoolStats() : 'ok',
            whatsapp: evolutionAPI.isConnected ? 'connected' : 'disconnected',
            monitoramentoProcessual: monitoramentoProcessual.getStatus()
        }
    });
});

app.get('/docs', (req, res) => {
    res.json({
        name: 'Backend Juridico - Lopes Advocacia',
        version: '2.1.0',
        endpoints: {
            webhook: '/webhook',
            whatsapp: '/api/whatsapp/*',
            conversations: '/api/conversations',
            messages: '/api/messages',
            analytics: '/api/analytics',
            settings: '/api/settings',
            recovery: '/api/recovery',
            ai: '/api/ai',
            processos: '/api/processos',
            advogados: '/api/advogados'
        },
        features: [
            'Atendimento automatico via WhatsApp',
            'Buffer de mensagens (agrupa mensagens rapidas)',
            'Sintese de intencao (ultimas 3 mensagens)',
            'Opt-out contextual via IA',
            'Coleta automatica de nome na primeira conversa',
            'Recuperacao automatica de conversas (4h)',
            'Monitoramento de email IMAP',
            'Consulta processual sob demanda (DataJud CNJ)',
            'Monitoramento automatico de processos',
            'Notificacoes de movimentacoes'
        ]
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Backend Juridico - Lopes Advocacia',
        version: '2.1.0',
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

app.use('/webhook', webhookRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/recovery', recoveryRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/processos', processosRoutes);
app.use('/api/advogados', advogadosRoutes);

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint nao encontrado', path: req.path, method: req.method });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Erro nao tratado', { error: err.message, stack: err.stack, path: req.path });
    res.status(err.status || 500).json({ error: err.message || 'Erro interno do servidor' });
});

// ── Inicialização ─────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
    logger.info('Servidor iniciado na porta ' + PORT);
    logger.info('Ambiente: ' + (process.env.NODE_ENV || 'production'));
    logger.info('Documentacao: http://localhost:' + PORT + '/docs');
    logger.info('Health check: http://localhost:' + PORT + '/health');

    // Recuperacao de conversas abandonadas
    if (conversationRecovery && conversationRecovery.start) {
        conversationRecovery.start();
    }

    // Monitoramento de email
    if (emailService && emailService.start) {
        emailService.start();
    }

    // Monitoramento processual
    const INTERVALO_MONITORAMENTO = parseInt(process.env.MONITORAMENTO_INTERVALO_MINUTOS) || 60;
    try {
        await monitoramentoProcessual.start(INTERVALO_MONITORAMENTO);
        logger.info('Monitoramento Processual ativado', { intervalo: `${INTERVALO_MONITORAMENTO} minutos` });
    } catch (error) {
        logger.warn('Monitoramento Processual nao iniciado', {
            erro: error.message,
            motivo: 'Sem processos cadastrados ou sem credenciais DataJud'
        });
    }

    // Status WhatsApp
    try {
        const status = await evolutionAPI.getConnectionStatus();
        logger.info('Status WhatsApp verificado', { instance: status?.instance });
    } catch (error) {
        logger.error('Erro ao verificar status', { error: error.message });
        logger.info('WhatsApp nao conectado. Use /api/whatsapp/qrcode para conectar');
    }
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

const gracefulShutdown = async (signal) => {
    logger.info(`${signal} recebido, encerrando servidor...`);
    server.close(async () => {
        logger.info('Servidor HTTP fechado');
        try {
            if (conversationRecovery && conversationRecovery.stop) conversationRecovery.stop();
            if (emailService && emailService.stop) emailService.stop();
            if (monitoramentoProcessual && monitoramentoProcessual.stop) monitoramentoProcessual.stop();
            // db usa pool.end(), não db.close()
            if (db && db.pool && typeof db.pool.end === 'function') {
                await db.pool.end();
            } else if (db && typeof db.end === 'function') {
                await db.end();
            }
            logger.info('Shutdown completo');
            process.exit(0);
        } catch (error) {
            logger.error('Erro durante shutdown', { error: error.message });
            process.exit(1);
        }
    });
    setTimeout(() => { process.exit(1); }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// NÃO encerra o servidor por exceção não tratada — apenas loga e continua
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception (servidor continua)', {
        error: error.message,
        stack: error.stack
    });
    // Não chama gracefulShutdown — erros isolados (ex: Tesseract) não derrubam o servidor
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection (servidor continua)', {
        reason: reason?.message || reason,
        stack: reason?.stack
    });
});

module.exports = app;