// Sistema de Secret IDs para LunarAuth

class SecretManager {
    constructor() {
        this.secrets = JSON.parse(localStorage.getItem('lunarauth_secrets') || '[]');
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadSecrets();
    }

    bindEvents() {
        // Botão criar Secret ID
        document.getElementById('createSecretBtn')?.addEventListener('click', () => {
            this.openCreateSecretModal();
        });

        // Confirmar criação
        document.getElementById('confirmCreateSecretBtn')?.addEventListener('click', () => {
            this.createSecret();
        });

        // Copiar Secret ID
        document.getElementById('copySecretBtn')?.addEventListener('click', () => {
            this.copySecretToClipboard();
        });

        // Navegação
        document.querySelectorAll('[data-page="secrets"]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.loadSecrets();
            });
        });
    }

    generateSecretId() {
        // Gera um Secret ID seguro (32 caracteres alfanuméricos)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return 'lunar_' + result;
    }

    openCreateSecretModal() {
        this.populateAppsList();
        document.getElementById('secretNameInput').value = '';
        this.showModal('createSecretModal');
    }

    populateAppsList() {
        const appsList = document.getElementById('secretAppsList');
        const apps = JSON.parse(localStorage.getItem('lunarauth_apps') || '[]');
        
        appsList.innerHTML = '';
        
        apps.forEach(app => {
            const div = document.createElement('div');
            div.className = 'checkbox-field';
            div.innerHTML = `
                <label class="checkbox">
                    <input type="checkbox" name="secretApps" value="${app.id}" />
                    <span class="checkmark"></span>
                    ${app.name} (${app.id})
                </label>
            `;
            appsList.appendChild(div);
        });

        if (apps.length === 0) {
            appsList.innerHTML = '<div class="card-desc">Nenhum AppID criado ainda.</div>';
        }
    }

    createSecret() {
        const name = document.getElementById('secretNameInput').value.trim();
        const selectedApps = Array.from(document.querySelectorAll('input[name="secretApps"]:checked')).map(cb => cb.value);

        if (!name) {
            this.showToast('Erro', 'Digite um nome para o Secret ID');
            return;
        }

        if (selectedApps.length === 0) {
            this.showToast('Erro', 'Selecione pelo menos um AppID');
            return;
        }

        const secretId = this.generateSecretId();
        const secret = {
            id: secretId,
            name: name,
            appIds: selectedApps,
            createdAt: new Date().toISOString(),
            lastUsed: null,
            status: 'active'
        };

        this.secrets.push(secret);
        this.saveSecrets();
        this.hideModal('createSecretModal');
        this.showGeneratedSecret(secret);
    }

    showGeneratedSecret(secret) {
        document.getElementById('generatedSecretId').textContent = secret.id;
        
        // Mostra AppIDs permitidos
        const appsContainer = document.getElementById('viewSecretApps');
        const apps = JSON.parse(localStorage.getItem('lunarauth_apps') || '[]');
        
        appsContainer.innerHTML = '';
        secret.appIds.forEach(appId => {
            const app = apps.find(a => a.id === appId);
            if (app) {
                const div = document.createElement('div');
                div.className = 'badge';
                div.textContent = app.name;
                appsContainer.appendChild(div);
            }
        });

        this.showModal('viewSecretModal');
    }

    copySecretToClipboard() {
        const secretText = document.getElementById('generatedSecretId').textContent;
        navigator.clipboard.writeText(secretText).then(() => {
            this.showToast('Sucesso', 'Secret ID copiado para a área de transferência');
        }).catch(err => {
            this.showToast('Erro', 'Não foi possível copiar o Secret ID');
        });
    }

    loadSecrets() {
        const tbody = document.getElementById('secretsTbody');
        
        if (this.secrets.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px;">
                        Nenhum Secret ID criado ainda
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = '';
        
        this.secrets.forEach(secret => {
            const tr = document.createElement('tr');
            
            // Formata a data
            const createdDate = new Date(secret.createdAt).toLocaleDateString('pt-BR');
            const lastUsed = secret.lastUsed ? new Date(secret.lastUsed).toLocaleDateString('pt-BR') : 'Nunca';
            
            tr.innerHTML = `
                <td><code style="font-size: 12px;">${secret.id}</code></td>
                <td>${secret.name}</td>
                <td>${createdDate}</td>
                <td>${lastUsed}</td>
                <td>
                    <span class="badge ${secret.status === 'active' ? 'green' : 'gray'}">
                        ${secret.status === 'active' ? 'Ativo' : 'Inativo'}
                    </span>
                </td>
                <td>
                    <button class="btn btn-ghost btn-small" onclick="secretManager.toggleSecret('${secret.id}')">
                        ${secret.status === 'active' ? 'Desativar' : 'Ativar'}
                    </button>
                    <button class="btn btn-danger btn-small" onclick="secretManager.deleteSecret('${secret.id}')">
                        Apagar
                    </button>
                </td>
            `;
            
            tbody.appendChild(tr);
        });
    }

    toggleSecret(secretId) {
        const secret = this.secrets.find(s => s.id === secretId);
        if (secret) {
            secret.status = secret.status === 'active' ? 'inactive' : 'active';
            this.saveSecrets();
            this.loadSecrets();
            this.showToast('Sucesso', `Secret ID ${secret.status === 'active' ? 'ativado' : 'desativado'}`);
        }
    }

    deleteSecret(secretId) {
        if (confirm('Tem certeza que deseja apagar este Secret ID? Esta ação não pode ser desfeita.')) {
            this.secrets = this.secrets.filter(s => s.id !== secretId);
            this.saveSecrets();
            this.loadSecrets();
            this.showToast('Sucesso', 'Secret ID apagado');
        }
    }

    saveSecrets() {
        localStorage.setItem('lunarauth_secrets', JSON.stringify(this.secrets));
    }

    // Utilitários
    showModal(id) {
        document.getElementById(id).style.display = 'flex';
    }

    hideModal(id) {
        document.getElementById(id).style.display = 'none';
    }

    showToast(title, message) {
        const toast = document.getElementById('toast');
        const toastTitle = document.getElementById('toastTitle');
        const toastDesc = document.getElementById('toastDesc');
        
        toastTitle.textContent = title;
        toastDesc.textContent = message;
        toast.classList.add('show');
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    // Validação de Secret ID (para uso na API)
    validateSecret(secretId, appId) {
        const secret = this.secrets.find(s => s.id === secretId && s.status === 'active');
        
        if (!secret) {
            return { valid: false, reason: 'INVALID_SECRET' };
        }

        if (!secret.appIds.includes(appId)) {
            return { valid: false, reason: 'SECRET_APP_MISMATCH' };
        }

        // Atualiza último uso
        secret.lastUsed = new Date().toISOString();
        this.saveSecrets();

        return { valid: true };
    }
}

// Inicialização
let secretManager;

document.addEventListener('DOMContentLoaded', () => {
    secretManager = new SecretManager();
});

// Funções globais para acesso externo
window.validateSecretId = function(secretId, appId) {
    return secretManager.validateSecret(secretId, appId);
};

window.secretManager = secretManager;