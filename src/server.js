require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const pdf = require('pdf-parse');

const logger = require('../utils/logger');
const db = require('../services/database');

// Serviços
const evolutionAPI = require('../services/evolutionAPI');
const groqAI = require('../services/groqAI');
const emailService = require('../services/emailService');
const monitoramentoProcessual = require('../services/monitoramentoProcessualService');
const agendaService = require('../services/agendaService');

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

// Middlewares
app.use(cors({ origin: "*" }));
app.use(express.static('public'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// Rotas API
app.use('/webhook', webhookRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/messages', messagesRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/settings', settingsRoutes);
app.use('/recovery', recoveryRoutes);
app.use('/ai', aiRoutes);
app.use('/processos', processosRoutes);
app.use('/advogados', advogadosRoutes);

// Endpoint de OCR (Mantendo sua lógica original)
app.post('/ocr', async (req, res) => {
    try {
        const { imageBase64, filename } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Nenhuma imagem enviada' });

        const buffer = Buffer.from(imageBase64, 'base64');
        const isPdf = filename?.toLowerCase().endsWith('.pdf');

        let text = '';
        if (isPdf) {
            const data = await pdf(buffer);
            text = data.text;
        } else {
            const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'por');
            text = ocrText;
        }

        res.json({ text });
    } catch (error) {
        logger.error('Erro no OCR', { error: error.message });
        res.status(500).json({ error: 'Falha ao processar arquivo' });
    }
});

// Health Check
app.get('/health', async (req, res) => {
    try {
        const dbStatus = await db.query('SELECT NOW()').then(() => 'connected').catch(() => 'error');
        const waStatus = await evolutionAPI.isConnected() ? 'connected' : 'disconnected';
        
        res.json({
            status: 'ok',
            timestamp: new Date(),
            services: {
                database: dbStatus,
                whatsapp: waStatus,
                environment: process.env.NODE_ENV
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ── CORREÇÃO AQUI: Usando LET para permitir reatribuição e evitar o erro "Assignment to constant variable"
let serverInstance = null;

serverInstance = app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`🚀 Servidor Jurídico rodando na porta ${PORT}`);
    
    try {
        const apiAcessivel = await evolutionAPI.testConnection();
        if (apiAcessivel) {
            logger.info('✅ Conexão com Evolution API validada');
        } else {
            logger.warn('⚠️ Evolution API não está acessível no momento');
        }
    } catch (error) {
        logger.error('Erro na inicialização dos serviços', { error: error.message });
    }
});

// Graceful Shutdown
const gracefulShutdown = (signal) => {
    logger.info(`${signal} recebido. Fechando servidor HTTP...`);
    if (serverInstance) {
        serverInstance.close(async () => {
            logger.info('Servidor HTTP fechado.');
            try {
                if (emailService?.stop) emailService.stop();
                if (monitoramentoProcessual?.stop) monitoramentoProcessual.stop();
                
                if (db?.pool?.end) {
                    await db.pool.end();
                } else if (db?.end) {
                    await db.end();
                }
                logger.info('Shutdown completo');
                process.exit(0);
            } catch (error) {
                logger.error('Erro durante shutdown', { error: error.message });
                process.exit(1);
            }
        });
    }
    setTimeout(() => { process.exit(1); }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception (servidor continua)', {
        error: error.message,
        stack: error.stack
    });
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection (servidor continua)', {
        reason: reason?.message || reason
    });
});

module.exports = app;