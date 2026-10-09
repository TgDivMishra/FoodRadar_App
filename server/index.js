'use strict';

// ---------------------------------------------------------------------------
// Environment setup — must happen before any other import reads process.env
// ---------------------------------------------------------------------------
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const SERPAPI_BASE = 'https://serpapi.com/search.json';
const REQUEST_TIMEOUT_MS = 12_000; // 12 seconds

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------
const app = express();

// Accept JSON request bodies
app.use(express.json());

// Allow requests from any origin so the Expo dev client (any local IP) can
// reach the server. Restrict this in production as appropriate.
app.use(cors());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` is a finite number within [min, max].
 */
function isValidNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

/**
 * Normalises a single SerpApi `local_results` entry into a consistent shape.
 * Returns null when a result is clearly unusable (e.g. missing name).
 */
function normalisePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null;
  if (!name) return null;

  // Stable ID: prefer the place_id field, fall back to a slug built from the
  // title + position, so the id is always a non-empty string.
  const id =
    typeof raw.place_id === 'string' && raw.place_id.trim()
      ? raw.place_id.trim()
      : `place-${Buffer.from(name).toString('base64url').slice(0, 16)}-${raw.position ?? 0}`;

  // GPS coordinates — only use them when both values are real numbers.
  const gps = raw.gps_coordinates;
  let latitude = null;
  let longitude = null;
  if (
    gps &&
    typeof gps === 'object' &&
    isValidNumber(gps.latitude, -90, 90) &&
    isValidNumber(gps.longitude, -180, 180)
  ) {
    latitude = Number(gps.latitude);
    longitude = Number(gps.longitude);
  }

  // Rating — only keep it when it is a plausible value (0–5 or 0–10 scale).
  const rawRating = raw.rating;
  const rating =
    typeof rawRating === 'number' && Number.isFinite(rawRating) && rawRating >= 0
      ? rawRating
      : null;

  // Reviews count
  const reviews = typeof raw.reviews === 'number' && Number.isFinite(raw.reviews) && raw.reviews >= 0
    ? raw.reviews
    : 0;

  // Open/closed state (e.g. "Open · Closes 11 PM")
  const openState = typeof raw.open_state === 'string' && raw.open_state.trim()
    ? raw.open_state.trim()
    : null;

  // Image: prefer thumbnail, fall back to serpapi_thumbnail.
  // Resize Google lh3 URLs to a crisp, fast card thumbnail (w600-h400).
  let imageUrl = null;
  if (typeof raw.thumbnail === 'string' && raw.thumbnail.startsWith('http')) {
    imageUrl = raw.thumbnail.replace(/=[swh0-9\-cnk]+$/, '=w600-h400-c-n');
  } else if (
    typeof raw.serpapi_thumbnail === 'string' &&
    raw.serpapi_thumbnail.startsWith('http') &&
    !raw.serpapi_thumbnail.includes('serpapi.com/images')
  ) {
    imageUrl = raw.serpapi_thumbnail;
  }

  // Address
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : null;

  // Category / type label
  const category = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : null;

  return {
    id,
    name,
    rating,
    reviews,
    openState,
    address,
    imageUrl,
    latitude,
    longitude,
    category,
  };
}

/**
 * Sends a fetch request to SerpApi with an AbortController timeout.
 * Throws on network failures, non-2xx responses, or timeout.
 */
async function fetchFromSerpApi(url) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    // Consume the body regardless of status so the socket is released
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`SerpApi responded with HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('SerpApi returned non-JSON response.');
    }

    // SerpApi returns an "error" field when something is wrong (bad key, quota, etc.)
    if (typeof json.error === 'string' && json.error.trim()) {
      throw new Error(`SerpApi error: ${json.error}`);
    }

    return json;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 * Lightweight liveness check. Never calls external services or reveals secrets.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'FoodRadar Backend',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/food-places?lat=LATITUDE&lng=LONGITUDE
 *
 * Queries SerpApi for restaurants near the supplied coordinates and returns a
 * normalised array of places.
 */
app.get('/api/food-places', async (req, res) => {
  // --- 1. Validate coordinates --------------------------------------------
  const { lat, lng } = req.query;

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required query parameters: lat and lng.',
    });
  }

  if (!isValidNumber(lat, -90, 90)) {
    return res.status(400).json({
      success: false,
      error: `Invalid latitude "${lat}". Must be a finite number between -90 and 90.`,
    });
  }

  if (!isValidNumber(lng, -180, 180)) {
    return res.status(400).json({
      success: false,
      error: `Invalid longitude "${lng}". Must be a finite number between -180 and 180.`,
    });
  }

  const latitude = Number(lat);
  const longitude = Number(lng);

  // --- 2. Check API key presence ------------------------------------------
  const apiKey = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'your_serpapi_key_here') {
    // Return a clear configuration error — do NOT attempt the request.
    return res.status(500).json({
      success: false,
      error:
        'Server configuration error: SERPAPI_KEY is not set. ' +
        'Add SERPAPI_KEY to your environment variables.',
    });
  }

  // --- 3. Build SerpApi URL ------------------------------------------------
  // ll format: @LATITUDE,LONGITUDE,ZOOMz  (Google Maps latlng syntax)
  const ll = `@${latitude},${longitude},15z`;

  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q: 'restaurants',
    ll,
    hl: 'en',           // English labels
    api_key: apiKey,
  });

  const serpApiUrl = `${SERPAPI_BASE}?${params.toString()}`;

  // --- 4. Call SerpApi -----------------------------------------------------
  let serpData;
  try {
    serpData = await fetchFromSerpApi(serpApiUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Classify common error types so the client can react appropriately.
    if (message.includes('abort') || message.includes('timed out')) {
      return res.status(504).json({
        success: false,
        error: 'Request to SerpApi timed out. Please try again.',
      });
    }

    // Never echo the raw error string back — it may contain fragments of the
    // URL (and therefore the API key). Log it server-side only.
    console.error('[food-places] SerpApi call failed:', message);

    return res.status(502).json({
      success: false,
      error:
        'Failed to fetch results from SerpApi. ' +
        'Check your API key, network connectivity, and account quota.',
    });
  }

  // --- 5. Normalise results ------------------------------------------------
  // The Google Maps search engine returns results under "local_results".
  const rawResults = Array.isArray(serpData.local_results) ? serpData.local_results : [];

  const places = rawResults
    .map(normalisePlace)
    .filter((p) => p !== null); // drop entries that failed normalisation

  // --- 6. Return normalised response --------------------------------------
  return res.json({
    success: true,
    count: places.length,
    places,
  });
});


// ---------------------------------------------------------------------------
// Image Proxy — streams Google restaurant images to mobile clients.
// React Native cannot directly load lh3.googleusercontent.com images because
// Google blocks requests that don't look like a browser. This endpoint fetches
// the image server-side (where the User-Agent can be set freely) and pipes it.
// ---------------------------------------------------------------------------
const ALLOWED_IMAGE_HOSTS = [
  'lh3.googleusercontent.com',
  'lh4.googleusercontent.com',
  'lh5.googleusercontent.com',
  'lh6.googleusercontent.com',
  'maps.googleapis.com',
  'streetviewpixels-pa.googleapis.com',
];

app.get('/api/image-proxy', async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url query param' });
  }

  // Only proxy images from approved Google domains for security
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ error: 'Domain not allowed' });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 10_000);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Pretend to be a desktop Chrome browser so Google serves the image
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.google.com/',
      },
    });

    clearTimeout(timeoutHandle);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Upstream image fetch failed' });
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';

    // Cache images for 1 hour on the mobile client
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream the image body directly to the mobile client
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        if (!res.writableEnded) {
          res.write(Buffer.from(value));
        }
      }
    };
    await pump();
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to fetch image from upstream' });
    }
  }
});

// ---------------------------------------------------------------------------
// Global error handler — catches any unhandled Express errors.
// Never returns stack traces or secrets to clients.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[global-error]', err?.message ?? err);
  res.status(500).json({
    success: false,
    error: 'An unexpected server error occurred.',
  });
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
// Bind to 0.0.0.0 so the server is reachable from a physical Android device
// on the same local network (not just from localhost).
app.listen(PORT, '0.0.0.0', () => {
  const activeKey = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
  const keyConfigured =
    activeKey &&
    activeKey !== 'your_serpapi_key_here' &&
    activeKey.trim() !== '';

  console.log(`FoodRadar backend running on http://0.0.0.0:${PORT}`);
  console.log(`  Health check : http://localhost:${PORT}/health`);
  console.log(`  Food search  : http://localhost:${PORT}/api/food-places?lat=28.6139&lng=77.2090`);
  console.log(`  SERPAPI_KEY  : ${keyConfigured ? '✓ configured' : '✗ NOT SET — add key to server/.env'}`);
});
