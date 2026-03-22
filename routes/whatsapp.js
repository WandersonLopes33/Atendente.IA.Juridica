const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const evolutionAPI = require('../services/evolutionAPI');

router.get('/status', async (req, res) => {
    try {
        const status = await evolutionAPI.getConnectionStatus();
        res.json({
            success: true,
            data: status
        });
    } catch (error) {
        logger.error('Erro ao verificar status', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao verificar status'
        });
    }
});

router.get('/qrcode', async (req, res) => {
    try {
        const qrcode = await evolutionAPI.getQRCode();
        res.json({
            success: true,
            data: qrcode
        });
    } catch (error) {
        logger.error('Erro ao obter QR Code', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao obter QR Code'
        });
    }
});

router.post('/connect', async (req, res) => {
    try {
        const result = await evolutionAPI.connectInstance();
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Erro ao conectar', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Erro ao conectar'
        });
    }
});

module.exports = router;
