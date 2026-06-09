# GreenLoop

Hackathon frontend + local backend.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

Demo accounts:

- `farmer@greenloop.vn` / `password123`
- `htx@greenloop.vn` / `password123`
- `admin@greenloop.vn` / `password123`

Backend data is stored in SQLite at runtime in `data/greenloop.sqlite`.

Useful commands:

```bash
npm run db:init   # create tables and seed demo data if the DB is empty
npm start         # initialize DB if needed, then run the API + frontend server
```
