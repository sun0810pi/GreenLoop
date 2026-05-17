# 🌿 GreenLoop Backend API

Node.js + Express + SQLite (sql.js) — zero external database required.

## Quick Start

```bash
npm install
node server.js
# API running at http://localhost:3000
```

## Demo Accounts

| Phone | Password | Role |
|-------|----------|------|
| 0901234567 | demo1234 | farmer (Nguyen Van Thanh, Ca Mau) |
| 0912345678 | demo1234 | htx (Le Thi Mai, Ca Mau) |

To create an **admin**: register normally, then change role via DB or use `PATCH /api/admin/users/:id/role`.

---

## API Reference

### Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | ❌ | Register new user |
| POST | `/api/auth/login` | ❌ | Login → JWT token |
| GET | `/api/auth/me` | ✅ | Get own profile |
| PUT | `/api/auth/me` | ✅ | Update profile |
| POST | `/api/auth/change-password` | ✅ | Change password |

**Register body:**
```json
{
  "name": "Tran Van An",
  "phone": "0909123456",
  "password": "mypassword",
  "role": "farmer",
  "province": "ca-mau",
  "farm_ha": 2.5,
  "htx_code": "HTX-CM-01"
}
```
Roles: `farmer` | `htx` | `buyer` | `admin`

**Login response:**
```json
{
  "token": "eyJ...",
  "user": { "id": "...", "name": "...", "role": "farmer", ... }
}
```

All protected routes: `Authorization: Bearer <token>`

---

### Pickups (Book a Collection)

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| POST | `/api/pickups` | ✅ | all | Book a new pickup |
| GET | `/api/pickups` | ✅ | all | List pickups (own for farmer, all for htx/admin) |
| GET | `/api/pickups/:id` | ✅ | all | Pickup detail |
| PATCH | `/api/pickups/:id/status` | ✅ | htx, admin | Update status + trigger carbon record |
| DELETE | `/api/pickups/:id` | ✅ | farmer | Cancel pending pickup |

**Book pickup body:**
```json
{
  "biomass_type": "rice_straw",
  "quantity_kg": 1200,
  "location": "Xã Khánh Bình, huyện Trần Văn Thời",
  "province": "ca-mau",
  "scheduled_at": "2025-06-15T07:00:00Z",
  "notes": "Gate at side road"
}
```
`biomass_type`: `rice_straw` | `pond_sludge` | `mixed` (min 500 kg)

**Status flow:** `pending → confirmed → collected → processed → (carbon record auto-created)`

**Update status (HTX):**
```json
{
  "status": "processed",
  "biochar_yield_kg": 420,
  "notes": "Processed at HUSK facility"
}
```

---

### Salinity / Water Intelligence

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/salinity` | ✅ | Latest readings per station |
| GET | `/api/salinity?province=ca-mau&alert=true` | ✅ | Filter by province / alerts only |
| GET | `/api/salinity/provinces` | ✅ | Summary by province |
| GET | `/api/salinity/history/:station?days=30` | ✅ | Time-series for one station |
| GET | `/api/salinity/season-advice?province=ca-mau` | ✅ | Rule-based season recommendation |
| POST | `/api/salinity` | ✅ | Ingest new reading (htx/admin) |

**Alert threshold:** 5.0 g/L — triggers season-switch notification to all farmers.

**Season advice response:**
```json
{
  "province": "ca-mau",
  "avg_gpl": 2.1,
  "recommended_season": "rice",
  "advice": "Salinity 2.1 g/L — safe for rice. Wet season conditions optimal."
}
```

---

### Carbon Passport & Credits

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/api/carbon` | ✅ | all | List carbon records |
| GET | `/api/carbon/summary` | ✅ | all | My totals: tCO₂e, SCU, revenue, points |
| GET | `/api/carbon/:id` | ✅ | all | Record detail + MRV trail |
| POST | `/api/carbon` | ✅ | htx, admin | Create record manually |
| POST | `/api/carbon/:id/verify` | ✅ | htx, admin | Verify + add MRV log |
| POST | `/api/carbon/:id/issue` | ✅ | admin | Issue SCU on AICE exchange |

**Carbon factor:** 1 kg biochar = 3.12 kg CO₂e (EBC/VM0044)
**SCU price oracle:** $20 USD / tonne

**Status flow:** `pending → verified → issued → traded`

**Carbon record:**
```json
{
  "id": "...",
  "biochar_kg": 420,
  "co2e_tonnes": 1.3104,
  "methodology": "Verra VM0044",
  "status": "verified",
  "passport_hash": "sha256:a3f2...",
  "scu_units": 1.31,
  "revenue_usd": 26.2,
  "season": "wet_rice",
  "mrv_trail": [
    { "tier": 1, "action": "Field mass verified by HTX", ... },
    { "tier": 2, "action": "Lab analysis verified (EBC)", ... }
  ]
}
```

---

### Notifications

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/notifications` | ✅ | My notifications + unread count |
| GET | `/api/notifications?unread=true` | ✅ | Unread only |
| PATCH | `/api/notifications/read-all` | ✅ | Mark all read |
| PATCH | `/api/notifications/:id/read` | ✅ | Mark one read |

---

### Points & Rewards

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/points` | ✅ | Balance + history |
| POST | `/api/points/redeem` | ✅ | Redeem for fertiliser voucher |

**Points:** 1 pt per kg of biomass delivered. Min 100 pts to redeem.

**Redeem body:**
```json
{
  "amount": 500,
  "item": "fertiliser_50kg"
}
```

---

### Admin

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| GET | `/api/admin/stats` | ✅ | htx, admin | Platform-wide dashboard |
| GET | `/api/admin/users` | ✅ | admin | List all users |
| PATCH | `/api/admin/users/:id/role` | ✅ | admin | Change user role |

---

## Project Structure

```
greenloop-backend/
├── server.js              # Entry point
├── .env                   # PORT, JWT_SECRET
├── src/
│   ├── db.js              # sql.js SQLite + schema + seed data
│   ├── middleware/
│   │   └── auth.js        # JWT middleware + requireRole()
│   └── routes/
│       ├── auth.js        # Register, login, profile
│       ├── pickups.js     # Biomass collection booking
│       ├── salinity.js    # Water intelligence + season advice
│       ├── carbon.js      # Carbon passport, MRV, SCU
│       ├── misc.js        # Notifications + Points
│       └── admin.js       # Admin dashboard + user management
```

## Provinces Supported
`ca-mau` | `bac-lieu` | `soc-trang` | `kien-giang` | `an-giang` | `dong-thap` | `ben-tre` | `other`
