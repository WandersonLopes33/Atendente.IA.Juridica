const logger = require('../utils/logger');

// Importar provedores disponíveis
let groqAI, anthropicAI, openAI, ollamaAI;

try {
  groqAI = require('./groqAI');
} catch (err) {
  logger.warn('Groq AI não disponível', { error: err.message });
}

// Configuração de provedores
const PROVIDERS = {
  groq: {
    name: 'Groq',
    available: !!groqAI,
    priority: 1,
    generate: groqAI?.generateResponse,
    checkHealth: groqAI?.checkHealth
  },
  anthropic: {
    name: 'Anthropic Claude',
    available: false, // Implementar se necessário
    priority: 2,
    generate: null,
    checkHealth: null
  },
  openai: {
    name: 'OpenAI',
    available: false, // Implementar se necessário
    priority: 3,
    generate: null,
    checkHealth: null
  },
  ollama: {
    name: 'Ollama (Local)',
    available: false, // Implementar se necessário
    priority: 4,
    generate: null,
    checkHealth: null
  }
};

// Cache de status de saúde dos provedores
const healthCache = {
  groq: { healthy: true, lastCheck: Date.now(), failures: 0 },
  anthropic: { healthy: false, lastCheck: 0, failures: 0 },
  openai: { healthy: false, lastCheck: 0, failures: 0 },
  ollama: { healthy: false, lastCheck: 0, failures: 0 }
};

// Configurações
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MAX_FAILURES_BEFORE_SKIP = 3;

/**
 * Obter provedor configurado ou padrão
 * @returns {string} Nome do provedor
 */
function getConfiguredProvider() {
  const provider = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
  
  if (!PROVIDERS[provider] || !PROVIDERS[provider].available) {
    logger.warn(`Provedor ${provider} não disponível, usando Groq como fallback`);
    return 'groq';
  }
  
  return provider;
}

/**
 * Obter lista de provedores disponíveis ordenados por prioridade
 * @returns {Array} Lista de provedores
 */
function getAvailableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([_, config]) => config.available)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([name]) => name);
}

/**
 * Verificar saúde de um provedor
 * @param {string} providerName - Nome do provedor
 * @returns {Promise<boolean>}
 */
async function checkProviderHealth(providerName) {
  const provider = PROVIDERS[providerName];
  const cache = healthCache[providerName];

  // Verificar cache
  const now = Date.now();
  if (cache && (now - cache.lastCheck) < HEALTH_CHECK_INTERVAL) {
    return cache.healthy;
  }

  if (!provider || !provider.available || !provider.checkHealth) {
    healthCache[providerName] = { 
      healthy: false, 
      lastCheck: now, 
      failures: cache.failures 
    };
    return false;
  }

  try {
    logger.debug(`Verificando saúde do provedor ${provider.name}`);
    const isHealthy = await provider.checkHealth();
    
    healthCache[providerName] = { 
      healthy: isHealthy, 
      lastCheck: now,
      failures: isHealthy ? 0 : cache.failures + 1
    };
    
    logger.info(`Provedor ${provider.name}`, { 
      healthy: isHealthy ? 'OK' : 'FALHOU' 
    });
    
    return isHealthy;
  } catch (error) {
    logger.error(`Erro ao verificar saúde do provedor ${provider.name}`, { 
      error: error.message 
    });
    
    healthCache[providerName] = { 
      healthy: false, 
      lastCheck: now,
      failures: cache.failures + 1
    };
    
    return false;
  }
}

/**
 * Gerar resposta usando o provedor configurado com fallback
 * @param {Array} messages - Mensagens da conversa
 * @param {Object} options - Opções adicionais
 * @returns {Promise<Object>} Resposta da IA
 */
async function generateResponse(messages, options = {}) {
  const enableFallback = process.env.FEATURE_AI_FALLBACK_ENABLED !== 'false';
  const primaryProvider = getConfiguredProvider();
  const availableProviders = getAvailableProviders();

  // Lista de provedores a tentar (primário primeiro)
  const providersToTry = [
    primaryProvider,
    ...availableProviders.filter(p => p !== primaryProvider)
  ];

  logger.info('Iniciando geração de resposta', {
    primaryProvider,
    fallbackEnabled: enableFallback,
    totalProviders: providersToTry.length
  });

  let lastError = null;

  for (let i = 0; i < providersToTry.length; i++) {
    const providerName = providersToTry[i];
    const provider = PROVIDERS[providerName];
    const cache = healthCache[providerName];

    // Pular provedores com muitas falhas
    if (cache.failures >= MAX_FAILURES_BEFORE_SKIP) {
      logger.warn(`Pulando provedor ${provider.name} devido a falhas consecutivas`, {
        failures: cache.failures
      });
      continue;
    }

    // Verificar saúde (apenas no fallback, não no primeiro)
    if (i > 0) {
      const isHealthy = await checkProviderHealth(providerName);
      if (!isHealthy) {
        logger.warn(`Provedor ${provider.name} não está saudável, tentando próximo`);
        continue;
      }
    }

    try {
      logger.info(`Tentando provedor ${provider.name}`, {
        attempt: i + 1,
        totalAttempts: providersToTry.length
      });

      const startTime = Date.now();
      const response = await provider.generate(messages, options);
      const duration = Date.now() - startTime;

      if (response && response.success) {
        logger.info(`Resposta gerada com sucesso`, {
          provider: provider.name,
          duration,
          wasFallback: i > 0
        });

        // Resetar contador de falhas em caso de sucesso
        healthCache[providerName].failures = 0;

        return {
          ...response,
          provider: providerName,
          providerName: provider.name,
          wasFallback: i > 0
        };
      } else {
        lastError = response.error || 'Resposta vazia';
        logger.warn(`Provedor ${provider.name} retornou erro`, { 
          error: lastError 
        });
        
        // Incrementar falhas
        healthCache[providerName].failures++;
      }

    } catch (error) {
      lastError = error;
      logger.error(`Erro ao usar provedor ${provider.name}`, {
        error: error.message,
        stack: error.stack
      });
      
      // Incrementar falhas
      healthCache[providerName].failures++;
    }

    // Se não tem fallback habilitado, parar na primeira tentativa
    if (!enableFallback) {
      break;
    }
  }

  // Se chegou aqui, todos os provedores falharam
  logger.error('Todos os provedores de IA falharam', {
    providersAttempted: providersToTry.length,
    lastError: lastError?.message || lastError
  });

  return {
    success: false,
    error: 'all_providers_failed',
    message: 'Todos os serviços de IA estão temporariamente indisponíveis. Tente novamente em alguns instantes.',
    details: lastError?.message || lastError
  };
}

/**
 * Gerar resposta simples
 * @param {string} userMessage - Mensagem do usuário
 * @param {Object} options - Opções adicionais
 * @returns {Promise<string>}
 */
async function generateSimpleResponse(userMessage, options = {}) {
  const messages = [{ role: 'user', content: userMessage }];
  const result = await generateResponse(messages, options);
  
  if (result.success) {
    return result.content;
  } else {
    throw new Error(result.message || 'Erro ao gerar resposta');
  }
}

/**
 * Obter status de todos os provedores
 * @returns {Promise<Object>}
 */
async function getProvidersStatus() {
  const status = {};
  
  for (const [name, config] of Object.entries(PROVIDERS)) {
    const cache = healthCache[name];
    
    status[name] = {
      name: config.name,
      available: config.available,
      healthy: cache.healthy,
      failures: cache.failures,
      lastCheck: cache.lastCheck ? new Date(cache.lastCheck).toISOString() : null,
      isPrimary: name === getConfiguredProvider()
    };
  }
  
  return status;
}

/**
 * Resetar contadores de falhas de todos os provedores
 */
function resetFailureCounters() {
  for (const provider in healthCache) {
    healthCache[provider].failures = 0;
  }
  logger.info('Contadores de falha resetados para todos os provedores');
}

/**
 * Forçar verificação de saúde de todos os provedores
 * @returns {Promise<Object>}
 */
async function checkAllProvidersHealth() {
  const results = {};
  
  for (const [name, config] of Object.entries(PROVIDERS)) {
    if (config.available) {
      results[name] = await checkProviderHealth(name);
    } else {
      results[name] = false;
    }
  }
  
  return results;
}

module.exports = {
  generateResponse,
  generateSimpleResponse,
  getProvidersStatus,
  checkProviderHealth,
  checkAllProvidersHealth,
  resetFailureCounters,
  getConfiguredProvider,
  getAvailableProviders
};