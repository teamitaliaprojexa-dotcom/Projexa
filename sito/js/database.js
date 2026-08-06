// Database Viewer
const API_URL = 'https://projexa-4mix.onrender.com/api';

function getToken() {
  return localStorage.getItem('authToken');
}

const tableSelect = document.getElementById('tableSelect');
if (tableSelect) {
  tableSelect.addEventListener('change', async (e) => {
    const tableName = e.target.value;
    if (!tableName) {
      document.getElementById('tableData').innerHTML = '<p class="loading">Select a table to view data</p>';
      return;
    }

    const tableData = document.getElementById('tableData');
    tableData.innerHTML = '<p class="loading">Loading...</p>';

    try {
      const response = await fetch(`${API_URL}/database/table/${tableName}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });

      if (response.ok) {
        const data = await response.json();
        if (!data.data || data.data.length === 0) {
          tableData.innerHTML = '<p class="loading">No data in this table</p>';
        } else {
          const columns = Object.keys(data.data[0]);
          const html = `
            <div style="overflow-x: auto;">
              <table>
                <thead>
                  <tr>
                    ${columns.map(col => `<th>${col}</th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${data.data.map(row => `
                    <tr>
                      ${columns.map(col => {
                        let value = row[col];
                        if (value === null) {
                          return '<td><em>null</em></td>';
                        }
                        if (typeof value === 'object') {
                          value = JSON.stringify(value);
                        }
                        const strValue = String(value).substring(0, 100);
                        return `<td>${strValue}</td>`;
                      }).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `;
          tableData.innerHTML = html;
        }
      } else if (response.status === 401) {
        tableData.innerHTML = '<p class="loading">Unauthorized. Please login again.</p>';
        setTimeout(() => window.location.href = 'login.html', 2000);
      } else {
        const error = await response.json();
        tableData.innerHTML = `<p class="loading">Error: ${error.error || 'Failed to load data'}</p>`;
      }
    } catch (error) {
      console.error('Error loading table:', error);
      tableData.innerHTML = '<p class="loading">Connection error. Make sure backend is running.</p>';
    }
  });
}
