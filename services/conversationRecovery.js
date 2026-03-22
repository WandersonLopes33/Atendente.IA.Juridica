const logger = require('../utils/logger');
const db = require('./database');
const evolutionAPI = require('./evolutionAPI');

class ConversationRecoveryService {
    constructor() {
        this.checkInterval = parseInt(process.env.RECOVERY_CHECK_INTERVAL) || 14400000; // 4 horas
        this.abandonedThreshold = parseInt(process.env.ABANDONED_THRESHOLD) || 14400000; // 4 horas
        this.isRunning = false;
        this.startupDelay = 600000; // 10 minutos (era 30s — causava fetch failed no boot)

        logger.info('Serviço de Recuperação de Conversas inicializado', {
            checkInterval: `${this.checkInterval / 1000}s`,
            abandonedThreshold: `${this.abandonedThreshold / 1000}s`
        });
    }

    start() {
        if (this.isRunning) {
            logger.warn('Serviço de recuperação já está rodando');
            return;
        }

        this.isRunning = true;
        logger.info('🔄 Serviço de recuperação iniciado');

        // Aguarda 30s para o WhatsApp conectar antes da primeira verificação
        setTimeout(() => {
            this.checkAbandonedConversations();
            this.intervalId = setInterval(() => {
                this.checkAbandonedConversations();
            }, this.checkInterval);
        }, this.startupDelay);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.isRunning = false;
            logger.info('🛑 Serviço de recuperação parado');
        }
    }

    async checkAbandonedConversations() {
        try {
            logger.info('🔍 Verificando conversas abandonadas...');

            // Número do advogado — nunca recuperar conversa dele
            const advogadoPhone = (process.env.EMAIL_NOTIFY_PHONE || '').replace(/\D/g, '');

            const query = `
                SELECT 
                    conv.id,
                    conv.telefone,
                    conv.status,
                    conv.ultimo_estado,
                    c.nome as cliente_nome,
                    MAX(m.timestamp) as ultima_mensagem,
                    COUNT(m.id) as total_msgs,
                    (SELECT sender FROM messages WHERE conversation_id = conv.id ORDER BY timestamp DESC LIMIT 1) as ultimo_remetente
                FROM conversations conv
                JOIN clientes c ON conv.cliente_id = c.id
                LEFT JOIN messages m ON m.conversation_id = conv.id
                WHERE conv.status = 'active'
                    AND (conv.transferido_para_humano IS NULL OR conv.transferido_para_humano = false)
                    AND conv.telefone != $1
                    AND (conv.ultimo_estado IS NULL OR conv.ultimo_estado NOT IN (
                        'recuperacao_ignorada',
                        'recuperacao_automatica',
                        'resolvido_automaticamente',
                        'opt_out_cliente',
                        'nome_coletado',
                        'aguardando_nome'
                    ))
                GROUP BY conv.id, conv.telefone, conv.status, conv.ultimo_estado, c.nome
                HAVING
                    COUNT(m.id) >= 2
                    AND MAX(m.timestamp) < NOW() - INTERVAL '${this.abandonedThreshold / 1000} seconds'
                ORDER BY MAX(m.timestamp) ASC
                LIMIT 10
            `;

            const result = await db.query(query, [advogadoPhone]);

            if (result.rows.length === 0) {
                logger.info('✅ Nenhuma conversa abandonada encontrada');
                return;
            }

            logger.info(`📋 Encontradas ${result.rows.length} conversas abandonadas`, {
                conversas: result.rows.map(r => ({
                    id: r.id,
                    cliente: r.cliente_nome,
                    ultimaMensagem: r.ultima_mensagem
                }))
            });

            for (const conversation of result.rows) {
                // Se ja foi tentada recuperacao e cliente nao respondeu — encerra sem tentar de novo
                if (
                    conversation.ultimo_estado === 'recuperacao_automatica' &&
                    conversation.ultimo_remetente === 'bot'
                ) {
                    logger.info('Cliente ignorou recuperacao — encerrando conversa', {
                        conversationId: conversation.id,
                        cliente: conversation.cliente_nome
                    });
                    await this.markAsIgnored(conversation.id);
                    continue;
                }

                await this.recoverConversation(conversation);
                // Pausa entre envios para nao sobrecarregar o WhatsApp
                await new Promise(r => setTimeout(r, 2000));
            }

        } catch (error) {
            logger.error('Erro ao verificar conversas abandonadas', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    async recoverConversation(conversation) {
        try {
            logger.info('🔄 Recuperando conversa', {
                conversationId: conversation.id,
                cliente: conversation.cliente_nome
            });

            const messagesResult = await db.query(
                `SELECT sender, conteudo, timestamp
                 FROM messages
                 WHERE conversation_id = $1
                 ORDER BY timestamp ASC`,
                [conversation.id]
            );

            const messages = messagesResult.rows;
            if (messages.length === 0) return;

            const analysis = await this.analyzeConversation(messages, conversation);

            if (!analysis.needsFollowup || analysis.category === 'pessoal') {
                // Se foi erro de análise (sem internet) — NÃO fecha, só pula
                // Vai tentar novamente no próximo ciclo de 4h
                if (analysis.reason === 'Erro na análise') {
                    logger.info('Análise falhou (sem internet) — pulando conversa sem fechar', {
                        conversationId: conversation.id
                    });
                    return;
                }

                const motivo = analysis.category === 'pessoal'
                    ? 'Conversa pessoal detectada — nao enviar follow-up'
                    : 'Assunto resolvido';
                logger.info(`Conversa nao precisa de follow-up: ${motivo}`, {
                    conversationId: conversation.id,
                    category: analysis.category
                });
                await this.markAsResolved(conversation.id);
                return;
            }

            const recoveryMessage = await this.generateRecoveryMessage(messages, conversation, analysis);

            await evolutionAPI.sendTextMessage(conversation.telefone, recoveryMessage);

            await db.query(
                `INSERT INTO messages (conversation_id, sender, conteudo, tipo)
                 VALUES ($1, $2, $3, $4)`,
                [conversation.id, 'bot', recoveryMessage, 'text']
            );

            await db.query(
                `UPDATE conversations SET ultimo_estado = $1, updated_at = NOW() WHERE id = $2`,
                ['recuperacao_automatica', conversation.id]
            );

            logger.info('✅ Conversa recuperada com sucesso', {
                conversationId: conversation.id,
                cliente: conversation.cliente_nome,
                messageSent: recoveryMessage.substring(0, 50) + '...'
            });

        } catch (error) {
            logger.error('Erro ao recuperar conversa', {
                conversationId: conversation.id,
                error: error.message,
                stack: error.stack
            });
        }
    }

    async analyzeConversation(messages, conversation) {
        try {
            const conversationText = messages.map(m => {
                const sender = m.sender === 'customer' ? 'CLIENTE' : 'DR. LEX (assistente)';
                return `[${sender}]: ${m.conteudo}`;
            }).join('\n');

            const analysisPrompt = `Você é um assistente do escritório Lopes Advocacia. Analise esta conversa jurídica:

CONVERSA:
${conversationText}

CLIENTE: ${conversation.cliente_nome}

INSTRUÇÕES:
- Este é um escritório de advocacia. As conversas são sempre sobre assuntos jurídicos.
- Identifique se o cliente teve sua dúvida jurídica respondida adequadamente
- Verifique se ficou alguma necessidade jurídica pendente
- Gere uma mensagem de follow-up adequada para escritório de advocacia

Responda APENAS em JSON válido:
{
    "needsFollowup": true/false,
    "reason": "motivo curto",
    "clientIntent": "o que o cliente realmente queria juridicamente",
    "suggestedResponse": "mensagem curta de retomada (máximo 2 linhas, tom formal e jurídico)",
    "priority": "low/medium/high",
    "category": "consulta_processo/agendamento/novo_caso/duvida_geral/pessoal/outro"
}

IMPORTANTE: Classifique como "pessoal" se a conversa NÃO tem relação com assuntos jurídicos (ex: IPTV, vendas de produtos, assuntos pessoais).`;

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        {
                            role: 'system',
                            content: 'Você é um assistente jurídico do escritório Lopes Advocacia. Responda SEMPRE em JSON válido sem markdown.'
                        },
                        { role: 'user', content: analysisPrompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 600
                })
            });

            if (!response.ok) throw new Error(`Groq API Error: ${response.status}`);

            const data = await response.json();
            let analysisText = data.choices[0].message.content;
            analysisText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const analysis = JSON.parse(analysisText);

            logger.info('📊 Análise da conversa concluída', {
                conversationId: conversation.id,
                needsFollowup: analysis.needsFollowup,
                priority: analysis.priority,
                category: analysis.category
            });

            return analysis;

        } catch (error) {
            logger.error('Erro ao analisar conversa', { conversationId: conversation.id, error: error.message });
            // Fallback conservador: sem internet NAO envia follow-up
            return {
                needsFollowup: false,
                reason: 'Erro na análise',
                suggestedResponse: null,
                priority: 'low',
                category: 'duvida_geral'
            };
        }
    }

    async generateRecoveryMessage(messages, conversation, analysis) {
        if (analysis.suggestedResponse && analysis.suggestedResponse.length > 10) {
            return analysis.suggestedResponse;
        }

        const templates = {
            consulta_processo: `Olá, ${conversation.cliente_nome}! Você entrou em contato sobre andamento de processo. O Dr. Wanderson Mailson está disponível para atendê-lo. Poderia confirmar o número do processo ou seu CPF?`,
            agendamento: `Olá, ${conversation.cliente_nome}! Vi que você tinha interesse em consulta com a Lopes Advocacia. Ainda gostaria de agendar? Temos disponibilidade esta semana.`,
            novo_caso: `Olá, ${conversation.cliente_nome}! Você mencionou precisar de assistência jurídica. Ainda posso ajudá-lo a iniciar seu atendimento com o Dr. Wanderson Mailson?`,
            duvida_geral: `Olá, ${conversation.cliente_nome}! Nossa conversa ficou pendente. Posso ajudá-lo com algo relacionado à Lopes Advocacia?`
        };

        return templates[analysis.category] || templates.duvida_geral;
    }

    async markAsIgnored(conversationId) {
        try {
            await db.query(
                `UPDATE conversations 
                 SET status = 'closed', ultimo_estado = 'recuperacao_ignorada', updated_at = NOW()
                 WHERE id = $1`,
                [conversationId]
            );
            logger.info('Conversa encerrada por falta de resposta', { conversationId });
        } catch (error) {
            logger.error('Erro ao marcar conversa como ignorada', { conversationId, error: error.message });
        }
    }

        async markAsResolved(conversationId) {
        try {
            await db.query(
                `UPDATE conversations 
                 SET status = 'closed', ultimo_estado = 'resolvido_automaticamente', updated_at = NOW()
                 WHERE id = $1`,
                [conversationId]
            );
            logger.info('✅ Conversa marcada como resolvida', { conversationId });
        } catch (error) {
            logger.error('Erro ao marcar conversa como resolvida', { conversationId, error: error.message });
        }
    }

    async recoverByConversationId(conversationId) {
        try {
            const result = await db.query(
                `SELECT conv.id, conv.telefone, conv.status, conv.ultimo_estado, c.nome as cliente_nome
                 FROM conversations conv
                 JOIN clientes c ON conv.cliente_id = c.id
                 WHERE conv.id = $1`,
                [conversationId]
            );
            if (result.rows.length === 0) throw new Error('Conversa não encontrada');
            await this.recoverConversation(result.rows[0]);
            return { success: true, message: 'Conversa recuperada com sucesso' };
        } catch (error) {
            logger.error('Erro na recuperação manual', { conversationId, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async getStats() {
        try {
            const stats = await db.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE ultimo_estado = 'recuperacao_automatica') as recuperadas,
                    COUNT(*) FILTER (WHERE ultimo_estado = 'resolvido_automaticamente') as auto_resolvidas,
                    COUNT(*) FILTER (WHERE status = 'active' AND updated_at < NOW() - INTERVAL '30 minutes') as pendentes
                FROM conversations
                WHERE created_at > NOW() - INTERVAL '7 days'
            `);
            return stats.rows[0];
        } catch (error) {
            logger.error('Erro ao obter estatísticas', { error: error.message });
            return null;
        }
    }
}

module.exports = new ConversationRecoveryService();