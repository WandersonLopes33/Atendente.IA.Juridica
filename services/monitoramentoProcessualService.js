const dataJudService = require('./dataJudService');
const db = require('./database');
const evolutionAPI = require('./evolutionAPI');
const groqAI = require('./groqAI');
const logger = require('../utils/logger');

/**
 * Serviço de Monitoramento Automático de Processos
 * Verifica periodicamente se há novas movimentações
 */
class MonitoramentoProcessualService {
    constructor() {
        this.intervalId = null;
        this.isRunning = false;
        this.checkInterval = 60 * 60 * 1000; // 1 hora padrão
    }

    /**
     * Iniciar monitoramento automático
     */
    async start(intervalMinutes = 60) {
        if (this.isRunning) {
            logger.warn('Monitoramento já está rodando');
            return;
        }

        this.checkInterval = intervalMinutes * 60 * 1000;
        this.isRunning = true;

        logger.info('🔍 Monitoramento Processual iniciado', {
            intervalo: `${intervalMinutes} minutos`
        });

        // Executar imediatamente
        await this.verificarTodosProcessos();

        // Agendar verificações periódicas
        this.intervalId = setInterval(async () => {
            await this.verificarTodosProcessos();
        }, this.checkInterval);
    }

    /**
     * Parar monitoramento
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        logger.info('⏹️ Monitoramento Processual parado');
    }

    /**
     * Verificar todos os processos cadastrados
     */
    async verificarTodosProcessos() {
        try {
            logger.info('🔍 Verificando todos os processos...');

            // Buscar processos que precisam ser verificados
            const result = await db.query(`
                SELECT 
                    p.*,
                    a.nome as advogado_nome,
                    a.datajud_api_key,
                    a.datajud_certificado,
                    c.telefone as cliente_telefone
                FROM processos p
                INNER JOIN advogados a ON p.advogado_id = a.id
                LEFT JOIN clientes c ON p.cliente_id = c.id
                WHERE p.notificacoes_ativas = TRUE
                AND a.status = 'ativo'
                AND (
                    p.ultimo_check IS NULL 
                    OR p.ultimo_check < NOW() - INTERVAL '1 hour'
                )
                ORDER BY p.prioridade DESC, p.ultimo_check ASC NULLS FIRST
            `);

            const processos = result.rows;

            logger.info(`📋 Encontrados ${processos.length} processos para verificar`);

            if (processos.length === 0) {
                return;
            }

            // Verificar cada processo
            let verificados = 0;
            let comNovidades = 0;

            for (const processo of processos) {
                try {
                    const temNovidade = await this.verificarProcesso(processo);
                    verificados++;
                    if (temNovidade) comNovidades++;

                    // Pequeno delay entre consultas (respeitar rate limit)
                    await this.sleep(2000);

                } catch (error) {
                    logger.error('Erro ao verificar processo', {
                        processo: processo.numero_processo,
                        erro: error.message
                    });
                }
            }

            logger.info('✅ Verificação concluída', {
                total: processos.length,
                verificados,
                comNovidades
            });

        } catch (error) {
            logger.error('Erro na verificação de processos', {
                erro: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Verificar um processo específico
     */
    async verificarProcesso(processo) {
        try {
            // Inicializar DataJud com credenciais do advogado
            dataJudService.initialize({
                datajud_api_key: processo.datajud_api_key,
                datajud_certificado: processo.datajud_certificado
            });

            // Consultar processo
            const dados = await dataJudService.consultarProcesso(
                processo.numero_processo,
                processo.tribunal
            );

            // Atualizar último check
            await db.query(
                `UPDATE processos 
                 SET ultimo_check = NOW(), 
                     situacao = $1,
                     ultima_movimentacao = $2
                 WHERE id = $3`,
                [dados.situacao, dados.movimentacoes[0]?.data, processo.id]
            );

            // Verificar se há novas movimentações
            const novasMovimentacoes = await this.detectarNovasMovimentacoes(
                processo.id,
                dados.movimentacoes
            );

            if (novasMovimentacoes.length > 0) {
                logger.info('🆕 Novas movimentações detectadas', {
                    processo: processo.numero_processo,
                    quantidade: novasMovimentacoes.length
                });

                // Processar cada nova movimentação
                for (const mov of novasMovimentacoes) {
                    await this.processarNovaMovimentacao(processo, mov);
                }

                return true;
            }

            return false;

        } catch (error) {
            logger.error('Erro ao verificar processo individual', {
                processo: processo.numero_processo,
                erro: error.message
            });
            throw error;
        }
    }

    /**
     * Detectar novas movimentações
     */
    async detectarNovasMovimentacoes(processoId, movimentacoes) {
        try {
            // Buscar última movimentação salva
            const result = await db.query(
                `SELECT data_movimentacao 
                 FROM movimentacoes 
                 WHERE processo_id = $1 
                 ORDER BY data_movimentacao DESC 
                 LIMIT 1`,
                [processoId]
            );

            const ultimaData = result.rows[0]?.data_movimentacao;

            if (!ultimaData) {
                // Primeira vez verificando, salvar todas
                return movimentacoes;
            }

            // Filtrar apenas movimentações novas
            return movimentacoes.filter(mov => {
                const dataMovimentacao = new Date(mov.data);
                return dataMovimentacao > new Date(ultimaData);
            });

        } catch (error) {
            logger.error('Erro ao detectar novas movimentações', { erro: error.message });
            return [];
        }
    }

    /**
     * Processar nova movimentação detectada
     */
    async processarNovaMovimentacao(processo, movimentacao) {
        try {
            // Analisar movimentação com IA
            const analise = await this.analisarMovimentacaoComIA(movimentacao);

            // Salvar no banco
            const result = await db.query(
                `INSERT INTO movimentacoes (
                    processo_id, data_movimentacao, tipo, codigo_movimento,
                    titulo, descricao, conteudo_completo,
                    prioridade, categoria, requer_acao, prazo_dias
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id`,
                [
                    processo.id,
                    movimentacao.data,
                    movimentacao.tipo,
                    movimentacao.codigo,
                    movimentacao.tipo,
                    movimentacao.descricao,
                    movimentacao.conteudo,
                    analise.prioridade || movimentacao.prioridade,
                    analise.categoria || movimentacao.categoria,
                    analise.requerAcao || false,
                    analise.prazoDias || null
                ]
            );

            const movimentacaoId = result.rows[0].id;

            logger.info('💾 Movimentação salva', {
                processo: processo.numero_processo,
                tipo: movimentacao.tipo,
                prioridade: analise.prioridade
            });

            // Notificar cliente se configurado
            if (processo.cliente_telefone && this.deveNotificar(analise)) {
                await this.notificarCliente(processo, movimentacao, analise);
                
                // Marcar como notificado
                await db.query(
                    `UPDATE movimentacoes 
                     SET notificado = TRUE, notificado_em = NOW() 
                     WHERE id = $1`,
                    [movimentacaoId]
                );
            }

        } catch (error) {
            logger.error('Erro ao processar nova movimentação', {
                processo: processo.numero_processo,
                erro: error.message
            });
        }
    }

    /**
     * Analisar movimentação com IA (Groq/Llama)
     */
    async analisarMovimentacaoComIA(movimentacao) {
        try {
            const prompt = `Analise a seguinte movimentação processual e retorne um JSON com:
- prioridade: "urgente", "alta", "normal" ou "baixa"
- categoria: tipo da movimentação
- requerAcao: true/false se requer ação do advogado
- prazoDias: número de dias se houver prazo
- resumo: resumo em linguagem simples para o cliente

Movimentação:
Tipo: ${movimentacao.tipo}
Descrição: ${movimentacao.descricao}
Conteúdo: ${movimentacao.conteudo || 'N/A'}

Retorne APENAS o JSON, sem texto adicional.`;

            const response = await groqAI.client.post('/chat/completions', {
                model: groqAI.model,
                max_tokens: 500,
                temperature: 0.3,
                messages: [{ role: 'user', content: prompt }]
            });

            const jsonText = response.data.choices[0].message.content
                .replace(/```json|```/g, '').trim();
            
            return JSON.parse(jsonText);

        } catch (error) {
            logger.warn('Erro ao analisar com IA, usando fallback', {
                erro: error.message
            });
            
            // Fallback: análise básica
            return {
                prioridade: movimentacao.prioridade || 'normal',
                categoria: movimentacao.categoria || 'outros',
                requerAcao: false,
                prazoDias: null,
                resumo: movimentacao.descricao
            };
        }
    }

    /**
     * Verificar se deve notificar baseado nas configurações
     */
    deveNotificar(analise) {
        // Sempre notificar se for urgente
        if (analise.prioridade === 'urgente') {
            return true;
        }

        // Notificar se requer ação
        if (analise.requerAcao) {
            return true;
        }

        // Notificar decisões e sentenças
        if (['sentenca', 'decisao', 'citacao', 'intimacao'].includes(analise.categoria)) {
            return true;
        }

        return false;
    }

    /**
     * Notificar cliente sobre nova movimentação
     */
    async notificarCliente(processo, movimentacao, analise) {
        try {
            const mensagem = this.montarMensagemNotificacao(processo, movimentacao, analise);

            await evolutionAPI.sendTextMessage(processo.cliente_telefone, mensagem);

            logger.info('📨 Cliente notificado', {
                processo: processo.numero_processo,
                cliente: processo.cliente_telefone,
                tipo: movimentacao.tipo
            });

        } catch (error) {
            logger.error('Erro ao notificar cliente', {
                processo: processo.numero_processo,
                erro: error.message
            });
        }
    }

    /**
     * Montar mensagem de notificação
     */
    montarMensagemNotificacao(processo, movimentacao, analise) {
        const icones = {
            urgente: '🔴',
            alta: '🟠',
            normal: '🟡',
            baixa: '🟢'
        };

        const icone = icones[analise.prioridade] || '🔔';
        const data = new Date(movimentacao.data).toLocaleDateString('pt-BR');

        let mensagem = `${icone} *NOVA MOVIMENTAÇÃO PROCESSUAL*\n\n`;
        mensagem += `⚖️ Processo: ${processo.numero_processo}\n`;
        mensagem += `📅 Data: ${data}\n`;
        mensagem += `📋 Tipo: ${movimentacao.tipo}\n\n`;

        if (analise.resumo) {
            mensagem += `📝 ${analise.resumo}\n\n`;
        }

        if (analise.requerAcao && analise.prazoDias) {
            mensagem += `⚠️ *Atenção:* Esta movimentação requer ação em ${analise.prazoDias} dias.\n\n`;
        }

        mensagem += `Em breve ${processo.advogado_nome || 'nosso escritório'} entrará em contato para mais informações.`;

        return mensagem;
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Status do monitoramento
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            checkInterval: `${this.checkInterval / 60000} minutos`
        };
    }
}

module.exports = new MonitoramentoProcessualService();