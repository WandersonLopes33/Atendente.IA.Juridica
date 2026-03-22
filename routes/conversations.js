const express = require('express');
const router = express.Router();
const db = require('../services/database');
const logger = require('../utils/logger');

/**
 * GET /api/conversations
 * Listar conversas com filtros
 */
router.get('/', async (req, res) => {
    try {
        const { status, limit = 50 } = req.query;
        
        let query = 'SELECT * FROM conversations';
        const params = [];
        let paramCount = 1;

        if (status) {
            query += ' WHERE status = $1';
            params.push(status);
            paramCount++;
        }

        query += ' ORDER BY updated_at DESC LIMIT $' + paramCount;
        params.push(parseInt(limit));

        const result = await db.query(query, params);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        logger.error('Erro ao listar conversas', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao listar conversas'
        });
    }
});

/**
 * GET /api/conversations/:id
 * Obter detalhes de uma conversa com mensagens
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Buscar conversa
        const conversationResult = await db.query(
            'SELECT * FROM conversations WHERE id = $1',
            [id]
        );

        if (conversationResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Conversa não encontrada'
            });
        }

        // Buscar mensagens
        const messagesResult = await db.query(
            'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC',
            [id]
        );

        res.json({
            success: true,
            data: {
                conversation: conversationResult.rows[0],
                messages: messagesResult.rows
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar conversa', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar conversa'
        });
    }
});

/**
 * PATCH /api/conversations/:id/status
 * Atualizar status da conversa
 */
router.patch('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                error: 'Status é obrigatório'
            });
        }

        const validStatuses = ['active', 'closed', 'transferred'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Status inválido. Use: active, closed, ou transferred'
            });
        }

        const result = await db.query(
            'UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Conversa não encontrada'
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });

    } catch (error) {
        logger.error('Erro ao atualizar status', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar status'
        });
    }
});

/**
 * PATCH /api/conversations/:id/transfer
 * Transferir conversa para humano
 */
router.patch('/:id/transfer', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(
            'UPDATE conversations SET transferido_para_humano = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Conversa não encontrada'
            });
        }

        res.json({
            success: true,
            message: 'Conversa transferida para atendimento humano',
            data: result.rows[0]
        });

    } catch (error) {
        logger.error('Erro ao transferir conversa', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao transferir conversa'
        });
    }
});

/**
 * GET /api/conversations/stats/summary
 * Obter resumo estatístico
 */
router.get('/stats/summary', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'active') as ativas,
                COUNT(*) FILTER (WHERE status = 'closed') as fechadas,
                COUNT(*) FILTER (WHERE transferido_para_humano = TRUE) as transferidas,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as ultimas_24h
            FROM conversations
        `);

        res.json({
            success: true,
            data: result.rows[0]
        });

    } catch (error) {
        logger.error('Erro ao obter estatísticas', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao obter estatísticas'
        });
    }
});

module.exports = router;
