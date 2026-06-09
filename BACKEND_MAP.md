# GreenLoop backend map

Frontend currently needs backend support in these places:

1. Authentication and sessions
   - Login, registration, token restore, logout.
   - Endpoints: `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/me`, `PUT /api/auth/me`.

2. Farmer profile and account settings
   - Name, phone, role, province, farm size, and preferences.
   - Endpoint: `PUT /api/auth/me`.

3. Dashboard summary
   - Current-month earnings, pending payment, waiting pickup weight, yearly earnings breakdown, monthly collection chart, and field/pond metrics.
   - Endpoint: `GET /api/dashboard?season=rice|shrimp`.

4. Biomass pickup booking and tracking
   - Create pickup bookings, list recent bookings, view detail, cancel booking, update status by HTX/admin.
   - Endpoints: `POST /api/pickups`, `GET /api/pickups`, `GET /api/pickups/:id`, `DELETE /api/pickups/:id`, `PATCH /api/pickups/:id/status`.
   - Backend now synchronizes overdue `pending`, `confirmed`, and `collected` pickups into `processed` and creates carbon records when needed.

5. Carbon passport and MRV records
   - Timeline, summary totals, batch details, credit status, MRV audit trail.
   - Endpoints: `GET /api/carbon`, `GET /api/carbon/summary`, `GET /api/carbon/:id`.

6. Salinity and season advice
   - Station readings, alert thresholds, 7-day trend, dynamic forecast crossing date, and recommendation for rice/transition/shrimp season.
   - Endpoints: `GET /api/salinity`, `GET /api/salinity/season-advice`.

7. Notifications
   - Notification bell list, unread badge, mark one/all as read.
   - Endpoints: `GET /api/notifications`, `PATCH /api/notifications/:id/read`, `PATCH /api/notifications/read-all`.

8. Reward points
   - Points balance and voucher redemption.
   - Endpoints: `GET /api/points`, `POST /api/points/redeem`.

9. Static app hosting
   - Serve `index.html` and static assets from the same origin as the API so the frontend can use `window.location.origin`.

This repository now includes a local Node.js backend in `server.js`. It reads and writes a SQLite database at `data/greenloop.sqlite`; schema and demo seed data are created by `scripts/init-db.js`.
