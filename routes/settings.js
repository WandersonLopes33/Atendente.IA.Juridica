const express = require('express');
const router = express.Router();
const db = require('../services/database');
const logger = require('../utils/logger');

/**
 * GET /api/settings
 * Configurações do sistema
 */
router.get('/', (req, res) => {
    try {
        const settings = {
            sistema: {
                nome: process.env.COMPANY_NAME || 'Lopes Advocacia',
                advogado: process.env.LAWYER_NAME || 'Dr. Wanderson Mailson Machado Lopes',
                oab: process.env.LAWYER_OAB || 'OAB/MA',
                ambiente: process.env.NODE_ENV || 'development',
                versao: '2.0.0'
            },
            horarios: {
                inicio: process.env.BUSINESS_HOURS_START || '08:00',
                fim: process.env.BUSINESS_HOURS_END || '18:00',
                timezone: 'America/Fortaleza'
            },
            ia: {
                provider: process.env.LLM_PROVIDER || 'groq',
                modelo: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                tom: process.env.AI_TONE || 'professional'
            },
            datajud: {
                url: process.env.DATAJUD_API_URL || 'https://api-publica.datajud.cnj.jus.br',
                tribunal_padrao: process.env.DATAJUD_TRIBUNAL || 'tjma',
                configurado: !!process.env.DATAJUD_API_KEY
            },
            contato: {
                email: process.env.SUPPORT_EMAIL,
                telefone: process.env.SUPPORT_PHONE,
                whatsapp_advogado: process.env.EMAIL_NOTIFY_PHONE
            },
            monitoramento: {
                intervalo_minutos: parseInt(process.env.MONITORING_INTERVAL_MINUTES) || 60,
                recuperacao_horas: parseInt(process.env.RECOVERY_ABANDONED_HOURS) || 4
            },
            recursos: {
                transferir_para_humano: process.env.FEATURE_AUTO_TRANSFER_TO_HUMAN === 'true',
                analytics: process.env.FEATURE_ANALYTICS_ENABLED === 'true',
                fallback_ia: process.env.FEATURE_AI_FALLBACK_ENABLED === 'true',
                busca_email: !!process.env.EMAIL_USER,
                busca_documentos: true
            }
        };

        res.json({ success: true, data: settings });

    } catch (error) {
        logger.error('Erro ao buscar configurações', { error: error.message });
        res.status(500).json({ success: false, error: 'Erro ao buscar configurações' });
    }
});

/**
 * GET /api/settings/health
 * Saúde de todos os serviços
 */
router.get('/health', async (req, res) => {
    try {
        // Testa banco
        let dbStatus = 'ok';
        let dbLatency = null;
        try {
            const t0 = Date.now();
            await db.query('SELECT 1');
            dbLatency = Date.now() - t0;
        } catch {
            dbStatus = 'error';
        }

        // Testa Evolution API
        let evolutionStatus = 'unknown';
        try {
            const r = await fetch(
                `${process.env.EVOLUTION_API_URL}/instance/connectionState/${process.env.EVOLUTION_INSTANCE || 'Juridico'}`,
                { headers: { 'apikey': process.env.EVOLUTION_API_KEY }, signal: AbortSignal.timeout(3000) }
            );
            evolutionStatus = r.ok ? 'ok' : 'error';
        } catch {
            evolutionStatus = 'error';
        }

        // Testa DataJud
        let datajudStatus = 'not_configured';
        if (process.env.DATAJUD_API_KEY) {
            try {
                const r = await fetch(
                    `${process.env.DATAJUD_API_URL}/api_publica_${process.env.DATAJUD_TRIBUNAL || 'tjma'}/_search`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `APIKey ${process.env.DATAJUD_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ query: { match_none: {} }, size: 0 }),
                        signal: AbortSignal.timeout(5000)
                    }
                );
                datajudStatus = r.ok ? 'ok' : 'error';
            } catch {
                datajudStatus = 'error';
            }
        }

        const allOk = dbStatus === 'ok' && evolutionStatus === 'ok';

        const health = {
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime_segundos: Math.round(process.uptime()),
            memoria: {
                usada_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
            },
            servicos: {
                postgresql: { status: dbStatus, latencia_ms: dbLatency },
                evolution_api: { status: evolutionStatus, url: process.env.EVOLUTION_API_URL },
                datajud: { status: datajudStatus, tribunal: process.env.DATAJUD_TRIBUNAL || 'tjma' },
                groq: { status: process.env.GROQ_API_KEY ? 'configurado' : 'nao_configurado' },
                email_imap: { status: process.env.EMAIL_USER ? 'configurado' : 'nao_configurado' }
            }
        };

        res.status(allOk ? 200 : 207).json({ success: true, data: health });

    } catch (error) {
        logger.error('Erro ao verificar saúde', { error: error.message });
        res.status(500).json({ success: false, error: 'Erro ao verificar saúde do sistema' });
    }
});

/**
 * GET /api/settings/env-check
 * Verifica quais variáveis de ambiente estão configuradas
 */
router.get('/env-check', (req, res) => {
    const variaveis = [
        // Obrigatórias
        { chave: 'DATABASE_URL',        obrigatoria: true  },
        { chave: 'EVOLUTION_API_URL',   obrigatoria: true  },
        { chave: 'EVOLUTION_API_KEY',   obrigatoria: true  },
        { chave: 'EVOLUTION_INSTANCE',  obrigatoria: true  },
        { chave: 'GROQ_API_KEY',        obrigatoria: true  },
        { chave: 'DATAJUD_API_KEY',     obrigatoria: true  },
        { chave: 'DATAJUD_API_URL',     obrigatoria: true  },
        { chave: 'DATAJUD_TRIBUNAL',    obrigatoria: true  },
        { chave: 'EMAIL_NOTIFY_PHONE',  obrigatoria: true  },
        // Opcionais
        { chave: 'EMAIL_USER',          obrigatoria: false },
        { chave: 'EMAIL_PASSWORD',      obrigatoria: false },
        { chave: 'EMAIL_HOST',          obrigatoria: false },
        { chave: 'GROQ_MODEL',          obrigatoria: false },
        { chave: 'COMPANY_NAME',        obrigatoria: false },
        { chave: 'LAWYER_NAME',         obrigatoria: false },
        { chave: 'BUSINESS_HOURS_START',obrigatoria: false },
        { chave: 'BUSINESS_HOURS_END',  obrigatoria: false },
        { chave: 'ENCRYPTION_KEY',      obrigatoria: false },
    ];

    const resultado = variaveis.map(v => ({
        chave: v.chave,
        obrigatoria: v.obrigatoria,
        configurada: !!process.env[v.chave]
    }));

    const faltando = resultado.filter(v => v.obrigatoria && !v.configurada);

    res.json({
        success: faltando.length === 0,
        variaveis: resultado,
        faltando_obrigatorias: faltando.map(v => v.chave)
    });
});

module.exports = router;