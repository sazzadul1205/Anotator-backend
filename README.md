# Annotator Backend

Comment sentiment & language annotation API.

## Requirements

- Node.js 18+
- MongoDB Atlas account (or local MongoDB 6+)

## Setup

1. Clone repo and install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in real values:
   ```bash
   cp .env.example .env
   ```

3. Create MongoDB indexes (once per database):
   ```bash
   npm run init-indexes
   ```

4. Start the server:
   ```bash
   npm run dev    # development, auto-reload
   npm start      # production
   ```

5. Create the first admin at:
   ```
   POST /api/auth/bootstrap
   ```

## Environment Variables

| Variable | Purpose | Example |
|---|---|---|
| `PORT` | HTTP port | `5000` |
| `NODE_ENV` | `development` or `production` | `development` |
| `MONGO_URI` | MongoDB connection string | `mongodb+srv://...` |
| `DB_NAME` | Database name | `annotator_db` |
| `JWT_SECRET` | Signing key for JWT | 64+ random hex chars |
| `FRONTEND_URL` | Frontend origin for CORS (prod only) | `http://localhost:3000` |

## API Documentation

See `docs/api.md` (or the API reference file shared in the project).

## Scripts

| Command | Does |
|---|---|
| `npm start` | Run production server |
| `npm run dev` | Run dev server with nodemon |
| `npm run init-indexes` | Create MongoDB indexes |

## License

Private / internal.