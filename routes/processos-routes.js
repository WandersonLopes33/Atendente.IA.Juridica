const express = require('express');
const router = express.Router();
const dataJudService = require('../services/dataJudService');
const monitoramento = require('../services/monitoramentoProcessualService');
const db = require('../services/database');
const logger = require('../utils/logger');

/**
 * POST /api/processos/consultar
 * Consultar processo pela primeira vez
 */
router.post('/consultar', async (req, res) => {
    try {
        const { numeroProcesso, advogadoId, clienteId } = req.body;

        if (!numeroProcesso || !advogadoId) {
            return res.status(400).json({
                success: false,
                error: 'Número do processo e ID do advogado são obrigatórios'
            });
        }

        // Buscar credenciais do advogado
        const advogadoResult = await db.query(
            'SELECT * FROM advogados WHERE id = $1',
            [advogadoId]
        );

        if (advogadoResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Advogado não encontrado'
            });
        }

        const advogado = advogadoResult.rows[0];

        // Inicializar DataJud
        dataJudService.initialize({
            datajud_api_key: advogado.datajud_api_key,
            datajud_certificado: advogado.datajud_certificado
        });

        // Consultar processo
        const dados = await dataJudService.consultarProcesso(numeroProcesso);

        // Salvar processo no banco
        const processoResult = await db.query(
            `INSERT INTO processos (
                advogado_id, cliente_id, numero_processo, numero_cnj,
                tribunal, instancia, vara, comarca, juiz, situacao,
                classe_processual, assunto, data_distribuicao, valor_causa,
                autor, reu, outros_envolvidos, ultimo_check, ultima_movimentacao
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), $18)
            RETURNING id`,
            [
                advogadoId,
                clienteId || null,
                numeroProcesso,
                dados.numeroCNJ,
                dados.tribunal,
                dados.instancia,
                dados.orgaoJulgador,
                dados.comarca,
                dados.juiz,
                dados.situacao,
                dados.classe,
                dados.assunto,
                dados.dataDistribuicao,
                dados.valorCausa,
                JSON.stringify(dados.partes.autor),
                JSON.stringify(dados.partes.reu),
                JSON.stringify(dados.partes.outros),
                dados.movimentacoes[0]?.data || null
            ]
        );

        const processoId = processoResult.rows[0].id;

        // Salvar movimentações
        for (const mov of dados.movimentacoes) {
            await db.query(
                `INSERT INTO movimentacoes (
                    processo_id, data_movimentacao, tipo, codigo_movimento,
                    titulo, descricao, conteudo_completo, prioridade, categoria
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    processoId,
                    mov.data,
                    mov.tipo,
                    mov.codigo,
                    mov.tipo,
                    mov.descricao,
                    mov.conteudo,
                    mov.prioridade,
                    mov.categoria
                ]
            );
        }

        logger.info('Processo cadastrado com sucesso', {
            processoId,
            numeroProcesso,
            advogadoId
        });

        res.json({
            success: true,
            message: 'Processo cadastrado e sendo monitorado',
            data: {
                processoId,
                ...dados
            }
        });

    } catch (error) {
        logger.error('Erro ao consultar processo', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao consultar processo: ' + error.message
        });
    }
});

/**
 * GET /api/processos
 * Listar processos do advogado
 */
router.get('/', async (req, res) => {
    try {
        const { advogadoId, clienteId, situacao } = req.query;

        let query = 'SELECT * FROM processos WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (advogadoId) {
            query += ` AND advogado_id = $${paramCount}`;
            params.push(advogadoId);
            paramCount++;
        }

        if (clienteId) {
            query += ` AND cliente_id = $${paramCount}`;
            params.push(clienteId);
            paramCount++;
        }

        if (situacao) {
            query += ` AND situacao = $${paramCount}`;
            params.push(situacao);
            paramCount++;
        }

        query += ' ORDER BY created_at DESC';

        const result = await db.query(query, params);

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        logger.error('Erro ao listar processos', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao listar processos'
        });
    }
});

/**
 * GET /api/processos/:id
 * Obter detalhes de um processo específico
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Buscar processo
        const processoResult = await db.query(
            'SELECT * FROM processos WHERE id = $1',
            [id]
        );

        if (processoResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Processo não encontrado'
            });
        }

        const processo = processoResult.rows[0];

        // Buscar movimentações
        const movimentacoesResult = await db.query(
            `SELECT * FROM movimentacoes 
             WHERE processo_id = $1 
             ORDER BY data_movimentacao DESC`,
            [id]
        );

        res.json({
            success: true,
            data: {
                ...processo,
                movimentacoes: movimentacoesResult.rows
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar processo', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar processo'
        });
    }
});

/**
 * POST /api/processos/:id/atualizar
 * Forçar atualização de um processo
 */
router.post('/:id/atualizar', async (req, res) => {
    try {
        const { id } = req.params;

        // Buscar processo com dados do advogado
        const result = await db.query(
            `SELECT p.*, a.datajud_api_key, a.datajud_certificado
             FROM processos p
             INNER JOIN advogados a ON p.advogado_id = a.id
             WHERE p.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Processo não encontrado'
            });
        }

        const processo = result.rows[0];

        // Verificar processo
        const temNovidade = await monitoramento.verificarProcesso(processo);

        res.json({
            success: true,
            message: temNovidade 
                ? 'Processo atualizado com novas movimentações' 
                : 'Processo atualizado, sem novidades',
            temNovidade
        });

    } catch (error) {
        logger.error('Erro ao atualizar processo', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar processo'
        });
    }
});

/**
 * PATCH /api/processos/:id/notificacoes
 * Ativar/desativar notificações de um processo
 */
router.patch('/:id/notificacoes', async (req, res) => {
    try {
        const { id } = req.params;
        const { ativo } = req.body;

        await db.query(
            'UPDATE processos SET notificacoes_ativas = $1 WHERE id = $2',
            [ativo, id]
        );

        res.json({
            success: true,
            message: `Notificações ${ativo ? 'ativadas' : 'desativadas'}`
        });

    } catch (error) {
        logger.error('Erro ao atualizar notificações', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar notificações'
        });
    }
});

/**
 * DELETE /api/processos/:id
 * Remover processo do monitoramento
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        await db.query('DELETE FROM processos WHERE id = $1', [id]);

        res.json({
            success: true,
            message: 'Processo removido do monitoramento'
        });

    } catch (error) {
        logger.error('Erro ao remover processo', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao remover processo'
        });
    }
});

/**
 * GET /api/processos/:id/movimentacoes
 * Listar movimentações de um processo
 */
router.get('/:id/movimentacoes', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 50 } = req.query;

        const result = await db.query(
            `SELECT * FROM movimentacoes 
             WHERE processo_id = $1 
             ORDER BY data_movimentacao DESC 
             LIMIT $2`,
            [id, parseInt(limit)]
        );

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        logger.error('Erro ao buscar movimentações', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar movimentações'
        });
    }
});

/**
 * GET /api/processos/monitoramento/status
 * Status do monitoramento automático
 */
router.get('/monitoramento/status', (req, res) => {
    const status = monitoramento.getStatus();
    res.json({
        success: true,
        data: status
    });
});

module.exports = router;