const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '../models/salinity_ml_model.json');
const FEATURE_NAMES = [
  'latitude',
  'longitude',
  'month',
  'day_of_year_sin',
  'day_of_year_cos',
  'river_discharge_today',
  'river_discharge_avg_3d',
  'river_discharge_avg_7d',
  'rain_today_mm',
  'rain_3d_mm',
  'rain_7d_mm',
  'dry_days_7d',
  'province_label_avg_salinity',
  'station_label_avg_salinity'
];

function isoDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function dateRange(days = 7, endDate = new Date()) {
  const end = new Date(endDate);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { start: isoDate(start), end: isoDate(end) };
}

async function fetchOpenMeteoFloodSeries(location, startDate, endDate) {
  const url = new URL('https://flood-api.open-meteo.com/v1/flood');
  url.searchParams.set('latitude', location.latitude);
  url.searchParams.set('longitude', location.longitude);
  url.searchParams.set('daily', 'river_discharge');
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo Flood ${response.status}`);
  const payload = await response.json();
  const time = payload.daily?.time || [];
  const values = payload.daily?.river_discharge || [];
  const byDate = Object.fromEntries(
    time.map((day, index) => [day, Number.isFinite(Number(values[index])) ? Number(values[index]) : null])
  );
  return {
    byDate,
    unit: payload.daily_units?.river_discharge || 'm3/s',
    source: 'open-meteo:river_discharge'
  };
}

async function fetchNasaRainSeries(location, startDate, endDate) {
  const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
  url.searchParams.set('parameters', 'PRECTOTCORR');
  url.searchParams.set('community', 'AG');
  url.searchParams.set('longitude', location.longitude);
  url.searchParams.set('latitude', location.latitude);
  url.searchParams.set('start', startDate.replace(/-/g, ''));
  url.searchParams.set('end', endDate.replace(/-/g, ''));
  url.searchParams.set('format', 'JSON');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NASA POWER ${response.status}`);
  const payload = await response.json();
  const daily = payload.properties?.parameter?.PRECTOTCORR || {};
  const byDate = Object.fromEntries(
    Object.entries(daily).map(([key, value]) => [
      `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
      Number.isFinite(Number(value)) ? Number(value) : null
    ])
  );
  return {
    byDate,
    source: 'nasa-power:PRECTOTCORR'
  };
}

function rollingValues(series, endDate, days) {
  const values = [];
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let offset = 0; offset < days; offset += 1) {
    const key = isoDate(new Date(end.getTime() - offset * 86400000));
    const value = series[key];
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sum(values) {
  return values.length ? values.reduce((acc, value) => acc + value, 0) : null;
}

function buildFeatureMap({ location, riverByDate, rainByDate, targetDate = isoDate(new Date()), baselines = {} }) {
  const day = new Date(`${targetDate}T00:00:00Z`);
  const dayOfYear = Math.floor((day - new Date(Date.UTC(day.getUTCFullYear(), 0, 0))) / 86400000);
  const riverToday = riverByDate[targetDate];
  const rainToday = rainByDate[targetDate];
  const river3d = rollingValues(riverByDate, targetDate, 3);
  const river7d = rollingValues(riverByDate, targetDate, 7);
  const rain3d = rollingValues(rainByDate, targetDate, 3);
  const rain7d = rollingValues(rainByDate, targetDate, 7);
  if (!Number.isFinite(riverToday) || !Number.isFinite(rainToday)) {
    throw new Error('Not enough historical feature data for ML prediction');
  }
  return {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    month: day.getUTCMonth() + 1,
    day_of_year_sin: Math.sin((2 * Math.PI * dayOfYear) / 365),
    day_of_year_cos: Math.cos((2 * Math.PI * dayOfYear) / 365),
    river_discharge_today: riverToday,
    river_discharge_avg_3d: average(river3d),
    river_discharge_avg_7d: average(river7d),
    rain_today_mm: rainToday,
    rain_3d_mm: sum(rain3d),
    rain_7d_mm: sum(rain7d),
    dry_days_7d: rain7d.filter(value => value < 1).length,
    province_label_avg_salinity: Number(baselines.province_label_avg_salinity || 0),
    station_label_avg_salinity: Number(baselines.station_label_avg_salinity || baselines.province_label_avg_salinity || 0)
  };
}

function loadSalinityModel() {
  if (!fs.existsSync(MODEL_PATH)) return null;
  return JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
}

function predictWithSalinityModel(model, featureMap) {
  if (!model) throw new Error('Model artifact not found');
  let total = Number(model.intercept || 0);
  model.feature_names.forEach((name, index) => {
    const raw = Number(featureMap[name]);
    if (!Number.isFinite(raw)) throw new Error(`Missing feature ${name}`);
    const min = Number(model.mins?.[index]);
    const max = Number(model.maxs?.[index]);
    const boundedRaw = Number.isFinite(min) && Number.isFinite(max)
      ? Math.min(max, Math.max(min, raw))
      : raw;
    const mean = Number(model.means[index] || 0);
    const std = Number(model.stds[index] || 1) || 1;
    const coefficient = Number(model.coefficients[index] || 0);
    total += coefficient * ((boundedRaw - mean) / std);
  });
  const targetMin = Number(model.target_min);
  const targetMax = Number(model.target_max);
  const boundedTotal = Number.isFinite(targetMin) && Number.isFinite(targetMax)
    ? Math.min(targetMax, Math.max(targetMin, total))
    : total;
  return Number(boundedTotal.toFixed(3));
}

async function buildLatestMlFeatureContext(location, baselines = {}, asOfDate = new Date()) {
  const { start, end } = dateRange(7, asOfDate);
  const [river, rain] = await Promise.all([
    fetchOpenMeteoFloodSeries(location, start, end),
    fetchNasaRainSeries(location, start, end)
  ]);
  const featureMap = buildFeatureMap({
    location,
    riverByDate: river.byDate,
    rainByDate: rain.byDate,
    targetDate: end,
    baselines
  });
  return {
    featureMap,
    sources: [river.source, rain.source],
    target_date: end
  };
}

module.exports = {
  FEATURE_NAMES,
  MODEL_PATH,
  loadSalinityModel,
  predictWithSalinityModel,
  buildLatestMlFeatureContext
};
