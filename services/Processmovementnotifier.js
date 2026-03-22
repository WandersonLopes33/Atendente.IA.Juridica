const logger = require('../utils/logger');
const db = require('./database');
const evolutionAPI = require('./evolutionAPI');
const groqAI = require('./groqAI');

/**
 * Serviço para processar e-mails de movimentação processual
 * e notificar cliente e advogado automaticamente
 */

class ProcessMovementNotifier {
    constructor() {
        this.processoPattern = /\d{7}-\d{2}\.\d{4}\.\d{1}\.\d{2}\.\d{4}/g;
    }

    /**
     * Detecta se e-mail é sobre movimentação processual
     */
    isProcessMovementEmail(subject, body) {
        const keywords = [
            'movimentação processual',
            'processo',
            'tribunal',
            'juiz',
            'sentença',
            'despacho',
            'intimação',
            'citação',
            'andamento processual',
            'decisão',
            'acórdão',
            'diário oficial',
            'publicação'
        ];

        const fullText = `${subject} ${body}`.toLowerCase();

        // Verificar se contém número de processo
        const hasProcessNumber = this.processoPattern.test(fullText);

        // Verificar palavras-chave
        const keywordCount = keywords.filter(k => fullText.includes(k)).length;

        return hasProcessNumber && keywordCount >= 2;
    }

    /**
     * Extrai número do processo do texto
     */
    extractProcessNumber(text) {
        const matches = text.match(this.processoPattern);
        return matches ? matches[0] : null;
    }

    /**
     * Gera resumo da movimentação usando IA
     */
    async generateMovementSummary(subject, body) {
        try {
            const prompt = `Você é um assistente jurídico. Analise este e-mail de movimentação processual e crie um resumo CURTO (máximo 3-4 linhas) e CLARO para o cliente leigo entender.

Assunto: ${subject}

Conteúdo: ${body.substring(0, 2000)}

Responda APENAS com o resumo em linguagem simples, sem jargões jurídicos complexos. Destaque a ação mais importante.`;

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: 'Você é um especialista em simplificar termos jurídicos para leigos.' },
                        { role: 'user', content: prompt }
                    ],
                    max_tokens: 300,
                    temperature: 0.3
                })
            });

            if (!response.ok) {
                throw new Error('Groq API error');
            }

            const data = await response.json();
            return data.choices[0].message.content.trim();

        } catch (error) {
            logger.error('Erro ao gerar resumo com IA', { error: error.message });
            
            // Fallback: resumo simples
            return `Nova movimentação no processo. Assunto: ${subject.substring(0, 100)}`;
        }
    }

    /**
     * Busca dados do processo e cliente no banco
     */
    async getProcessAndClientData(processNumber) {
        try {
            const result = await db.query(
                `SELECT 
                    p.id as processo_id,
                    p.numero_processo,
                    p.cliente_id,
                    c.nome as cliente_nome,
                    c.telefone as cliente_telefone,
                    c.email as cliente_email,
                    a.nome as advogado_nome,
                    a.telefone as advogado_telefone,
                    a.email as advogado_email
                FROM processos p
                JOIN clientes c ON p.cliente_id = c.id
                LEFT JOIN advogados a ON p.advogado_id = a.id
                WHERE p.numero_processo = $1`,
                [processNumber]
            );

            return result.rows.length > 0 ? result.rows[0] : null;

        } catch (error) {
            logger.error('Erro ao buscar dados do processo', { 
                error: error.message,
                processNumber 
            });
            return null;
        }
    }

    /**
     * Salva movimentação no banco
     */
    async saveMovement(processId, subject, summary, fullBody) {
        try {
            await db.query(
                `INSERT INTO movimentacoes (
                    processo_id,
                    tipo,
                    descricao,
                    resumo,
                    data_movimentacao,
                    created_at
                ) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
                [processId, subject, fullBody.substring(0, 5000), summary]
            );

            logger.info('Movimentação salva no banco', { processId });

        } catch (error) {
            logger.error('Erro ao salvar movimentação', { 
                error: error.message,
                processId 
            });
        }
    }

    /**
     * Envia notificação para o cliente
     */
    async notifyClient(clientData, processNumber, summary) {
        if (!clientData.cliente_telefone) {
            logger.warn('Cliente sem telefone cadastrado', { 
                clientId: clientData.cliente_id 
            });
            return;
        }

        const message = `📋 *Atualização do seu Processo*\n\n` +
                       `Olá, ${clientData.cliente_nome}!\n\n` +
                       `Processo: ${processNumber}\n\n` +
                       `📌 *Resumo:*\n${summary}\n\n` +
                       `Qualquer dúvida, estamos à disposição! ⚖️`;

        try {
            await evolutionAPI.sendTextMessage(clientData.cliente_telefone, message);
            logger.info('Cliente notificado sobre movimentação', { 
                clientId: clientData.cliente_id,
                processNumber 
            });
        } catch (error) {
            logger.error('Erro ao notificar cliente', { 
                error: error.message,
                phone: clientData.cliente_telefone 
            });
        }
    }

    /**
     * Envia notificação para o advogado
     */
    async notifyLawyer(clientData, processNumber, subject, summary) {
        const advogadoPhone = clientData.advogado_telefone || process.env.EMAIL_NOTIFY_PHONE;

        if (!advogadoPhone) {
            logger.warn('Advogado sem telefone cadastrado');
            return;
        }

        const message = `⚖️ *Nova Movimentação Processual*\n\n` +
                       `📋 Processo: ${processNumber}\n` +
                       `👤 Cliente: ${clientData.cliente_nome}\n\n` +
                       `📌 *Assunto:*\n${subject}\n\n` +
                       `📝 *Resumo:*\n${summary}\n\n` +
                       `_Notificação automática do sistema_`;

        try {
            await evolutionAPI.sendTextMessage(advogadoPhone, message);
            logger.info('Advogado notificado sobre movimentação', { 
                processNumber,
                advogadoPhone 
            });
        } catch (error) {
            logger.error('Erro ao notificar advogado', { 
                error: error.message,
                phone: advogadoPhone 
            });
        }
    }

    /**
     * Processa e-mail de movimentação (função principal)
     */
    async processMovementEmail(emailData) {
        const { subject, body, from, messageId } = emailData;

        logger.info('Processando e-mail de movimentação', { 
            subject: subject.substring(0, 100),
            from 
        });

        // 1. Verificar se é movimentação processual
        if (!this.isProcessMovementEmail(subject, body)) {
            logger.debug('E-mail não identificado como movimentação processual');
            return { processed: false, reason: 'not_process_movement' };
        }

        // 2. Extrair número do processo
        const processNumber = this.extractProcessNumber(`${subject} ${body}`);
        if (!processNumber) {
            logger.warn('Número do processo não encontrado no e-mail');
            return { processed: false, reason: 'no_process_number' };
        }

        logger.info('Número do processo extraído', { processNumber });

        // 3. Buscar dados do processo e cliente
        const processData = await this.getProcessAndClientData(processNumber);
        if (!processData) {
            logger.warn('Processo não encontrado no banco', { processNumber });
            return { 
                processed: false, 
                reason: 'process_not_found',
                processNumber 
            };
        }

        // 4. Gerar resumo com IA
        const summary = await this.generateMovementSummary(subject, body);

        // 5. Salvar movimentação no banco
        await this.saveMovement(processData.processo_id, subject, summary, body);

        // 6. Notificar cliente
        await this.notifyClient(processData, processNumber, summary);

        // 7. Notificar advogado
        await this.notifyLawyer(processData, processNumber, subject, summary);

        logger.info('E-mail de movimentação processado com sucesso', { 
            processNumber,
            clientNotified: !!processData.cliente_telefone,
            lawyerNotified: !!(processData.advogado_telefone || process.env.EMAIL_NOTIFY_PHONE)
        });

        return {
            processed: true,
            processNumber,
            summary,
            clientNotified: !!processData.cliente_telefone,
            lawyerNotified: !!(processData.advogado_telefone || process.env.EMAIL_NOTIFY_PHONE)
        };
    }

    /**
     * Adicionar padrão customizado de processo
     */
    addCustomProcessPattern(pattern) {
        this.processoPattern = new RegExp(pattern, 'g');
        logger.info('Padrão de processo customizado adicionado', { pattern });
    }
}

module.exports = new ProcessMovementNotifier();