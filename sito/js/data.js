// Load and display data from API
const API_URL = 'https://projexa-4mix.onrender.com/api';

// Get token from session
function getToken() {
  return localStorage.getItem('authToken');
}

// Load projects
async function loadProjects() {
  const projectsList = document.getElementById('projectsList');
  if (!projectsList) return;

  projectsList.innerHTML = '<p class="loading">Loading projects...</p>';

  try {
    const response = await fetch(`${API_URL}/data/projects`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      const projects = await response.json();
      if (projects.length === 0) {
        projectsList.innerHTML = '<p class="loading">No projects yet. Create one to get started!</p>';
      } else {
        projectsList.innerHTML = projects.map(project => `
          <div class="data-card">
            <h3>${project.name || 'Untitled'}</h3>
            <p>${project.description || 'No description'}</p>
            <div class="meta">
              <span>Status: <strong>${project.status || 'active'}</strong></span>
              <span>${new Date(project.created_at).toLocaleDateString('it-IT')}</span>
            </div>
          </div>
        `).join('');
      }
    } else {
      projectsList.innerHTML = '<p class="loading">Error loading projects</p>';
    }
  } catch (error) {
    console.error('Error loading projects:', error);
    projectsList.innerHTML = '<p class="loading">Connection error</p>';
  }
}

// Load tasks
async function loadTasks() {
  const tasksList = document.getElementById('tasksList');
  if (!tasksList) return;

  tasksList.innerHTML = '<p class="loading">Loading tasks...</p>';

  try {
    const response = await fetch(`${API_URL}/data/tasks`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      const tasks = await response.json();
      if (tasks.length === 0) {
        tasksList.innerHTML = '<p class="loading">No tasks yet</p>';
      } else {
        tasksList.innerHTML = tasks.map(task => `
          <div class="data-card">
            <h3>${task.title || 'Untitled'}</h3>
            <p>${task.description || 'No description'}</p>
            <div class="meta">
              <span>Priority: <strong>${task.priority || 'medium'}</strong></span>
              <span>Status: <strong>${task.status || 'todo'}</strong></span>
            </div>
          </div>
        `).join('');
      }
    } else {
      tasksList.innerHTML = '<p class="loading">Error loading tasks</p>';
    }
  } catch (error) {
    console.error('Error loading tasks:', error);
    tasksList.innerHTML = '<p class="loading">Connection error</p>';
  }
}

// Load risks
async function loadRisks() {
  const risksList = document.getElementById('risksList');
  if (!risksList) return;

  risksList.innerHTML = '<p class="loading">Loading risks...</p>';

  try {
    const response = await fetch(`${API_URL}/data/risks`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      const risks = await response.json();
      if (risks.length === 0) {
        risksList.innerHTML = '<p class="loading">No risks identified</p>';
      } else {
        risksList.innerHTML = risks.map(risk => `
          <div class="data-card">
            <h3>${risk.title || 'Untitled'}</h3>
            <p>${risk.description || 'No description'}</p>
            <div class="meta">
              <span>Impact: <strong>${risk.impact || 'medium'}</strong></span>
              <span>Status: <strong>${risk.status || 'open'}</strong></span>
            </div>
          </div>
        `).join('');
      }
    } else {
      risksList.innerHTML = '<p class="loading">Error loading risks</p>';
    }
  } catch (error) {
    console.error('Error loading risks:', error);
    risksList.innerHTML = '<p class="loading">Connection error</p>';
  }
}

// Initialize data loading on page load
document.addEventListener('DOMContentLoaded', () => {
  const pagePath = window.location.pathname;

  if (pagePath.includes('projects.html')) {
    loadProjects();
  } else if (pagePath.includes('tasks.html')) {
    loadTasks();
  } else if (pagePath.includes('risks.html')) {
    loadRisks();
  } else if (pagePath.includes('dashboard.html')) {
    loadProjects();
  }
});
