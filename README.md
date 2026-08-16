# Projexa

**SaaS Project Management Platform** - Multi-tenant application for project managers.

## Stack

- **Backend:** Node.js + Express
- **Frontend:** HTML + CSS + JavaScript (in `sito/` folder)
- **Database:** PostgreSQL (Neon)
- **Auth:** JWT + bcrypt
- **Hosting:** Render (backend) + GitHub Pages (frontend)

## Quick Start

### 1. Setup Backend

```bash
cd backend
npm install
```

Create `.env` file:
```
DATABASE_URL=postgresql://user:password@host:5432/projexa
JWT_SECRET=your-secret-key
PORT=3001
NODE_ENV=production
```

### 2. Setup Database

Run the schema:
```bash
psql -U user -d projexa -f ../database-schema.sql
```

Seed test data (create a `backend/scripts/seed.js` file first).

### 3. Start Backend

```bash
npm start
# or for development:
npm run dev
```

### 4. Frontend

All frontend files are in `sito/` folder:
- `index.html` - Login page
- `dashboard.html` - Main app
- `css/style.css` - Styling
- `js/app.js` - Client logic

Update API URL in frontend files to match your backend:
```javascript
const API_URL = 'https://your-backend.onrender.com/api';
```

## Deployment

### Backend (Render)
1. Connect GitHub repo to Render
2. Set environment variables in Render dashboard
3. Deploy

### Frontend (GitHub Pages)
1. Files in `sito/` auto-deploy to GitHub Pages
2. Access at: `https://teamitaliaprojexa-dotcom.github.io/Projexa/sito/`

## Multi-Tenant Architecture

- Users can belong to multiple tenants
- Login returns list of tenants if user has 2+
- JWT token includes `tenant_id` for filtering data

## API Endpoints

- `POST /api/auth/login` - User login
- `GET /api/auth/verify` - Verify JWT token
- `GET /api/projects` - List projects
- `GET /api/tasks` - List tasks
- `GET /api/risks` - List risks
- `GET /api/:table` - Generic table viewer

## Notes

- All HTML files must be in `sito/` folder
- Database schema in `database-schema.sql`
- Backend routes in `backend/routes/`
- Configuration in `.env` (backend only)
