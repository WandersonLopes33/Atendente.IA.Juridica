const axios = require('axios');
const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * Serviço de Integração com DataJud (CNJ)
 * API oficial para consulta de processos judiciais
 * 
 * Documentação: https://datajud.cnj.jus.br/
 */
class DataJudService {
    constructor() {
        this.baseURL = 'https://api-publica.datajud.cnj.jus.br/api_publica_';
        this.version = 'v2'; // Versão da API
        
        // Cache de consultas (evita requisições desnecessárias)
        this.cache = new Map();
        this.cacheTTL = 3600000; // 1 hora
    }

    /**
     * Inicializar com credenciais do advogado
     */
    initialize(advogadoCredentials) {
        this.apiKey = advogadoCredentials.datajud_api_key;
        this.certificado = advogadoCredentials.datajud_certificado;
        
        if (!this.apiKey) {
            throw new Error('API Key do DataJud não configurada');
        }

        this.client = axios.create({
            baseURL: this.baseURL + this.version,
            headers: {
                'Authorization': `APIKey ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        logger.info('DataJud Service inicializado', {
            version: this.version,
            hasApiKey: !!this.apiKey,
            hasCertificado: !!this.certificado
        });
    }

    /**
     * Consultar processo pelo número CNJ
     */
    async consultarProcesso(numeroProcesso, tribunal = null) {
        const startTime = Date.now();
        
        try {
            // Normalizar número do processo (formato CNJ)
            const numeroCNJ = this.normalizarNumeroProcesso(numeroProcesso);
            
            // Verificar cache
            const cacheKey = `${numeroCNJ}_${tribunal}`;
            if (this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheTTL) {
                    logger.info('Processo retornado do cache', { numeroCNJ });
                    return { ...cached.data, fromCache: true };
                }
            }

            // Consultar API
            const response = await this.client.get('/processos/' + numeroCNJ, {
                params: {
                    tribunal: tribunal || this.detectarTribunal(numeroCNJ)
                }
            });

            const dados = this.processarDadosProcesso(response.data);
            
            // Armazenar em cache
            this.cache.set(cacheKey, {
                data: dados,
                timestamp: Date.now()
            });

            const tempoResposta = Date.now() - startTime;
            
            logger.info('Processo consultado com sucesso', {
                numeroCNJ,
                tribunal,
                tempoResposta: `${tempoResposta}ms`,
                movimentacoes: dados.movimentacoes?.length || 0
            });

            return { ...dados, fromCache: false, tempoResposta };

        } catch (error) {
            const tempoResposta = Date.now() - startTime;
            
            logger.error('Erro ao consultar processo no DataJud', {
                numeroProcesso,
                erro: error.message,
                status: error.response?.status,
                tempoResposta: `${tempoResposta}ms`
            });

            throw new Error(`Erro ao consultar processo: ${error.message}`);
        }
    }

    /**
     * Buscar movimentações de um processo
     */
    async buscarMovimentacoes(numeroProcesso, dataInicio = null) {
        try {
            const numeroCNJ = this.normalizarNumeroProcesso(numeroProcesso);
            
            const response = await this.client.get(`/processos/${numeroCNJ}/movimentacoes`, {
                params: {
                    dataInicio: dataInicio ? this.formatarData(dataInicio) : null
                }
            });

            const movimentacoes = response.data.map(mov => this.processarMovimentacao(mov));
            
            logger.info('Movimentações consultadas', {
                numeroCNJ,
                quantidade: movimentacoes.length,
                dataInicio
            });

            return movimentacoes;

        } catch (error) {
            logger.error('Erro ao buscar movimentações', {
                numeroProcesso,
                erro: error.message
            });
            throw error;
        }
    }

    /**
     * Processar dados do processo retornados pela API
     */
    processarDadosProcesso(dados) {
        return {
            numeroProcesso: dados.numeroProcesso,
            numeroCNJ: this.normalizarNumeroProcesso(dados.numeroProcesso),
            tribunal: dados.tribunal,
            instancia: dados.grau || dados.instancia,
            classe: dados.classe?.nome || dados.classeProcessual,
            assunto: dados.assunto?.nome || dados.assuntos?.map(a => a.nome).join(', '),
            situacao: dados.situacaoProcesso || dados.situacao,
            dataDistribuicao: dados.dataDistribuicao || dados.dataAjuizamento,
            valorCausa: dados.valorCausa,
            orgaoJulgador: dados.orgaoJulgador?.nome || dados.vara,
            juiz: dados.magistrado?.nome || dados.juiz,
            comarca: dados.orgaoJulgador?.municipio || dados.comarca,
            
            // Partes do processo
            partes: {
                autor: dados.partes?.filter(p => p.polo === 'ATIVO').map(p => p.nome) || [],
                reu: dados.partes?.filter(p => p.polo === 'PASSIVO').map(p => p.nome) || [],
                outros: dados.partes?.filter(p => !['ATIVO', 'PASSIVO'].includes(p.polo)) || []
            },
            
            // Movimentações
            movimentacoes: dados.movimentacoes?.map(m => this.processarMovimentacao(m)) || [],
            
            // Metadata
            metadata: {
                sistemaOrigem: dados.sistema,
                dataConsulta: new Date().toISOString(),
                versaoAPI: this.version
            }
        };
    }

    /**
     * Processar movimentação individual
     */
    processarMovimentacao(mov) {
        return {
            data: mov.dataHora || mov.data,
            codigo: mov.codigoMovimento || mov.codigo,
            tipo: mov.movimentoNacional?.nome || mov.tipo,
            descricao: mov.complemento || mov.descricao || mov.movimentoLocal?.nome,
            conteudo: mov.conteudoCompleto || mov.texto,
            
            // Classificação (será refinada pela IA depois)
            categoria: this.classificarMovimentacao(mov),
            prioridade: this.detectarPrioridade(mov)
        };
    }

    /**
     * Classificar tipo de movimentação
     */
    classificarMovimentacao(mov) {
        const tipo = (mov.movimentoNacional?.nome || mov.tipo || '').toLowerCase();
        
        if (tipo.includes('sentença')) return 'sentenca';
        if (tipo.includes('decisão')) return 'decisao';
        if (tipo.includes('despacho')) return 'despacho';
        if (tipo.includes('citação')) return 'citacao';
        if (tipo.includes('intimação')) return 'intimacao';
        if (tipo.includes('petição')) return 'peticao';
        if (tipo.includes('juntada')) return 'juntada';
        if (tipo.includes('audiência')) return 'audiencia';
        
        return 'outros';
    }

    /**
     * Detectar prioridade da movimentação
     */
    detectarPrioridade(mov) {
        const tipo = (mov.movimentoNacional?.nome || mov.tipo || '').toLowerCase();
        const descricao = (mov.complemento || mov.descricao || '').toLowerCase();
        
        // Urgente
        if (tipo.includes('sentença') || tipo.includes('trânsito em julgado')) {
            return 'urgente';
        }
        
        // Alta
        if (tipo.includes('citação') || tipo.includes('intimação') || 
            descricao.includes('prazo')) {
            return 'alta';
        }
        
        // Normal
        if (tipo.includes('decisão') || tipo.includes('despacho')) {
            return 'normal';
        }
        
        // Baixa/Informativo
        return 'baixa';
    }

    /**
     * Normalizar número do processo para formato CNJ
     */
    normalizarNumeroProcesso(numero) {
        // Remove tudo exceto números
        const apenasNumeros = numero.replace(/\D/g, '');
        
        // Formato CNJ: NNNNNNN-DD.AAAA.J.TT.OOOO
        if (apenasNumeros.length === 20) {
            return apenasNumeros.replace(
                /(\d{7})(\d{2})(\d{4})(\d{1})(\d{2})(\d{4})/,
                '$1-$2.$3.$4.$5.$6'
            );
        }
        
        return numero; // Retorna original se não conseguir formatar
    }

    /**
     * Detectar tribunal pelo número CNJ
     */
    detectarTribunal(numeroCNJ) {
        // Formato CNJ: NNNNNNN-DD.AAAA.J.TT.OOOO
        // TT = Segmento da justiça
        const segmento = numeroCNJ.substring(18, 20);
        
        const tribunais = {
            '01': 'STF',
            '02': 'CNJ',
            '03': 'STJ',
            '04': 'JF',  // Justiça Federal
            '05': 'JT',  // Justiça do Trabalho
            '06': 'JE',  // Justiça Eleitoral
            '07': 'JM',  // Justiça Militar
            '08': 'JE',  // Justiça Estadual
        };
        
        return tribunais[segmento] || 'TJXX';
    }

    /**
     * Formatar data para API
     */
    formatarData(data) {
        if (typeof data === 'string') {
            return data;
        }
        return data.toISOString().split('T')[0];
    }

    /**
     * Validar credenciais
     */
    async validarCredenciais(apiKey) {
        try {
            const tempClient = axios.create({
                baseURL: this.baseURL + this.version,
                headers: {
                    'Authorization': `APIKey ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            // Fazer uma requisição simples de teste
            await tempClient.get('/processos', { params: { limit: 1 } });
            
            return { valido: true, mensagem: 'Credenciais válidas' };
            
        } catch (error) {
            return {
                valido: false,
                mensagem: error.response?.status === 401 
                    ? 'API Key inválida' 
                    : 'Erro ao validar credenciais'
            };
        }
    }

    /**
     * Limpar cache
     */
    limparCache() {
        this.cache.clear();
        logger.info('Cache do DataJud limpo');
    }

    /**
     * Estatísticas de uso
     */
    getEstatisticas() {
        return {
            cacheSize: this.cache.size,
            version: this.version,
            baseURL: this.baseURL + this.version
        };
    }
}

module.exports = new DataJudService();