const axios = require('axios');
const logger = require('../utils/logger');

class EvolutionAPIService {
    constructor() {
        this.baseURL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
        this.apiKey = process.env.EVOLUTION_API_KEY;
        this.instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'viagemexpress';
        
        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'apikey': this.apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        logger.info('Evolution API Service inicializado', {
            baseURL: this.baseURL,
            instance: this.instanceName
        });
    }

    async connectInstance() {
        try {
            const response = await this.client.post(`/instance/connect/${this.instanceName}`);
            logger.info('Instância conectada com sucesso', response.data);
            return response.data;
        } catch (error) {
            logger.error('Erro ao conectar instância', { error: error.message });
            throw error;
        }
    }

    async getQRCode() {
        try {
            const response = await this.client.get(`/instance/qrcode/${this.instanceName}`);
            return response.data;
        } catch (error) {
            logger.error('Erro ao obter QR Code', { error: error.message });
            throw error;
        }
    }

    async getConnectionStatus() {
        try {
            const response = await this.client.get(`/instance/connectionState/${this.instanceName}`);
            return response.data;
        } catch (error) {
            logger.error('Erro ao verificar status', { error: error.message });
            throw error;
        }
    }

    async sendTextMessage(phoneNumber, message) {
        try {
            const formattedNumber = this.formatPhoneNumber(phoneNumber);
            
            const payload = {
                number: formattedNumber,
                text: message
            };

            const response = await this.client.post(
                `/message/sendText/${this.instanceName}`,
                payload
            );

            logger.info('Mensagem enviada', {
                to: formattedNumber,
                messageLength: message.length
            });

            return response.data;
        } catch (error) {
            logger.error('Erro ao enviar mensagem', {
                error: error.message,
                phoneNumber
            });
            throw error;
        }
    }

    async sendMediaMessage(phoneNumber, mediaUrl, caption = '', mediaType = 'image') {
        try {
            const formattedNumber = this.formatPhoneNumber(phoneNumber);
            
            const payload = {
                number: formattedNumber,
                mediaUrl: mediaUrl,
                caption: caption
            };

            const endpoint = `/message/send${this.capitalize(mediaType)}/${this.instanceName}`;
            const response = await this.client.post(endpoint, payload);

            logger.info('Mídia enviada', {
                to: formattedNumber,
                mediaType,
                mediaUrl
            });

            return response.data;
        } catch (error) {
            logger.error('Erro ao enviar mídia', {
                error: error.message,
                phoneNumber,
                mediaType
            });
            throw error;
        }
    }

    async sendButtonMessage(phoneNumber, message, buttons) {
        try {
            const formattedNumber = this.formatPhoneNumber(phoneNumber);
            
            const payload = {
                number: formattedNumber,
                title: message,
                buttons: buttons.map((btn, index) => ({
                    id: `btn_${index}`,
                    text: btn
                }))
            };

            const response = await this.client.post(
                `/message/sendButtons/${this.instanceName}`,
                payload
            );

            logger.info('Mensagem com botões enviada', {
                to: formattedNumber,
                buttonsCount: buttons.length
            });

            return response.data;
        } catch (error) {
            logger.error('Erro ao enviar botões', {
                error: error.message,
                phoneNumber
            });
            throw error;
        }
    }

    async markAsRead(phoneNumber, messageId) {
        try {
            const payload = {
                readMessages: [{
                    remoteJid: `${phoneNumber}@s.whatsapp.net`,
                    fromMe: false,
                    id: messageId
                }]
            };
            await this.client.post(`/chat/markMessageAsRead/${this.instanceName}`, payload);
            logger.debug('Mensagem marcada como lida', { phoneNumber, messageId });
        } catch (error) {
            logger.error('Erro ao marcar como lida', { error: error.message, phoneNumber });
        }
    }

    async sendTyping(phoneNumber, isTyping = true) {
        try {
            const payload = {
                number: `${phoneNumber}@s.whatsapp.net`,
                delay: 1000,
                presence: isTyping ? 'composing' : 'paused'
            };
            await this.client.post(`/chat/sendPresence/${this.instanceName}`, payload);
            logger.debug('Typing enviado', { phoneNumber, isTyping });
        } catch (error) {
            logger.error('Erro ao enviar typing', { error: error.message, phoneNumber });
        }
    }

    async setWebhook(webhookUrl) {
        try {
            const payload = {
                enabled: true,
                url: webhookUrl,
                events: [
                    'messages.upsert',
                    'messages.update',
                    'connection.update'
                ]
            };

            const response = await this.client.post(
                `/webhook/set/${this.instanceName}`,
                payload
            );

            logger.info('Webhook configurado', {
                url: webhookUrl,
                events: payload.events
            });

            return response.data;
        } catch (error) {
            logger.error('Erro ao configurar webhook', {
                error: error.message,
                webhookUrl
            });
            throw error;
        }
    }

    async getProfileInfo(phoneNumber) {
        try {
            const formattedNumber = this.formatPhoneNumber(phoneNumber);
            const response = await this.client.get(
                `/profile/info/${this.instanceName}?number=${formattedNumber}`
            );
            return response.data;
        } catch (error) {
            logger.error('Erro ao obter perfil', { error: error.message, phoneNumber });
            return null;
        }
    }

    formatPhoneNumber(phoneNumber) {
        let cleaned = phoneNumber.replace(/\D/g, '');
        if (!cleaned.startsWith('55') && cleaned.length === 11) {
            cleaned = '55' + cleaned;
        }
        return cleaned;
    }

    capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    async disconnect() {
        try {
            const response = await this.client.delete(`/instance/logout/${this.instanceName}`);
            logger.info('Instância desconectada', response.data);
            return response.data;
        } catch (error) {
            logger.error('Erro ao desconectar', { error: error.message });
            throw error;
        }
    }

    async createInstance() {
        try {
            const payload = {
                instanceName: this.instanceName,
                token: this.apiKey,
                qrcode: true
            };
            const response = await this.client.post('/instance/create', payload);
            logger.info('Instância criada com sucesso', response.data);
            return response.data;
        } catch (error) {
            logger.error('Erro ao criar instância', { error: error.message });
            throw error;
        }
    }

    async listInstances() {
        try {
            const response = await this.client.get('/instance/fetchInstances');
            return response.data;
        } catch (error) {
            logger.error('Erro ao listar instâncias', { error: error.message });
            throw error;
        }
    }

    async isConnected() {
        try {
            const status = await this.getConnectionStatus();
            return status.state === 'open';
        } catch (error) {
            logger.warn('WhatsApp não está conectado', { error: error.message });
            return false;
        }
    }

    async testConnection() {
        try {
            const response = await this.client.get('/instance/fetchInstances');
            logger.info('✅ Evolution API está acessível');
            return true;
        } catch (error) {
            logger.error('❌ Evolution API não está acessível', { 
                error: error.message,
                baseURL: this.baseURL 
            });
            return false;
        }
    }
}

module.exports = new EvolutionAPIService();