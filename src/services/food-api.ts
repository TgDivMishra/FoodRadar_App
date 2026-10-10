import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { FoodPlace } from '@/types/food';

const RENDER_BACKEND_URL = 'https://foodradar-app-8tbr.onrender.com';

/**
 * Returns the appropriate backend base URL:
 * - Live Cloud Backend on Render: https://foodradar-app-8tbr.onrender.com
 * - Can be overridden locally via process.env.EXPO_PUBLIC_API_URL if needed
 */
export function getBackendBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/+$/, '');
  }

  // Live Cloud backend on Render (reachable on any phone, Wi-Fi, or Mobile Data worldwide)
  return RENDER_BACKEND_URL;
}

/**
 * Returns a high-quality food image for a given cuisine when no photo is provided by Google.
 */
export function getFallbackImageForCuisine(category?: string | null): string {
  const c = (category || '').toLowerCase();
  if (c.includes('pizza') || c.includes('italian')) {
    return 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80';
  }
  if (c.includes('cafe') || c.includes('coffee') || c.includes('tea')) {
    return 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=600&auto=format&fit=crop&q=80';
  }
  if (c.includes('bakery') || c.includes('cake') || c.includes('dessert') || c.includes('sweet')) {
    return 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600&auto=format&fit=crop&q=80';
  }
  if (c.includes('burger') || c.includes('fast food')) {
    return 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop&q=80';
  }
  if (c.includes('chinese') || c.includes('noodle') || c.includes('asian')) {
    return 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=600&auto=format&fit=crop&q=80';
  }
  if (c.includes('biryani') || c.includes('indian') || c.includes('dhaba') || c.includes('curry')) {
    return 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600&auto=format&fit=crop&q=80';
  }
  return 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&auto=format&fit=crop&q=80';
}

/**
 * Returns a proxy URL that routes the Google image through our backend if needed.
 */
export function proxyImageUrl(originalUrl: string | null | undefined): string {
  if (!originalUrl) return '';
  const base = getBackendBaseUrl();
  return `${base}/api/image-proxy?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * Calculates the Haversine distance between two coordinates in kilometers.
 */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export interface FetchFoodPlacesResult {
  success: boolean;
  places: FoodPlace[];
  error?: string;
}

interface RawBackendPlace {
  id?: string;
  name?: string;
  rating?: number | null;
  reviews?: number | null;
  openState?: string | null;
  address?: string | null;
  imageUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  category?: string | null;
  priceRange?: string | null;
}

/**
 * Calls FoodRadar backend to get real SerpApi food places near user's GPS coordinates.
 */
export async function fetchNearbyFoodPlaces(
  userLat: number,
  userLng: number
): Promise<FetchFoodPlacesResult> {
  const baseUrl = getBackendBaseUrl();
  const url = `${baseUrl}/api/food-places?lat=${encodeURIComponent(userLat)}&lng=${encodeURIComponent(userLng)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMsg = `Server error (${response.status})`;
      try {
        const errorJson = await response.json();
        if (errorJson.error) {
          errorMsg = errorJson.error;
        }
      } catch {
        // ignore non-JSON errors
      }
      return { success: false, places: [], error: errorMsg };
    }

    const data = await response.json();

    if (!data.success || !Array.isArray(data.places)) {
      return {
        success: false,
        places: [],
        error: data.error || 'Invalid response from food search server',
      };
    }

    // Map backend places to FoodPlace interface and calculate real distances
    const mappedPlaces: FoodPlace[] = (data.places as RawBackendPlace[]).map((raw, idx) => {
      let distanceKm = 0.5;
      if (
        typeof raw.latitude === 'number' &&
        typeof raw.longitude === 'number' &&
        !isNaN(raw.latitude) &&
        !isNaN(raw.longitude)
      ) {
        distanceKm = calculateDistanceKm(userLat, userLng, raw.latitude, raw.longitude);
      }

      return {
        id: raw.id || `place-${idx}`,
        name: raw.name || 'Unknown Restaurant',
        cuisine: raw.category || 'Restaurant',
        rating: typeof raw.rating === 'number' && !isNaN(raw.rating) ? raw.rating : 4.0,
        reviewsCount: typeof raw.reviews === 'number' ? raw.reviews : 0,
        address: raw.address || 'Address not available',
        distanceKm,
        imageUrl: raw.imageUrl || getFallbackImageForCuisine(raw.category),
        priceRange: raw.priceRange || '₹₹',
        isOpen: raw.openState ? !raw.openState.toLowerCase().startsWith('closed') : true,
        openingHours: raw.openState || 'Open Now',
        specialty: raw.category || 'Popular Spot',
        latitude: raw.latitude ?? undefined,
        longitude: raw.longitude ?? undefined,
      };
    });

    // Sort by distance (nearest-first)
    mappedPlaces.sort((a, b) => a.distanceKm - b.distanceKm);

    return {
      success: true,
      places: mappedPlaces,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      return {
        success: false,
        places: [],
        error: 'Connection timed out. Please check your internet or retry.',
      };
    }
    return {
      success: false,
      places: [],
      error:
        'Could not connect to backend server. Make sure "node index.js" is running on port 3000.',
    };
  }
}
