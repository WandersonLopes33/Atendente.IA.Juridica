const express = require('express');
const router = express.Router();
const db = require('../services/database');
const evolutionAPI = require('../services/evolutionAPI');
const logger = require('../utils/logger');

/**
 * GET /api/messages/:conversationId
 * Obter mensagens de uma conversa
 */
router.get('/:conversationId', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { limit = 100 } = req.query;

        const result = await db.query(
            'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC LIMIT $2',
            [conversationId, parseInt(limit)]
        );

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        logger.error('Erro ao buscar mensagens', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar mensagens'
        });
    }
});

/**
 * POST /api/messages/send
 * Enviar mensagem manual
 */
router.post('/send', async (req, res) => {
    try {
        const { telefone, mensagem, conversationId } = req.body;

        if (!telefone || !mensagem) {
            return res.status(400).json({
                success: false,
                error: 'Telefone e mensagem são obrigatórios'
            });
        }

        // Enviar via Evolution API
        await evolutionAPI.sendTextMessage(telefone, mensagem);

        // Se tiver conversationId, salvar no banco
        if (conversationId) {
            await db.query(
                'INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp) VALUES ($1, $2, $3, $4, NOW())',
                [conversationId, 'human', mensagem, 'text']
            );
        }

        res.json({
            success: true,
            message: 'Mensagem enviada com sucesso'
        });

    } catch (error) {
        logger.error('Erro ao enviar mensagem', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao enviar mensagem'
        });
    }
});

module.exports = router;
