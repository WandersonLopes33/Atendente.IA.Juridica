/**
 * AI Provider Routes
 * Endpoints para gerenciar e monitorar providers de IA
 */

const express = require('express');
const router = express.Router();
const { getAIProvider } = require('../services/aiProvider');
const logger = require('../utils/logger');

/**
 * GET /api/ai/test-connection
 * Testa conexão com o provider atual
 */
router.get('/test-connection', async (req, res) => {
  try {
    const ai = getAIProvider();
    const result = await ai.testConnection();
    
    res.json({
      success: result.success,
      provider: result.provider,
      model: result.model,
      message: result.success 
        ? `Conexão estabelecida com sucesso! Provider: ${result.provider}, Model: ${result.model}`
        : `Falha na conexão: ${result.error}`
    });
  } catch (error) {
    logger.error('Test connection error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/ai/metrics
 * Retorna métricas do provider
 */
router.get('/metrics', async (req, res) => {
  try {
    const ai = getAIProvider();
    const metrics = ai.getMetrics();
    
    res.json({
      success: true,
      metrics
    });
  } catch (error) {
    logger.error('Get metrics error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/ai/config
 * Retorna configuração atual do provider
 */
router.get('/config', async (req, res) => {
  try {
    const ai = getAIProvider();
    
    res.json({
      success: true,
      config: {
        provider: ai.provider,
        model: ai.config.model,
        maxTokens: ai.config.maxTokens,
        temperature: ai.config.temperature,
        fallbackChain: ai.fallbackProviders,
        hasApiKey: !!ai.config.apiKey
      }
    });
  } catch (error) {
    logger.error('Get config error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/ai/test-message
 * Testa o provider com uma mensagem customizada
 */
router.post('/test-message', async (req, res) => {
  try {
    const { message, history } = req.body;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    const ai = getAIProvider();
    const startTime = Date.now();
    
    const response = await ai.processMessage(message, history || []);
    const responseTime = Date.now() - startTime;
    
    res.json({
      success: true,
      response: {
        content: response.content,
        provider: response.provider,
        model: response.model,
        responseTime,
        usage: response.usage
      }
    });
  } catch (error) {
    logger.error('Test message error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/ai/switch-provider
 * Troca o provider em runtime (admin only)
 */
router.post('/switch-provider', async (req, res) => {
  try {
    const { provider } = req.body;
    
    if (!provider) {
      return res.status(400).json({
        success: false,
        error: 'Provider is required. Options: groq, claude, openai, ollama'
      });
    }

    const validProviders = ['groq', 'claude', 'openai', 'ollama'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        success: false,
        error: `Invalid provider. Options: ${validProviders.join(', ')}`
      });
    }

    const ai = getAIProvider();
    ai.provider = provider;
    ai.config = ai.getProviderConfig();
    
    // Validar configuração
    try {
      ai.validateConfig();
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        error: `Provider configuration invalid: ${validationError.message}`
      });
    }

    // Testar conexão
    const testResult = await ai.testConnection();
    
    res.json({
      success: testResult.success,
      message: testResult.success
        ? `Provider switched to ${provider} successfully`
        : `Failed to switch provider: ${testResult.error}`,
      provider,
      model: ai.config.model
    });
  } catch (error) {
    logger.error('Switch provider error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/ai/available-providers
 * Lista providers disponíveis e seu status
 */
router.get('/available-providers', async (req, res) => {
  try {
    const providers = [
      {
        name: 'groq',
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        configured: !!process.env.GROQ_API_KEY,
        recommended: true,
        cost: 'free',
        speed: 'very-fast'
      },
      {
        name: 'claude',
        model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
        configured: !!process.env.ANTHROPIC_API_KEY,
        recommended: false,
        cost: 'paid',
        speed: 'fast'
      },
      {
        name: 'openai',
        model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
        configured: !!process.env.OPENAI_API_KEY,
        recommended: false,
        cost: 'paid',
        speed: 'medium'
      },
      {
        name: 'ollama',
        model: process.env.OLLAMA_MODEL || 'llama3.1',
        configured: true,
        recommended: false,
        cost: 'free',
        speed: 'medium',
        local: true
      }
    ];

    res.json({
      success: true,
      currentProvider: process.env.LLM_PROVIDER || 'groq',
      providers
    });
  } catch (error) {
    logger.error('Get available providers error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/ai/benchmark
 * Realiza benchmark de todos os providers configurados
 */
router.post('/benchmark', async (req, res) => {
  try {
    const testMessage = req.body.message || 'Olá, como posso ir de São Paulo para Rio de Janeiro?';
    const results = [];

    const providers = ['groq', 'claude', 'openai', 'ollama'];
    const ai = getAIProvider();
    const originalProvider = ai.provider;

    for (const provider of providers) {
      // Verificar se está configurado
      ai.provider = provider;
      ai.config = ai.getProviderConfig();
      
      if (!ai.config.apiKey && provider !== 'ollama') {
        results.push({
          provider,
          configured: false,
          error: 'API key not configured'
        });
        continue;
      }

      try {
        const startTime = Date.now();
        const response = await ai.processMessage(testMessage, []);
        const responseTime = Date.now() - startTime;

        results.push({
          provider,
          configured: true,
          success: true,
          model: response.model,
          responseTime,
          tokensUsed: response.usage?.total_tokens || 'N/A',
          responseLength: response.content.length
        });
      } catch (error) {
        results.push({
          provider,
          configured: true,
          success: false,
          error: error.message
        });
      }
    }

    // Restaurar provider original
    ai.provider = originalProvider;
    ai.config = ai.getProviderConfig();

    // Ordenar por velocidade
    const successResults = results.filter(r => r.success);
    const fastestProvider = successResults.sort((a, b) => a.responseTime - b.responseTime)[0];

    res.json({
      success: true,
      testMessage,
      results,
      recommendation: fastestProvider ? {
        provider: fastestProvider.provider,
        responseTime: fastestProvider.responseTime,
        reason: `Fastest response time: ${fastestProvider.responseTime}ms`
      } : null
    });
  } catch (error) {
    logger.error('Benchmark error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
