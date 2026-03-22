const express = require('express');
const router = express.Router();
const db = require('../services/database');
const logger = require('../utils/logger');

/**
 * GET /api/analytics/dashboard
 * Métricas gerais do dashboard
 */
router.get('/dashboard', async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const d = parseInt(days);

        const conversationsStats = await db.query(`
            SELECT 
                COUNT(*)                                                      AS total_conversas,
                COUNT(*) FILTER (WHERE status = 'active')                    AS conversas_ativas,
                COUNT(*) FILTER (WHERE status = 'closed')                    AS conversas_fechadas,
                COUNT(*) FILTER (WHERE transferido_para_humano = TRUE)       AS conversas_transferidas,
                COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL) AS conversas_periodo
            FROM conversations
        `, [d]);

        const messagesStats = await db.query(`
            SELECT 
                COUNT(*)                                                           AS total_mensagens,
                COUNT(*) FILTER (WHERE sender = 'customer')                       AS mensagens_clientes,
                COUNT(*) FILTER (WHERE sender = 'bot')                            AS mensagens_bot,
                COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL) AS mensagens_periodo
            FROM messages
        `, [d]);

        const processosStats = await db.query(`
            SELECT
                COUNT(*)                                                    AS total_processos,
                COUNT(*) FILTER (WHERE situacao = 'Em andamento')          AS processos_ativos,
                COUNT(*) FILTER (WHERE situacao = 'Arquivado')             AS processos_arquivados,
                COUNT(DISTINCT cliente_id)                                  AS clientes_com_processo,
                COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL) AS processos_periodo
            FROM processos
        `, [d]);

        const movimentacoesStats = await db.query(`
            SELECT
                COUNT(*) AS total_movimentacoes,
                COUNT(*) FILTER (WHERE m.created_at >= NOW() - ($1 || ' days')::INTERVAL) AS movimentacoes_periodo,
                COUNT(*) FILTER (WHERE m.notificado = TRUE)                AS movimentacoes_notificadas
            FROM movimentacoes m
        `, [d]);

        const consultasStats = await db.query(`
            SELECT
                COUNT(*)                                       AS total_consultas,
                COUNT(*) FILTER (WHERE sucesso = TRUE)        AS consultas_sucesso,
                COUNT(*) FILTER (WHERE sucesso = FALSE)       AS consultas_falha,
                ROUND(AVG(tempo_resposta_ms))                 AS tempo_medio_ms
            FROM consultas_processuais
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        `, [d]);

        const casosStats = await db.query(`
            SELECT
                COUNT(*)                                                    AS total_casos,
                COUNT(*) FILTER (WHERE status = 'completo')                AS casos_completos,
                COUNT(*) FILTER (WHERE status = 'em_coleta')               AS casos_em_coleta,
                COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL) AS casos_periodo
            FROM casos_em_coleta
        `, [d]).catch(() => ({ rows: [{ total_casos: 0, casos_completos: 0, casos_em_coleta: 0, casos_periodo: 0 }] }));

        res.json({
            success: true,
            period: `Últimos ${d} dias`,
            data: {
                conversations: conversationsStats.rows[0],
                messages: messagesStats.rows[0],
                processos: processosStats.rows[0],
                movimentacoes: movimentacoesStats.rows[0],
                consultas_datajud: consultasStats.rows[0],
                casos: casosStats.rows[0]
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar dashboard', { error: error.message });
        res.status(500).json({ success: false, error: 'Erro ao buscar métricas do dashboard' });
    }
});

/**
 * GET /api/analytics/daily
 * Conversas e consultas por dia
 */
router.get('/daily', async (req, res) => {
    try {
        const { days = 7 } = req.query;
        const d = parseInt(days);

        const conversas = await db.query(`
            SELECT 
                DATE(created_at)                                        AS data,
                COUNT(*)                                                AS total_conversas,
                COUNT(*) FILTER (WHERE status = 'closed')              AS conversas_fechadas,
                COUNT(*) FILTER (WHERE transferido_para_humano = TRUE) AS transferidas
            FROM conversations
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY DATE(created_at)
            ORDER BY data DESC
        `, [d]);

        const consultas = await db.query(`
            SELECT
                DATE(created_at)                               AS data,
                COUNT(*)                                       AS total_consultas,
                COUNT(*) FILTER (WHERE sucesso = TRUE)        AS sucesso,
                COUNT(*) FILTER (WHERE sucesso = FALSE)       AS falha
            FROM consultas_processuais
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
            GROUP BY DATE(created_at)
            ORDER BY data DESC
        `, [d]);

        res.json({
            success: true,
            data: {
                conversas: conversas.rows,
                consultas_datajud: consultas.rows
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar estatísticas diárias', { error: error.message });
        res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas' });
    }
});

/**
 * GET /api/analytics/processos
 * Estatísticas detalhadas de processos e monitoramento
 */
router.get('/processos', async (req, res) => {
    try {
        const { advogadoId } = req.query;

        const params = advogadoId ? [advogadoId] : [];
        const whereAdvogado = advogadoId ? 'WHERE p.advogado_id = $1' : '';

        const porSituacao = await db.query(`
            SELECT situacao, COUNT(*) AS total
            FROM processos p
            ${whereAdvogado}
            GROUP BY situacao
            ORDER BY total DESC
        `, params);

        const porTribunal = await db.query(`
            SELECT tribunal, COUNT(*) AS total
            FROM processos p
            ${whereAdvogado}
            GROUP BY tribunal
            ORDER BY total DESC
            LIMIT 10
        `, params);

        const semMovimentacao = await db.query(`
            SELECT COUNT(*) AS processos_sem_movimentacao_30d
            FROM processos p
            ${whereAdvogado}
            AND (ultima_movimentacao IS NULL OR ultima_movimentacao < NOW() - INTERVAL '30 days')
        `, params);

        const ultimasMovimentacoes = await db.query(`
            SELECT 
                p.numero_processo,
                p.situacao,
                m.tipo,
                m.data_movimentacao,
                m.notificado,
                c.nome AS cliente
            FROM movimentacoes m
            INNER JOIN processos p ON m.processo_id = p.id
            LEFT JOIN clientes c ON p.cliente_id = c.id
            ${advogadoId ? 'WHERE p.advogado_id = $1' : ''}
            ORDER BY m.data_movimentacao DESC
            LIMIT 20
        `, params);

        res.json({
            success: true,
            data: {
                por_situacao: porSituacao.rows,
                por_tribunal: porTribunal.rows,
                alertas: semMovimentacao.rows[0],
                ultimas_movimentacoes: ultimasMovimentacoes.rows
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar analytics de processos', { error: error.message });
        res.status(500).json({ success: false, error: 'Erro ao buscar analytics de processos' });
    }
});

/**
 * GET /api/analytics/clientes
 * Perfil de uso dos clientes
 */
router.get('/clientes', async (req, res) => {
    try {
        const topClientes = await db.query(`
            SELECT
                c.id,
                c.nome,
                c.telefone,
                COUNT(DISTINCT conv.id)  AS total_conversas,
                COUNT(DISTINCT p.id)     AS total_processos,
                MAX(conv.updated_at)     AS ultima_interacao
            FROM clientes c
            LEFT JOIN conversations conv ON conv.cliente_id = c.id
            LEFT JOIN processos p ON p.cliente_id = c.id
            GROUP BY c.id, c.nome, c.telefone
            ORDER BY total_conversas DESC
            LIMIT 20
        `);

        const semProcesso = await db.query(`
            SELECT COUNT(*) AS clientes_sem_processo
            FROM clientes c
            WHERE NOT EXISTS (SELECT 1 FROM processos p WHERE p.cliente_id = c.id)
        `);

        res.json({
            success: true,
            data: {
                top_clientes: topClientes.rows,
                clientes_sem_processo: semProcesso.rows[0]
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar analytics de clientes', { error: error.message });
        res.status(500).json({ success: false, error: 'Erro ao buscar analytics de clientes' });
    }
});

module.exports = router;