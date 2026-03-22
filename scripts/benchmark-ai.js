#!/usr/bin/env node

/**
 * AI Provider Benchmark Script
 * Testa velocidade e qualidade de todos os providers configurados
 */

const axios = require('axios');
require('dotenv').config();

const API_URL = process.env.API_URL || 'http://localhost:3000';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testProvider(provider) {
  try {
    log(`\n🧪 Testando ${provider.toUpperCase()}...`, 'cyan');
    
    const startTime = Date.now();
    
    const response = await axios.post(`${API_URL}/api/ai/test-message`, {
      message: 'Olá! Quero ir de São Paulo para Rio de Janeiro na sexta-feira de manhã. Qual o preço?',
      history: []
    }, {
      timeout: 60000
    });

    const responseTime = Date.now() - startTime;
    
    if (response.data.success) {
      log(`✅ ${provider} - SUCCESS`, 'green');
      log(`   ⏱️  Tempo: ${responseTime}ms`, 'bright');
      log(`   🤖 Modelo: ${response.data.response.model}`, 'bright');
      log(`   📊 Tokens: ${JSON.stringify(response.data.response.usage)}`, 'bright');
      log(`   📝 Resposta (primeiros 100 chars): ${response.data.response.content.substring(0, 100)}...`, 'bright');
      
      return {
        provider,
        success: true,
        responseTime,
        model: response.data.response.model,
        usage: response.data.response.usage,
        responseLength: response.data.response.content.length
      };
    }
  } catch (error) {
    log(`❌ ${provider} - FAILED: ${error.message}`, 'red');
    return {
      provider,
      success: false,
      error: error.message
    };
  }
}

async function runBenchmark() {
  log('\n═══════════════════════════════════════════', 'bright');
  log('  🚀 AI PROVIDER BENCHMARK - ViagemExpress  ', 'bright');
  log('═══════════════════════════════════════════\n', 'bright');

  // Verificar conexão com servidor
  try {
    await axios.get(`${API_URL}/health`, { timeout: 5000 });
    log('✅ Servidor online\n', 'green');
  } catch (error) {
    log('❌ Servidor offline! Inicie o servidor primeiro.', 'red');
    log(`   Comando: npm start\n`, 'yellow');
    process.exit(1);
  }

  // Providers para testar
  const providers = ['groq', 'claude', 'openai', 'ollama'];
  const results = [];

  // Testar cada provider
  for (const provider of providers) {
    const result = await testProvider(provider);
    results.push(result);
    
    // Aguardar 1 segundo entre testes
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Análise dos resultados
  log('\n═══════════════════════════════════════════', 'bright');
  log('  📊 RESULTADOS DO BENCHMARK', 'bright');
  log('═══════════════════════════════════════════\n', 'bright');

  const successResults = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);

  if (successResults.length === 0) {
    log('❌ Nenhum provider funcionou! Verifique as configurações.\n', 'red');
    process.exit(1);
  }

  // Ordenar por velocidade
  successResults.sort((a, b) => a.responseTime - b.responseTime);

  log('✅ Providers funcionando:\n', 'green');
  
  successResults.forEach((result, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
    log(`${medal} ${result.provider.toUpperCase()}`, 'cyan');
    log(`   ⏱️  Tempo: ${result.responseTime}ms`, 'bright');
    log(`   🤖 Modelo: ${result.model}`, 'bright');
    log(`   📊 Tokens: ${JSON.stringify(result.usage)}`, 'bright');
    log(`   📝 Tamanho resposta: ${result.responseLength} chars\n`, 'bright');
  });

  if (failedResults.length > 0) {
    log('❌ Providers com falha:\n', 'yellow');
    failedResults.forEach(result => {
      log(`   ${result.provider.toUpperCase()}: ${result.error}`, 'red');
    });
    log('');
  }

  // Recomendação
  const fastest = successResults[0];
  log('═══════════════════════════════════════════', 'bright');
  log('  🎯 RECOMENDAÇÃO', 'bright');
  log('═══════════════════════════════════════════\n', 'bright');
  
  log(`🏆 Mais rápido: ${fastest.provider.toUpperCase()}`, 'green');
  log(`   Tempo médio: ${fastest.responseTime}ms`, 'bright');
  log(`   Modelo: ${fastest.model}\n`, 'bright');

  // Custo estimado (se aplicável)
  const costInfo = {
    groq: { cost: 'GRÁTIS', limit: '30 req/min' },
    ollama: { cost: 'GRÁTIS', limit: 'Ilimitado (local)' },
    claude: { cost: '~$150/mês', limit: '50 req/min' },
    openai: { cost: '~$500/mês', limit: '500 req/min' }
  };

  log('💰 Análise de custo (10.000 conversas/mês):\n', 'cyan');
  successResults.forEach(result => {
    const info = costInfo[result.provider];
    const color = info.cost.includes('GRÁTIS') ? 'green' : 'yellow';
    log(`   ${result.provider.toUpperCase()}: ${info.cost} (Limite: ${info.limit})`, color);
  });

  log('\n═══════════════════════════════════════════', 'bright');
  log('  ✨ CONCLUSÃO', 'bright');
  log('═══════════════════════════════════════════\n', 'bright');

  if (fastest.provider === 'groq') {
    log('💡 Groq é o mais rápido E grátis - RECOMENDADO! 🚀', 'green');
  } else if (fastest.provider === 'ollama') {
    log('💡 Ollama é rápido e local - Ótimo para privacidade! 🔒', 'green');
  } else {
    log(`💡 ${fastest.provider.toUpperCase()} é o mais rápido, mas Groq é grátis!`, 'yellow');
    log('   Considere usar Groq para economizar custos. 💰', 'yellow');
  }

  log('\n📌 Para trocar de provider:', 'cyan');
  log(`   1. Edite .env: LLM_PROVIDER=${fastest.provider}`, 'bright');
  log('   2. Reinicie: npm restart', 'bright');
  log('   3. Teste: GET /api/ai/test-connection\n', 'bright');

  log('═══════════════════════════════════════════\n', 'bright');
}

// Executar benchmark
runBenchmark().catch(error => {
  log(`\n❌ Erro fatal: ${error.message}`, 'red');
  process.exit(1);
});
