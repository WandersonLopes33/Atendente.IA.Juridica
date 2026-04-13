/**
 * monitoramentoSilencioso.js
 * Quando o advogado assume uma conversa (transferido_para_humano = true),
 * a IA continua gravando tudo sem interagir com o cliente.
 *
 * Salva:
 *   - Todas as mensagens (cliente + advogado) com sender correto
 *   - Documentos enviados no período
 */

const logger = require('../utils/logger');
const db = require('./database');

// ─── Salvar mensagem durante monitoramento ────────────────────────────────────

async function processarMensagemMonitorada(conversationId, phoneNumber, mensagem, senderType) {
    try {
        const sender = senderType === 'advogado' ? 'advogado' : 'customer';

        // Evitar duplicatas — mesma mensagem nos últimos 30 segundos
        const jaExiste = await db.query(
            `SELECT id FROM messages
             WHERE conversation_id = $1
               AND conteudo = $2
               AND sender = $3
               AND timestamp > NOW() - INTERVAL '30 seconds'`,
            [conversationId, mensagem, sender]
        );

        if (jaExiste.rows.length > 0) return;

        await db.query(
            `INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata)
             VALUES ($1, $2, $3, 'text', NOW(), $4)`,
            [conversationId, sender, mensagem,
                JSON.stringify({ monitorado: true, silencioso: true })]
        );

        logger.info('Mensagem monitorada salva', {
            conversationId,
            sender,
            length: mensagem.length
        });

    } catch (err) {
        logger.error('Erro no monitoramento silencioso', { error: err.message });
    }
}

// ─── Registrar documento recebido durante atendimento humano ─────────────────

async function registrarDocumentoMonitorado(conversationId, filename, categoria, documentoId) {
    try {
        await db.query(
            `INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata)
             VALUES ($1, 'customer', $2, 'document', NOW(), $3)`,
            [conversationId,
                `[Documento enviado durante atendimento: ${filename}]`,
                JSON.stringify({
                    monitorado: true,
                    silencioso: true,
                    filename,
                    categoria,
                    documentoId
                })]
        );
        logger.info('Documento monitorado registrado', { conversationId, filename });
    } catch (err) {
        logger.error('Erro ao registrar documento monitorado', { error: err.message });
    }
}

// ─── Encerrar atendimento humano ──────────────────────────────────────────────

async function encerrarAtendimentoHumano(conversationId) {
    try {
        logger.info('Atendimento humano encerrado — bot retomando', { conversationId });

        await db.query(
            `INSERT INTO messages (conversation_id, sender, conteudo, tipo, timestamp, metadata)
             VALUES ($1, 'system', $2, 'evento', NOW(), $3)`,
            [conversationId,
                '[Atendimento pelo Dr. Wanderson encerrado — bot retomando]',
                JSON.stringify({ tipo: 'encerramento_atendimento_humano' })]
        );

    } catch (err) {
        logger.error('Erro ao encerrar atendimento humano', { error: err.message });
    }
}

module.exports = {
    processarMensagemMonitorada,
    registrarDocumentoMonitorado,
    encerrarAtendimentoHumano
};