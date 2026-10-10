import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  StatusBar as RNStatusBar,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { FoodRadarTheme, BiteRadarTheme } from '@/constants/bite-radar-theme';
const theme = FoodRadarTheme || BiteRadarTheme;
import { getSortedFoodPlaces } from '@/constants/mock-data';
import { FoodPlace, ScanStatus } from '@/types/food';
import { useDeviceLocation } from '@/hooks/use-device-location';

import { Header } from '@/components/Header';
import { LocationToggle } from '@/components/LocationToggle';
import { AnimatedRadar } from '@/components/AnimatedRadar';
import { FoodCard } from '@/components/FoodCard';
import { InitialLocationPrompt } from '@/components/InitialLocationPrompt';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { GpsLocationBadge } from '@/components/GpsLocationBadge';
import { fetchNearbyFoodPlaces } from '@/services/food-api';

export default function FoodRadarScreen() {
  // Application UI states
  const [isLocationEnabled, setIsLocationEnabled] = useState<boolean>(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [places, setPlaces] = useState<FoodPlace[]>([]);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSearchingFood, setIsSearchingFood] = useState<boolean>(false);
  // Tracks how many seconds we've been searching, to show a friendly wake-up message
  const [searchSeconds, setSearchSeconds] = useState<number>(0);
  const searchTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Real device location hook
  const {
    loadingStep,
    coordinates,
    errorState,
    requestLocation,
    cancelRequest,
    openAppSettings,
  } = useDeviceLocation();

  const isLocating =
    loadingStep === 'requesting_permission' || loadingStep === 'detecting_location';

  /**
   * Triggers device location acquisition and displays discovered food spots
   */
  const handleStartLocationScan = useCallback(async () => {
    setScanStatus('scanning');
    setApiError(null);
    setIsSearchingFood(false);

    const result = await requestLocation();

    if (result.success && result.coords) {
      setIsSearchingFood(true);
      setSearchSeconds(0);
      // Start a 1-second tick so getRadarStatusMessage can show warm-up hints
      if (searchTimerRef.current) clearInterval(searchTimerRef.current);
      searchTimerRef.current = setInterval(() => setSearchSeconds(s => s + 1), 1000);

      // Coordinates acquired successfully -> Fetch REAL food spots from SerpApi backend
      const stopTimer = () => {
        if (searchTimerRef.current) {
          clearInterval(searchTimerRef.current);
          searchTimerRef.current = null;
        }
      };
      try {
        const foodResult = await fetchNearbyFoodPlaces(
          result.coords.latitude,
          result.coords.longitude
        );

        stopTimer();
        setIsSearchingFood(false);

        if (foodResult.success) {
          if (foodResult.places.length > 0) {
            setPlaces(foodResult.places);
            setScanStatus('results');
          } else {
            setPlaces([]);
            setScanStatus('empty');
          }
        } else {
          setPlaces([]);
          setApiError(foodResult.error || 'Failed to fetch food spots from server');
          setScanStatus('error');
        }
      } catch (err: any) {
        stopTimer();
        setIsSearchingFood(false);
        setPlaces([]);
        setApiError(err?.message || 'Unexpected network error while contacting food server');
        setScanStatus('error');
      }
    } else if (result.error) {
      setIsSearchingFood(false);
      // Handle failure case
      setPlaces([]);
      setScanStatus('error');

      // If permission was denied, turn the switch back OFF as required
      if (
        result.error.type === 'permission_denied' ||
        result.error.type === 'settings_required'
      ) {
        setIsLocationEnabled(false);
      }
    }
  }, [requestLocation]);

  /**
   * Handles user toggling the Location Switch
   */
  const handleLocationToggle = useCallback(
    async (enabled: boolean) => {
      // Prevent duplicate simultaneous requests
      if (isLocating) {
        return;
      }

      setIsLocationEnabled(enabled);

      if (enabled) {
        await handleStartLocationScan();
      } else {
        // Cancel in-flight location work and return to initial state
        cancelRequest();
        setPlaces([]);
        setScanStatus('idle');
        setIsRefreshing(false);
      }
    },
    [isLocating, handleStartLocationScan, cancelRequest]
  );

  /**
   * Handles retry action from error states
   */
  const handleRetryScan = useCallback(async () => {
    setIsLocationEnabled(true);
    await handleStartLocationScan();
  }, [handleStartLocationScan]);

  /**
   * Pull-to-refresh on results list
   */
  const handlePullToRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await handleStartLocationScan();
    setIsRefreshing(false);
  }, [handleStartLocationScan]);

  /**
   * Dynamic radar status message based on current loading step
   */
  const getRadarStatusMessage = () => {
    if (isSearchingFood) {
      if (searchSeconds >= 10) {
        return {
          title: 'Almost there...',
          subtitle: 'Server is warming up — results loading shortly',
        };
      }
      if (searchSeconds >= 5) {
        return {
          title: 'Waking up server...',
          subtitle: 'First load takes ~30s — please wait ✨',
        };
      }
      return {
        title: 'Searching food spots...',
        subtitle: 'Fetching live restaurants near you',
      };
    }
    if (loadingStep === 'requesting_permission') {
      return {
        title: 'Requesting location permission...',
        subtitle: 'Please allow location access on your phone',
      };
    }
    return {
      title: 'Detecting your location...',
      subtitle: 'Acquiring GPS coordinates & accuracy',
    };
  };

  /**
   * Header component for the FlatList (GPS coordinates & results summary)
   */
  const renderListHeader = () => (
    <View>
      {/* Real GPS coordinates card and demo disclaimer */}
      {coordinates && <GpsLocationBadge coordinates={coordinates} />}

      <View style={styles.resultsHeader}>
        <View style={styles.resultsBadgeRow}>
          <View style={styles.countPill}>
            <Text style={styles.countText}>{places.length} food places found</Text>
          </View>
          <Text style={styles.sortedLabel}>Sorted by distance</Text>
        </View>
        <Text style={styles.subtextNotice}>
          Showing top spots within 2 km of your current location
        </Text>
      </View>
    </View>
  );

  /**
   * Footer component for the FlatList
   */
  const renderListFooter = () => (
    <View style={styles.footerContainer}>
      <Text style={styles.endOfResultsText}>• All 2 km spots scanned •</Text>
    </View>
  );

  const radarMsg = getRadarStatusMessage();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />

      {/* 1. App Header */}
      <Header radiusLabel="Within 2 km" />

      {/* 2. Prominent Location Switch */}
      <LocationToggle
        isEnabled={isLocationEnabled}
        onToggle={handleLocationToggle}
        disabled={isLocating}
      />

      {/* 3. Dynamic Content depending on UI state */}
      <View style={styles.contentContainer}>
        {/* State A: Location is OFF and no active error */}
        {!isLocationEnabled && scanStatus !== 'error' && (
          <View style={styles.scrollWrapper}>
            <InitialLocationPrompt />
          </View>
        )}

        {/* State B: Actively scanning / acquiring GPS */}
        {isLocationEnabled && scanStatus === 'scanning' && (
          <View style={styles.centerContainer}>
            <AnimatedRadar
              statusMessage={radarMsg.title}
              subtitleMessage={radarMsg.subtitle}
            />
          </View>
        )}

        {/* State C: Scanning Finished with GPS coordinates and mock results */}
        {isLocationEnabled && scanStatus === 'results' && (
          <FlatList
            data={places}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <FoodCard place={item} isNearest={index === 0} />
            )}
            ListHeaderComponent={renderListHeader}
            ListFooterComponent={renderListFooter}
            contentContainerStyle={styles.flatListContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handlePullToRefresh}
                colors={[theme.colors.primary]}
                tintColor={theme.colors.primary}
              />
            }
          />
        )}

        {/* State D: Empty State (0 results found) */}
        {isLocationEnabled && scanStatus === 'empty' && (
          <View style={styles.stateWrapper}>
            <EmptyState onRetry={handleRetryScan} />
          </View>
        )}

        {/* State E: Location or Scanning Error */}
        {scanStatus === 'error' && (
          <View style={styles.stateWrapper}>
            {errorState ? (
              <ErrorState
                title={
                  errorState.type === 'services_disabled'
                    ? 'Location Services Disabled'
                    : errorState.type === 'settings_required' ||
                      errorState.type === 'permission_denied'
                    ? 'Permission Required'
                    : 'Location Detection Failed'
                }
                message={errorState.message}
                canOpenSettings={errorState.canOpenSettings}
                onOpenSettings={openAppSettings}
                onRetry={handleRetryScan}
                retryLabel="Try Again"
              />
            ) : (
              <ErrorState
                title="Food Radar Error"
                message={apiError || 'Failed to retrieve food spots from server. Please verify backend is running on port 3000.'}
                canOpenSettings={false}
                onRetry={handleRetryScan}
                retryLabel="Retry Search"
              />
            )}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  contentContainer: {
    flex: 1,
  },
  scrollWrapper: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 24,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stateWrapper: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 24,
  },
  flatListContent: {
    paddingBottom: 32,
  },
  resultsHeader: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 12,
  },
  resultsBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  countPill: {
    backgroundColor: theme.colors.surfaceAccentLight,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.surfaceAccentMedium,
  },
  countText: {
    fontSize: 13,
    fontWeight: '800',
    color: theme.colors.primary,
  },
  sortedLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
  subtextNotice: {
    fontSize: 12,
    color: theme.colors.textTertiary,
    marginTop: 2,
  },
  footerContainer: {
    paddingTop: 16,
    paddingBottom: 24,
    alignItems: 'center',
  },
  endOfResultsText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.textTertiary,
    letterSpacing: 0.5,
  },
});
