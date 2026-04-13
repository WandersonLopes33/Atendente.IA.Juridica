/**
 * agendaService.js
 * Agenda do Dr. Wanderson — banco de dados próprio + alertas via WhatsApp
 *
 * Funcionalidades:
 *   - Criar compromissos via #chat
 *   - Alertar 1 dia antes e 1 hora antes via WhatsApp
 *   - Listar compromissos do dia/semana
 *   - Parser inteligente de datas em português
 */

const logger = require('../utils/logger');
const db = require('./database');

// ─── Garantir tabela de agenda ────────────────────────────────────────────────

async function garantirTabela() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS agenda (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            descricao TEXT NOT NULL,
            data_hora TIMESTAMPTZ NOT NULL,
            local VARCHAR(500),
            cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL,
            status VARCHAR(20) DEFAULT 'ativo',
            alerta_1d_enviado BOOLEAN DEFAULT FALSE,
            alerta_1h_enviado BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

// ─── Parser de data em português ─────────────────────────────────────────────
// Aceita: "28/03 14h", "28/03/2026 14:30", "amanhã 10h", "segunda 15h"

function parsearData(textoData) {
    const agora = new Date();
    const texto = textoData.toLowerCase().trim();

    // "amanhã Xh" ou "amanhã X:XX"
    if (texto.includes('amanhã') || texto.includes('amanha')) {
        const horaMatch = texto.match(/(\d{1,2})[:h](\d{0,2})/);
        const data = new Date(agora);
        data.setDate(data.getDate() + 1);
        if (horaMatch) {
            data.setHours(parseInt(horaMatch[1]), parseInt(horaMatch[2] || '0'), 0, 0);
        } else {
            data.setHours(8, 0, 0, 0);
        }
        return data;
    }

    // "hoje Xh"
    if (texto.includes('hoje')) {
        const horaMatch = texto.match(/(\d{1,2})[:h](\d{0,2})/);
        const data = new Date(agora);
        if (horaMatch) {
            data.setHours(parseInt(horaMatch[1]), parseInt(horaMatch[2] || '0'), 0, 0);
        }
        return data;
    }

    // "DD/MM hh" ou "DD/MM/AAAA hh:mm"
    const dataMatch = texto.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    const horaMatch = texto.match(/(\d{1,2})[:h](\d{0,2})/);

    if (dataMatch) {
        const dia = parseInt(dataMatch[1]);
        const mes = parseInt(dataMatch[2]) - 1;
        let ano = dataMatch[3] ? parseInt(dataMatch[3]) : agora.getFullYear();
        if (ano < 100) ano += 2000;

        const hora = horaMatch ? parseInt(horaMatch[1]) : 8;
        const min = horaMatch ? parseInt(horaMatch[2] || '0') : 0;

        const data = new Date(ano, mes, dia, hora, min, 0);
        return isNaN(data.getTime()) ? null : data;
    }

    // Dias da semana
    const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const diaEncontrado = dias.findIndex(d => texto.includes(d));
    if (diaEncontrado >= 0) {
        const data = new Date(agora);
        const diaSemanaAtual = data.getDay();
        let diff = diaEncontrado - diaSemanaAtual;
        if (diff <= 0) diff += 7;
        data.setDate(data.getDate() + diff);
        const horaMatch2 = texto.match(/(\d{1,2})[:h](\d{0,2})/);
        if (horaMatch2) {
            data.setHours(parseInt(horaMatch2[1]), parseInt(horaMatch2[2] || '0'), 0, 0);
        } else {
            data.setHours(8, 0, 0, 0);
        }
        return data;
    }

    return null;
}

function formatarDataHora(data) {
    return new Date(data).toLocaleString('pt-BR', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Fortaleza'
    });
}

function formatarHora(data) {
    return new Date(data).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Fortaleza'
    });
}

// ─── Criar compromisso ────────────────────────────────────────────────────────

async function criarCompromisso(descricao, textoData, clienteId = null) {
    try {
        await garantirTabela();

        const dataHora = parsearData(textoData);
        if (!dataHora) {
            return `❌ Não consegui entender a data *"${textoData}"*.\n\nFormatos aceitos:\n• \`28/03 14h\`\n• \`28/03/2026 14:30\`\n• \`amanhã 10h\`\n• \`segunda 15h\``;
        }

        await db.query(
            `INSERT INTO agenda (descricao, data_hora, cliente_id) VALUES ($1, $2, $3)`,
            [descricao, dataHora, clienteId || null]
        );

        const dataFormatada = formatarDataHora(dataHora);
        logger.info('Compromisso criado', { descricao, dataHora });

        return `✅ *Compromisso agendado!*\n\n📅 *${descricao}*\n🕐 ${dataFormatada}\n\nVou te lembrar 1 dia antes e 1 hora antes.`;

    } catch (err) {
        logger.error('Erro ao criar compromisso', { error: err.message });
        return '❌ Erro ao criar compromisso. Tente novamente.';
    }
}

// ─── Listar compromissos ──────────────────────────────────────────────────────

async function listarCompromissos(dias = 2) {
    try {
        await garantirTabela();

        const agora = new Date();
        const ate = new Date(agora);
        ate.setDate(ate.getDate() + dias);

        const res = await db.query(
            `SELECT id, descricao, data_hora, local, status
             FROM agenda
             WHERE data_hora BETWEEN $1 AND $2
               AND status = 'ativo'
             ORDER BY data_hora ASC`,
            [agora, ate]
        );

        if (res.rows.length === 0) {
            const periodo = dias <= 2 ? 'hoje e amanhã' : `próximos ${dias} dias`;
            return `📅 Nenhum compromisso agendado para ${periodo}.`;
        }

        const titulo = dias <= 2 ? '📅 *Compromissos — hoje e amanhã*' : `📅 *Compromissos — próximos ${dias} dias*`;
        let msg = titulo + '\n\n';

        res.rows.forEach(c => {
            const dataFormatada = formatarDataHora(c.data_hora);
            msg += `🔹 *${c.descricao}*\n   📍 ${dataFormatada}\n`;
            if (c.local) msg += `   📌 ${c.local}\n`;
            msg += '\n';
        });

        return msg.trim();

    } catch (err) {
        logger.error('Erro ao listar compromissos', { error: err.message });
        return '❌ Erro ao buscar compromissos.';
    }
}

// ─── Cancelar compromisso ─────────────────────────────────────────────────────

async function cancelarCompromisso(id) {
    try {
        await db.query(
            `UPDATE agenda SET status = 'cancelado' WHERE id = $1`,
            [id]
        );
        return true;
    } catch {
        return false;
    }
}

// ─── Sistema de alertas — roda a cada 5 minutos ───────────────────────────────

async function verificarAlertas() {
    try {
        await garantirTabela();

        const agora = new Date();

        // Alerta 1 dia antes (entre 23h e 25h de antecedência)
        const em23h = new Date(agora.getTime() + 23 * 60 * 60 * 1000);
        const em25h = new Date(agora.getTime() + 25 * 60 * 60 * 1000);

        const alertas1d = await db.query(
            `SELECT * FROM agenda
             WHERE data_hora BETWEEN $1 AND $2
               AND status = 'ativo'
               AND alerta_1d_enviado = FALSE`,
            [em23h, em25h]
        );

        for (const comp of alertas1d.rows) {
            await enviarAlerta(comp, '1 dia');
            await db.query(
                `UPDATE agenda SET alerta_1d_enviado = TRUE WHERE id = $1`,
                [comp.id]
            );
        }

        // Alerta 1 hora antes (entre 55min e 65min de antecedência)
        const em55min = new Date(agora.getTime() + 55 * 60 * 1000);
        const em65min = new Date(agora.getTime() + 65 * 60 * 1000);

        const alertas1h = await db.query(
            `SELECT * FROM agenda
             WHERE data_hora BETWEEN $1 AND $2
               AND status = 'ativo'
               AND alerta_1h_enviado = FALSE`,
            [em55min, em65min]
        );

        for (const comp of alertas1h.rows) {
            await enviarAlerta(comp, '1 hora');
            await db.query(
                `UPDATE agenda SET alerta_1h_enviado = TRUE WHERE id = $1`,
                [comp.id]
            );
        }

        if (alertas1d.rows.length + alertas1h.rows.length > 0) {
            logger.info('Alertas de agenda enviados', {
                alertas1d: alertas1d.rows.length,
                alertas1h: alertas1h.rows.length
            });
        }

    } catch (err) {
        logger.error('Erro ao verificar alertas de agenda', { error: err.message });
    }
}

async function enviarAlerta(compromisso, antecedencia) {
    try {
        const evolutionAPI = require('./evolutionAPI');
        const advPhone = (process.env.EMAIL_NOTIFY_PHONE || '').replace(/\D/g, '');
        if (!advPhone) return;

        const emoji = antecedencia === '1 hora' ? '⏰' : '📅';
        const dataFormatada = formatarDataHora(compromisso.data_hora);
        const hora = formatarHora(compromisso.data_hora);

        let msg = `${emoji} *Lembrete — ${antecedencia} para seu compromisso*\n\n`;
        msg += `📌 *${compromisso.descricao}*\n`;
        msg += `🕐 ${antecedencia === '1 hora' ? hora : dataFormatada}\n`;
        if (compromisso.local) msg += `📍 ${compromisso.local}\n`;

        await evolutionAPI.sendTextMessage(advPhone, msg);
        logger.info('Alerta de agenda enviado', {
            compromisso: compromisso.descricao,
            antecedencia
        });

    } catch (err) {
        logger.error('Erro ao enviar alerta', { error: err.message });
    }
}

// ─── Iniciar serviço de alertas ───────────────────────────────────────────────

function iniciarAlertas() {
    // Verificar a cada 5 minutos
    const INTERVALO = 5 * 60 * 1000;
    verificarAlertas(); // Verificação imediata
    setInterval(verificarAlertas, INTERVALO);
    logger.info('📅 Serviço de agenda iniciado', { intervalo: '5 minutos' });
}

module.exports = {
    criarCompromisso,
    listarCompromissos,
    cancelarCompromisso,
    verificarAlertas,
    iniciarAlertas,
    parsearData
};