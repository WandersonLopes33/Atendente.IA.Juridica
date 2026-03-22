#!/usr/bin/env node

/**
 * Script de teste para verificar instalação
 * Uso: node test-setup.js
 */

const fs = require('fs');
const path = require('path');

console.log('\n🧪 TESTE DE CONFIGURAÇÃO - ViagemExpress\n');
console.log('='.repeat(50));

let errors = 0;
let warnings = 0;

// 1. Verificar Node.js version
console.log('\n📌 Verificando Node.js...');
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));

if (majorVersion >= 18) {
    console.log(`✅ Node.js ${nodeVersion} (OK)`);
} else {
    console.log(`❌ Node.js ${nodeVersion} - Requer >= 18.0.0`);
    errors++;
}

// 2. Verificar .env
console.log('\n📌 Verificando arquivo .env...');
const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
    console.log('✅ Arquivo .env encontrado');
    
    // Ler e verificar variáveis essenciais
    const envContent = fs.readFileSync(envPath, 'utf8');
    
    const required = [
        'EVOLUTION_API_URL',
        'EVOLUTION_API_KEY',
        'ANTHROPIC_API_KEY'
    ];
    
    required.forEach(key => {
        if (envContent.includes(`${key}=`) && !envContent.includes(`${key}=sua-chave`)) {
            console.log(`  ✅ ${key} configurado`);
        } else {
            console.log(`  ❌ ${key} não configurado`);
            errors++;
        }
    });
} else {
    console.log('❌ Arquivo .env não encontrado');
    console.log('   Execute: cp .env.example .env');
    errors++;
}

// 3. Verificar node_modules
console.log('\n📌 Verificando dependências...');
const nodeModulesPath = path.join(__dirname, 'node_modules');

if (fs.existsSync(nodeModulesPath)) {
    console.log('✅ node_modules encontrado');
    
    // Verificar pacotes principais
    const packages = ['express', 'axios', 'better-sqlite3'];
    packages.forEach(pkg => {
        const pkgPath = path.join(nodeModulesPath, pkg);
        if (fs.existsSync(pkgPath)) {
            console.log(`  ✅ ${pkg}`);
        } else {
            console.log(`  ❌ ${pkg} não encontrado`);
            warnings++;
        }
    });
} else {
    console.log('❌ node_modules não encontrado');
    console.log('   Execute: npm install');
    errors++;
}

// 4. Verificar estrutura de pastas
console.log('\n📌 Verificando estrutura...');
const dirs = ['src', 'routes', 'services', 'database', 'utils'];

dirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (fs.existsSync(dirPath)) {
        console.log(`  ✅ ${dir}/`);
    } else {
        console.log(`  ❌ ${dir}/ não encontrado`);
        errors++;
    }
});

// 5. Verificar banco de dados
console.log('\n📌 Verificando banco de dados...');
const dbPath = path.join(__dirname, 'database', 'viagemexpress.db');

if (fs.existsSync(dbPath)) {
    console.log('✅ Banco de dados criado');
} else {
    console.log('⚠️  Banco não encontrado');
    console.log('   Execute: npm run migrate');
    warnings++;
}

// 6. Testar importações
console.log('\n📌 Testando importações...');

try {
    require('./utils/logger');
    console.log('  ✅ Logger');
} catch (e) {
    console.log('  ❌ Logger falhou:', e.message);
    errors++;
}

// Resumo
console.log('\n' + '='.repeat(50));
console.log('\n📊 RESUMO:\n');

if (errors === 0 && warnings === 0) {
    console.log('🎉 TUDO PRONTO! Sistema configurado corretamente.');
    console.log('\n🚀 Próximo passo:');
    console.log('   npm start');
    process.exit(0);
} else if (errors === 0) {
    console.log(`⚠️  ${warnings} avisos encontrados, mas pode prosseguir.`);
    console.log('\n🚀 Próximo passo:');
    console.log('   npm start');
    process.exit(0);
} else {
    console.log(`❌ ${errors} erros críticos encontrados.`);
    console.log('\n📖 Consulte QUICKSTART.md para resolver.');
    process.exit(1);
}
