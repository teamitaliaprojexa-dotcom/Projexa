// API Configuration
const API_URL = window.location.origin + '/api';

// State
let currentUser = null;
let currentTenant = null;
let authToken = null;

// ===== LOGIN PAGE =====
if (document.getElementById('loginForm')) {
  const loginForm = document.getElementById('loginForm');
  const errorMessage = document.getElementById('errorMessage');
  const tenantModal = document.getElementById('tenantModal');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
      errorMessage.textContent = '';
      errorMessage.classList.remove('show');

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
        localStorage.setItem('authToken', authToken);
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        localStorage.setItem('currentTenant', JSON.stringify(currentTenant));
        window.location.href = 'dashboard.html';
      } else {
        const data = await response.json();
        errorMessage.textContent = data.error || 'Login failed';
        errorMessage.classList.add('show');
      }
    } catch (error) {
      console.error('Login error:', error);
      errorMessage.textContent = 'Connection error. Please try again.';
      errorMessage.classList.add('show');
    }
  });

  function showTenantModal(tenants, email, password) {
    const tenantList = document.getElementById('tenantList');
    tenantList.innerHTML = '';

    tenants.forEach(tenant => {
      const tenantItem = document.createElement('div');
      tenantItem.className = 'tenant-item';
      tenantItem.innerHTML = `
        <h3>${tenant.name}</h3>
        <p>Click to select</p>
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
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            localStorage.setItem('currentTenant', JSON.stringify(currentTenant));
            window.location.href = 'dashboard.html';
          }
        } catch (error) {
          console.error('Tenant selection error:', error);
        }
      });

      tenantList.appendChild(tenantItem);
    });

    tenantModal.classList.remove('hidden');
  }
}

// ===== DASHBOARD PAGE =====
if (document.getElementById('logoutBtn')) {
  // Load session data
  authToken = localStorage.getItem('authToken');
  currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
  currentTenant = JSON.parse(localStorage.getItem('currentTenant') || '{}');

  if (!authToken) {
    window.location.href = 'index.html';
  }

  // Update header info
  document.getElementById('userInfo').textContent = `${currentUser.name || currentUser.email}`;
  document.getElementById('tenantInfo').textContent = currentTenant.name;

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentTenant');
    window.location.href = 'index.html';
  });

  // Navigation
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.section');

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();

      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');

      sections.forEach(section => section.classList.add('hidden'));

      const sectionName = item.textContent.toLowerCase().replace(' ', '-');
      const sectionId = sectionName + 'Section';
      const section = document.getElementById(sectionId);

      if (section) {
        section.classList.remove('hidden');
        document.getElementById('pageTitle').textContent = item.textContent;

        // Load data for section
        if (sectionName === 'projects') {
          loadProjects();
        } else if (sectionName === 'tasks') {
          loadTasks();
        } else if (sectionName === 'risks') {
          loadRisks();
        }
      }
    });
  });

  // Load initial data
  loadProjects();

  async function loadProjects() {
    const projectsList = document.getElementById('projectsList');
    projectsList.innerHTML = '<p class="loading">Loading projects...</p>';

    try {
      const response = await fetch(`${API_URL}/projects`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });

      if (response.ok) {
        const projects = await response.json();
        if (projects.length === 0) {
          projectsList.innerHTML = '<p class="loading">No projects yet</p>';
        } else {
          projectsList.innerHTML = projects.map(project => `
            <div class="data-card">
              <h3>${project.name}</h3>
              <p>${project.description || 'No description'}</p>
              <div class="meta">
                <span>Status: ${project.status}</span>
                <span>${new Date(project.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Error loading projects:', error);
      projectsList.innerHTML = '<p class="loading">Error loading projects</p>';
    }
  }

  async function loadTasks() {
    const tasksList = document.getElementById('tasksList');
    tasksList.innerHTML = '<p class="loading">Loading tasks...</p>';

    try {
      const response = await fetch(`${API_URL}/tasks`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });

      if (response.ok) {
        const tasks = await response.json();
        if (tasks.length === 0) {
          tasksList.innerHTML = '<p class="loading">No tasks yet</p>';
        } else {
          tasksList.innerHTML = tasks.map(task => `
            <div class="data-card">
              <h3>${task.title}</h3>
              <p>${task.description || 'No description'}</p>
              <div class="meta">
                <span>Priority: ${task.priority}</span>
                <span>Status: ${task.status}</span>
              </div>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Error loading tasks:', error);
      tasksList.innerHTML = '<p class="loading">Error loading tasks</p>';
    }
  }

  async function loadRisks() {
    const risksList = document.getElementById('risksList');
    risksList.innerHTML = '<p class="loading">Loading risks...</p>';

    try {
      const response = await fetch(`${API_URL}/risks`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });

      if (response.ok) {
        const risks = await response.json();
        if (risks.length === 0) {
          risksList.innerHTML = '<p class="loading">No risks yet</p>';
        } else {
          risksList.innerHTML = risks.map(risk => `
            <div class="data-card">
              <h3>${risk.title}</h3>
              <p>${risk.description || 'No description'}</p>
              <div class="meta">
                <span>Impact: ${risk.impact}</span>
                <span>Status: ${risk.status}</span>
              </div>
            </div>
          `).join('');
        }
      }
    } catch (error) {
      console.error('Error loading risks:', error);
      risksList.innerHTML = '<p class="loading">Error loading risks</p>';
    }
  }

  // Database viewer
  const tableSelect = document.getElementById('tableSelect');
  if (tableSelect) {
    tableSelect.addEventListener('change', async (e) => {
      const tableName = e.target.value;
      if (!tableName) return;

      const tableData = document.getElementById('tableData');
      tableData.innerHTML = '<p class="loading">Loading...</p>';

      try {
        const response = await fetch(`${API_URL}/database/table/${tableName}`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (response.ok) {
          const data = await response.json();
          if (data.data.length === 0) {
            tableData.innerHTML = '<p class="loading">No data</p>';
          } else {
            const columns = Object.keys(data.data[0]);
            const html = `
              <table>
                <thead>
                  <tr>${columns.map(col => `<th>${col}</th>`).join('')}</tr>
                </thead>
                <tbody>
                  ${data.data.map(row => `
                    <tr>
                      ${columns.map(col => `<td>${JSON.stringify(row[col]).substring(0, 50)}</td>`).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `;
            tableData.innerHTML = html;
          }
        }
      } catch (error) {
        console.error('Error loading table:', error);
        tableData.innerHTML = '<p class="loading">Error loading data</p>';
      }
    });
  }
}
