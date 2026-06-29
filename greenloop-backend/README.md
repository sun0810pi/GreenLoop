# GreenLoop Backend API

Node.js + Express + sql.js. The backend stores demo data in a local JSON-backed SQLite export and serves the static web app from the repository root.

## Start

```bash
npm install
npm start
```

API and app: `http://localhost:3000`

## Demo Accounts

| Login | Password | Role |
| --- | --- | --- |
| `0901234567` | `demo1234` | Farmer |
| `0912345678` | `demo1234` | HTX |
| `buyer@greenloop.vn` | `demo1234` | Carbon buyer |
| `partner@greenloop.vn` | `demo1234` | Processor / logistics partner |
| `admin@greenloop.vn` | `demo1234` | Administrator |

## Main API Areas

- `POST /api/auth/login`, `GET /api/auth/me`
- `GET/POST /api/pickups`
- `PATCH /api/pickups/:id/status`
- `GET /api/platform/biomass/catalog`
- `GET/POST /api/platform/batches`
- `GET /api/platform/iot/live`
- `POST /api/platform/iot/readings`
- `GET/POST /api/platform/environment/readings`
- `GET/POST /api/platform/mrv/soil-samples`
- `GET /api/carbon`, `GET /api/carbon/summary`
- `GET /api/carbon/:id/evidence-package`
- `POST /api/carbon/:id/verify`
- `POST /api/carbon/:id/issue`
- `GET/POST /api/platform/credits/offers`
- `POST /api/platform/credits/offers/:id/interests`
- `GET /api/points`, `POST /api/points/redeem`
- `GET /api/platform/compliance`
- `GET/POST /api/circular/residues`
- `GET/POST /api/circular/conversion-pathways`
- `GET/POST /api/circular/logistics/assignments`
- `GET/POST /api/circular/field-applications`
- `GET/POST /api/circular/certificates`
- `GET /api/circular/trace/products/:id`

## Biomass Coverage

Supported biomass includes rice straw, rice husk, pond sludge, shrimp shells, shrimp heads, fish skin/bones, melaleuca leaves, melaleuca branches, melaleuca thinning wood, melaleuca residue, coconut husk, coffee husk, cajeput residue and mixed biomass.

Aliases such as `shrimp_sludge`, `tram`, `melaleuca`, `coconut` and `coffee` are normalized by the backend.

## dMRV Evidence Package

`GET /api/carbon/:id/evidence-package` returns:

- Carbon record and farmer/HTX source fields.
- Linked pickup mass, location and biomass type.
- Passport/package hashes.
- MRV trail logs.
- Verification cases.
- Recent soil samples.
- Marketplace offer, when available.
- Audit checklist and readiness score.
