# GreenLoop

GreenLoop is a biomass, IoT and carbon-footprint platform for Mekong Delta and Central Highlands producers. The demo focuses on the IoT + carbon MRV flow: farmers register field polygons, request IoT installation, admins approve devices, water indicators are tracked per installed field, and biomass collection feeds into carbon-footprint estimation.

## Core Demo Flow

1. Farmer creates an account or logs in.
2. Farmer opens the farm operating area and draws one or more field polygons on a satellite map.
3. The app calculates field area in hectares and stores the polygon boundary.
4. Farmer selects field plots and sends an IoT installation request.
5. Admin reviews the request, sees the polygon, approves it, and marks the device as installed.
6. Water Check tracks salinity, pH and moisture by installed field plot.
7. Farmer books biomass pickup.
8. Carbon footprint is estimated from biomass weight, biochar yield and CO2e storage factor.

## Main Features

- Satellite field mapping with Leaflet, Leaflet.draw and Turf.js area calculation.
- Field polygon storage as lat/lng boundary points.
- IoT installation request workflow: pending, approved, installed, rejected.
- Admin queue for IoT request management.
- Water Check by installed field plot.
- Real weather context from NASA POWER Agroclimatology Daily API.
- Open-Meteo Flood API river-discharge proxy for salinity risk.
- Rule-based season decision engine v1 for ST25, melaleuca and brackish aquaculture recommendations.
- Simulated field telemetry for hackathon demo until physical sensors are connected.
- Biomass pickup booking and collection tracking.
- Carbon record, carbon passport and MRV evidence workflow.
- Role-based workspaces for farmer, HTX, partner, buyer and admin.

## Data Sources

- NASA POWER Agroclimatology Daily API:
  - Rainfall: `PRECTOTCORR`
  - Temperature: `T2M`
  - Relative humidity: `RH2M`
- Open-Meteo Flood API:
  - `river_discharge`, used as an open-data proxy for saline intrusion risk.
- Satellite map tiles:
  - Esri World Imagery
  - OpenStreetMap fallback for faster/safer demo loading

Note: NASA POWER and Open-Meteo provide real open-data context, not direct canal salinity measurement. In the hackathon demo, field salinity, pH and soil moisture are simulated per installed field until physical EC/salinity, pH and soil-moisture sensors are connected.

## ML Status

The current salinity ML artifact is kept as a research pilot, not as the operational recommendation engine. Its holdout test metrics are not yet good enough for production advice, so `/api/salinity/ml-predict` is quality-gated and returns `409 model_not_production_ready` when the model fails the threshold. The demo decision moment uses `rule_based_v1`, which is easier to explain and safer for judging.

Next ML step: add more real salinity labels from field sensors, MRC/NAWAPI or station reports, then retrain and validate again before enabling ML predictions.

## Tech Stack

- Frontend: single-page HTML/CSS/JavaScript app in `index.html`
- Backend: Node.js + Express
- Database: `sql.js` persisted to `greenloop-backend/greenloop.db.json`
- Mapping: Leaflet, Leaflet.draw, Turf.js
- Auth: JWT + bcrypt password hashing

## Run Locally

```bash
cd greenloop-backend
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Demo Accounts

The app supports two demo modes: sample-data flow for judging and clean-account flow for showing onboarding from zero.

Current local admin account:

- Phone: `0999999999`
- Password: `admin1234`

If the admin login fails after editing the DB, restart the backend process listening on port `3000`.

## Important API Groups

- `POST /api/auth/register` - register farmer/HTX/buyer/partner accounts
- `POST /api/auth/login` - login
- `GET /api/platform/field-plots` - list field plots
- `POST /api/platform/field-plots` - create a field plot with polygon boundary
- `GET /api/platform/iot/install-requests` - list IoT installation requests
- `POST /api/platform/iot/install-requests` - farmer requests IoT installation
- `PATCH /api/platform/iot/install-requests/:id` - admin/HTX updates IoT status
- `GET /api/platform/water/context` - NASA POWER weather context
- `POST /api/platform/iot/readings` - ingest IoT readings
- `POST /api/pickups` - create biomass pickup
- `GET /api/carbon/summary` - carbon summary

## Carbon Footprint Formula

For demo estimation:

```text
CO2e tonnes = biomass_kg x biochar_yield_factor x carbon_storage_factor / 1000
```

Example:

```text
500 kg rice straw x 30% biochar yield = 150 kg biochar
150 kg biochar x 2.5 kgCO2e/kg / 1000 = 0.375 tCO2e
```

This is an estimate until MRV evidence, chain-of-custody records and lab verification are attached.

## Project Structure

```text
.
├── index.html
├── greenloop-backend/
│   ├── server.js
│   ├── greenloop.db.json
│   └── src/
│       ├── db.js
│       ├── middleware/
│       └── routes/
├── DATABASE_SCHEMA.md
├── DEPLOY.md
├── Dockerfile
└── docker-compose.yml
```

## Notes For Judges

GreenLoop is narrowed around the highest-value hackathon story:

- Farmers identify real field boundaries visually.
- IoT installation is requested and approved through an admin workflow.
- Water indicators are tracked per installed field.
- Biomass collection creates operating records.
- Carbon footprint is estimated transparently and can later be verified through MRV.
