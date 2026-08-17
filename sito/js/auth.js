// API Configuration
// URL auto-rilevato dall'origine corrente: in locale (servito dal backend Node
// su http://localhost:3001) punta al backend locale; su Render punta a Render.
// Stesso codice in entrambi gli ambienti, nessuna modifica da rifare prima del push.
const API_URL = window.location.origin + '/api';

// State
let currentUser = null;
let currentTenant = null;
let authToken = null;

// Load session from localStorage
function loadSession() {
  authToken = localStorage.getItem('authToken');
  currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
  currentTenant = JSON.parse(localStorage.getItem('currentTenant') || '{}');
}

// Save session to localStorage
function saveSession() {
  localStorage.setItem('authToken', authToken);
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
  localStorage.setItem('currentTenant', JSON.stringify(currentTenant));
}

// Clear session
function clearSession() {
  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');
  localStorage.removeItem('currentTenant');
}

// Check if user is logged in
function isLoggedIn() {
  loadSession();
  return !!authToken;
}

// Redirect to login if not authenticated
function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = 'login.html';
  }
}

// Update header with user info
function updateHeader() {
  const userInfo = document.getElementById('userInfo');
  const tenantInfo = document.getElementById('tenantInfo');

  if (userInfo) {
    userInfo.textContent = currentUser.name || currentUser.email || 'User';
  }

  if (tenantInfo) {
    tenantInfo.textContent = currentTenant.name || 'Tenant';
  }
}

// Setup logout button
function setupLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      clearSession();
      window.location.href = 'login.html';
    });
  }
}

// Login form handler
if (document.getElementById('loginForm')) {
  const loginForm = document.getElementById('loginForm');
  const errorMessage = document.getElementById('errorMessage');
  const successMessage = document.getElementById('successMessage');
  const tenantModal = document.getElementById('tenantModal');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // Clear messages
    if (errorMessage) {
      errorMessage.textContent = '';
      errorMessage.classList.remove('show');
    }

    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (response.status === 300) {
        // Multiple tenants - show modal
        const data = await response.json();
        showTenantModal(data.tenants, email, password);
      } else if (response.ok) {
        // Login successful
        const data = await response.json();
        authToken = data.token;
        currentUser = data.user;
        currentTenant = data.tenant;
        saveSession();

        if (successMessage) {
          successMessage.textContent = 'Login successful! Redirecting...';
          successMessage.classList.add('show');
        }

        setTimeout(() => {
          window.location.href = 'dashboard.html';
        }, 500);
      } else {
        const data = await response.json();
        if (errorMessage) {
          errorMessage.textContent = data.error || 'Login failed';
          errorMessage.classList.add('show');
        }
      }
    } catch (error) {
      console.error('Login error:', error);
      if (errorMessage) {
        errorMessage.textContent = 'Connection error. Please check your backend.';
        errorMessage.classList.add('show');
      }
    }
  });

  function showTenantModal(tenants, email, password) {
    const tenantList = document.getElementById('tenantList');
    if (!tenantList) return;

    tenantList.innerHTML = '';

    tenants.forEach(tenant => {
      const tenantItem = document.createElement('div');
      tenantItem.className = 'tenant-item';
      tenantItem.innerHTML = `
        <h3>${tenant.name}</h3>
        <p>Click to select this workspace</p>
      `;

      tenantItem.addEventListener('click', async () => {
        tenantModal.classList.add('hidden');
        try {
          const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, tenant_code: tenant.id })
          });

          if (response.ok) {
            const data = await response.json();
            authToken = data.token;
            currentUser = data.user;
            currentTenant = data.tenant;
            saveSession();
            window.location.href = 'dashboard.html';
          } else {
            if (errorMessage) {
              errorMessage.textContent = 'Failed to select workspace';
              errorMessage.classList.add('show');
            }
            tenantModal.classList.remove('hidden');
          }
        } catch (error) {
          console.error('Tenant selection error:', error);
          if (errorMessage) {
            errorMessage.textContent = 'Connection error';
            errorMessage.classList.add('show');
          }
          tenantModal.classList.remove('hidden');
        }
      });

      tenantList.appendChild(tenantItem);
    });

    tenantModal.classList.remove('hidden');
  }
}

// Dashboard pages - setup auth and header
if (document.getElementById('logoutBtn')) {
  loadSession();

  if (!authToken) {
    window.location.href = 'login.html';
  }

  updateHeader();
  setupLogout();
}
