const express = require('express');
const router = express.Router();
const conversationRecovery = require('../services/conversationRecovery');
const logger = require('../utils/logger');

/**
 * GET /api/recovery/stats
 * Obter estatísticas de recuperação
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await conversationRecovery.getStats();
        
        res.json({
            success: true,
            stats: stats,
            config: {
                checkInterval: `${process.env.RECOVERY_CHECK_INTERVAL / 1000}s`,
                abandonedThreshold: `${process.env.ABANDONED_THRESHOLD / 1000}s`,
                isRunning: conversationRecovery.isRunning
            }
        });
    } catch (error) {
        logger.error('Erro ao obter estatísticas de recuperação', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao obter estatísticas'
        });
    }
});

/**
 * POST /api/recovery/start
 * Iniciar serviço de recuperação automática
 */
router.post('/start', (req, res) => {
    try {
        if (conversationRecovery.isRunning) {
            return res.json({
                success: false,
                message: 'Serviço já está rodando'
            });
        }

        conversationRecovery.start();
        
        res.json({
            success: true,
            message: 'Serviço de recuperação iniciado'
        });
    } catch (error) {
        logger.error('Erro ao iniciar serviço de recuperação', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao iniciar serviço'
        });
    }
});

/**
 * POST /api/recovery/stop
 * Parar serviço de recuperação automática
 */
router.post('/stop', (req, res) => {
    try {
        conversationRecovery.stop();
        
        res.json({
            success: true,
            message: 'Serviço de recuperação parado'
        });
    } catch (error) {
        logger.error('Erro ao parar serviço de recuperação', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao parar serviço'
        });
    }
});

/**
 * POST /api/recovery/check
 * Executar verificação manual de conversas abandonadas
 */
router.post('/check', async (req, res) => {
    try {
        // Executar verificação em background
        conversationRecovery.checkAbandonedConversations()
            .then(() => {
                logger.info('Verificação manual de conversas concluída');
            })
            .catch(error => {
                logger.error('Erro na verificação manual', { error: error.message });
            });
        
        res.json({
            success: true,
            message: 'Verificação iniciada em background'
        });
    } catch (error) {
        logger.error('Erro ao executar verificação manual', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao executar verificação'
        });
    }
});

/**
 * POST /api/recovery/conversation/:id
 * Recuperar conversa específica manualmente
 */
router.post('/conversation/:id', async (req, res) => {
    try {
        const conversationId = req.params.id;
        
        const result = await conversationRecovery.recoverByConversationId(conversationId);
        
        res.json(result);
    } catch (error) {
        logger.error('Erro ao recuperar conversa específica', { 
            conversationId: req.params.id,
            error: error.message 
        });
        res.status(500).json({
            success: false,
            error: 'Erro ao recuperar conversa'
        });
    }
});

module.exports = router;