# Projexa Setup Guide

## Backend Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Create `.env` File

Copy from `.env.example` and update with your values:

```
DATABASE_URL=postgresql://user:password@host:5432/projexa
JWT_SECRET=your-super-secret-key-change-in-production
PORT=3001
NODE_ENV=production
```

### 3. Setup Database

Create PostgreSQL database on [Neon](https://neon.tech):

```bash
psql -U user -d projexa -f ../database-schema.sql
```

### 4. Seed Database

```bash
npm run seed
```

This creates:
- 2 test tenants
- 2 test users (admin@projexa.com, user@projexa.com)
- Password: `temp123`

### 5. Start Backend

```bash
npm start
# or for development:
npm run dev
```

Server runs on `http://localhost:3001`

## Frontend Setup

All files in `sito/` folder:
- `login.html` - Login page
- `dashboard.html` - Main dashboard
- `projects.html` - Projects page
- `tasks.html` - Tasks page
- `risks.html` - Risks page
- `database.html` - Database viewer
- `css/style.css` - All styling
- `js/auth.js` - Authentication logic
- `js/data.js` - Data loading
- `js/database.js` - Database viewer

Update API_URL in JavaScript files to match your backend.

## Deployment

### Backend (Render)

1. Connect GitHub repo to Render
2. Set environment variables
3. Deploy

### Frontend (GitHub Pages)

Files in `sito/` auto-deploy to GitHub Pages at:
```
https://teamitaliaprojexa-dotcom.github.io/Projexa/sito/
```

## Test Credentials

- **Email:** admin@projexa.com
- **Password:** temp123
- **Tenants:** Projexa Internal, Test Company

## API Endpoints

- `POST /api/auth/login` - Login
- `GET /api/auth/verify` - Verify token
- `GET /api/projects` - List projects
- `GET /api/tasks` - List tasks
- `GET /api/risks` - List risks
- `GET /api/:table` - Generic table viewer

## Multi-Tenant Architecture

Users can belong to multiple tenants. Login shows tenant selection if user has 2+ tenants.

JWT token includes `tenant_id` for data filtering.
