const express = require('express');
const router = express.Router();
const dataJudService = require('../services/dataJudService');
const db = require('../services/database');
const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * Criptografar dados sensíveis
 */
function encrypt(text) {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'chave-secreta-temporaria', 'salt', 32);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * POST /api/advogados
 * Cadastrar novo advogado
 */
router.post('/', async (req, res) => {
    try {
        const {
            nome,
            oab,
            email,
            telefone,
            datajud_api_key,
            datajud_certificado,
            datajud_senha_certificado,
            tribunais_atuacao
        } = req.body;

        if (!nome || !oab) {
            return res.status(400).json({
                success: false,
                error: 'Nome e OAB são obrigatórios'
            });
        }

        // Validar API Key do DataJud se fornecida
        if (datajud_api_key) {
            const validacao = await dataJudService.validarCredenciais(datajud_api_key);
            if (!validacao.valido) {
                return res.status(400).json({
                    success: false,
                    error: 'Credenciais DataJud inválidas: ' + validacao.mensagem
                });
            }
        }

        // Criptografar senha do certificado se fornecida
        const senhaCriptografada = datajud_senha_certificado 
            ? encrypt(datajud_senha_certificado) 
            : null;

        const result = await db.query(
            `INSERT INTO advogados (
                nome, oab, email, telefone,
                datajud_api_key, datajud_certificado, datajud_senha_certificado,
                tribunais_atuacao
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, nome, oab, email, telefone, tribunais_atuacao, status, created_at`,
            [
                nome,
                oab,
                email,
                telefone,
                datajud_api_key,
                datajud_certificado,
                senhaCriptografada,
                JSON.stringify(tribunais_atuacao || [])
            ]
        );

        logger.info('Advogado cadastrado', {
            advogadoId: result.rows[0].id,
            nome,
            oab
        });

        res.json({
            success: true,
            message: 'Advogado cadastrado com sucesso',
            data: result.rows[0]
        });

    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(400).json({
                success: false,
                error: 'OAB já cadastrada'
            });
        }

        logger.error('Erro ao cadastrar advogado', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao cadastrar advogado'
        });
    }
});

/**
 * GET /api/advogados
 * Listar advogados
 */
router.get('/', async (req, res) => {
    try {
        const { status = 'ativo' } = req.query;

        const result = await db.query(
            `SELECT id, nome, oab, email, telefone, tribunais_atuacao, 
                    notificacoes_ativas, status, created_at,
                    (datajud_api_key IS NOT NULL) as tem_datajud
             FROM advogados 
             WHERE status = $1
             ORDER BY nome`,
            [status]
        );

        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        logger.error('Erro ao listar advogados', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao listar advogados'
        });
    }
});

/**
 * GET /api/advogados/:id
 * Obter dados de um advogado
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await db.query(
            `SELECT id, nome, oab, email, telefone, tribunais_atuacao,
                    notificacoes_ativas, horario_notificacao_inicio, horario_notificacao_fim,
                    status, created_at, updated_at,
                    (datajud_api_key IS NOT NULL) as tem_datajud
             FROM advogados 
             WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Advogado não encontrado'
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });

    } catch (error) {
        logger.error('Erro ao buscar advogado', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar advogado'
        });
    }
});

/**
 * PATCH /api/advogados/:id
 * Atualizar dados do advogado
 */
router.patch('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            nome,
            email,
            telefone,
            datajud_api_key,
            tribunais_atuacao,
            notificacoes_ativas,
            horario_notificacao_inicio,
            horario_notificacao_fim
        } = req.body;

        const updates = [];
        const params = [];
        let paramCount = 1;

        if (nome !== undefined) {
            updates.push(`nome = $${paramCount}`);
            params.push(nome);
            paramCount++;
        }

        if (email !== undefined) {
            updates.push(`email = $${paramCount}`);
            params.push(email);
            paramCount++;
        }

        if (telefone !== undefined) {
            updates.push(`telefone = $${paramCount}`);
            params.push(telefone);
            paramCount++;
        }

        if (datajud_api_key !== undefined) {
            // Validar nova API key
            if (datajud_api_key) {
                const validacao = await dataJudService.validarCredenciais(datajud_api_key);
                if (!validacao.valido) {
                    return res.status(400).json({
                        success: false,
                        error: 'API Key inválida'
                    });
                }
            }

            updates.push(`datajud_api_key = $${paramCount}`);
            params.push(datajud_api_key);
            paramCount++;
        }

        if (tribunais_atuacao !== undefined) {
            updates.push(`tribunais_atuacao = $${paramCount}`);
            params.push(JSON.stringify(tribunais_atuacao));
            paramCount++;
        }

        if (notificacoes_ativas !== undefined) {
            updates.push(`notificacoes_ativas = $${paramCount}`);
            params.push(notificacoes_ativas);
            paramCount++;
        }

        if (horario_notificacao_inicio !== undefined) {
            updates.push(`horario_notificacao_inicio = $${paramCount}`);
            params.push(horario_notificacao_inicio);
            paramCount++;
        }

        if (horario_notificacao_fim !== undefined) {
            updates.push(`horario_notificacao_fim = $${paramCount}`);
            params.push(horario_notificacao_fim);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Nenhum campo para atualizar'
            });
        }

        updates.push(`updated_at = NOW()`);
        params.push(id);

        const query = `
            UPDATE advogados 
            SET ${updates.join(', ')}
            WHERE id = $${paramCount}
            RETURNING id, nome, oab, email, telefone, tribunais_atuacao
        `;

        const result = await db.query(query, params);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Advogado não encontrado'
            });
        }

        logger.info('Advogado atualizado', { advogadoId: id });

        res.json({
            success: true,
            message: 'Advogado atualizado com sucesso',
            data: result.rows[0]
        });

    } catch (error) {
        logger.error('Erro ao atualizar advogado', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar advogado'
        });
    }
});

/**
 * GET /api/advogados/:id/estatisticas
 * Estatísticas do advogado
 */
router.get('/:id/estatisticas', async (req, res) => {
    try {
        const { id } = req.params;

        const stats = await db.query(`
            SELECT 
                COUNT(*) as total_processos,
                COUNT(*) FILTER (WHERE situacao = 'Em andamento') as processos_ativos,
                COUNT(*) FILTER (WHERE situacao = 'Arquivado') as processos_arquivados,
                COUNT(DISTINCT cliente_id) as total_clientes
            FROM processos
            WHERE advogado_id = $1
        `, [id]);

        const movimentacoesRecentes = await db.query(`
            SELECT COUNT(*) as total
            FROM movimentacoes m
            INNER JOIN processos p ON m.processo_id = p.id
            WHERE p.advogado_id = $1
            AND m.created_at >= NOW() - INTERVAL '30 days'
        `, [id]);

        res.json({
            success: true,
            data: {
                ...stats.rows[0],
                movimentacoes_30_dias: parseInt(movimentacoesRecentes.rows[0].total)
            }
        });

    } catch (error) {
        logger.error('Erro ao buscar estatísticas', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar estatísticas'
        });
    }
});

/**
 * POST /api/advogados/:id/testar-datajud
 * Testar conexão com DataJud
 */
router.post('/:id/testar-datajud', async (req, res) => {
    try {
        const { id } = req.params;

        const advogadoResult = await db.query(
            'SELECT datajud_api_key FROM advogados WHERE id = $1',
            [id]
        );

        if (advogadoResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Advogado não encontrado'
            });
        }

        const apiKey = advogadoResult.rows[0].datajud_api_key;

        if (!apiKey) {
            return res.status(400).json({
                success: false,
                error: 'API Key do DataJud não configurada'
            });
        }

        const validacao = await dataJudService.validarCredenciais(apiKey);

        res.json({
            success: validacao.valido,
            message: validacao.mensagem
        });

    } catch (error) {
        logger.error('Erro ao testar DataJud', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao testar conexão'
        });
    }
});

module.exports = router;