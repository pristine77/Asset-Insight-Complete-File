"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  applyManualPreviewLocation,
  applyResolvedPreviewLocation,
  formatBrowserAccuracyStatus,
  formatBrowserLocationAttribution,
  FRESH_HIGH_ACCURACY_POSITION_OPTIONS,
  getValidBrowserCoordinates,
  hasUsableReportLocation,
  OPENSTREETMAP_ATTRIBUTION_URL,
} from "@/lib/browserLocation";
import { BrowserLocationService } from "@/services/browserLocation";

type PreviewLocationOptions = {
  isOpen: boolean;
  previewData: any;
  setPreviewData: Dispatch<SetStateAction<any>>;
  setHasChanges: Dispatch<SetStateAction<boolean>>;
};

export function usePreviewLocation({
  isOpen,
  previewData,
  setPreviewData,
  setHasChanges,
}: PreviewLocationOptions) {
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationStatus, setLocationStatus] = useState("");
  const [locationAttribution, setLocationAttribution] = useState("");
  const [locationAttributionUrl, setLocationAttributionUrl] = useState("");
  const requestGenerationRef = useRef(0);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const previewDataRef = useRef(previewData);
  previewDataRef.current = previewData;

  const cancelLocationRequest = useCallback(() => {
    requestGenerationRef.current += 1;
    lookupAbortRef.current?.abort();
    lookupAbortRef.current = null;
    setLocationBusy(false);
  }, []);

  useEffect(
    () => () => {
      requestGenerationRef.current += 1;
      lookupAbortRef.current?.abort();
      lookupAbortRef.current = null;
    },
    []
  );

  const resolveCoordinates = useCallback(
    async ({
      coordinates,
      generation,
      accuracy,
      migration,
    }: {
      coordinates: { latitude: number; longitude: number };
      generation: number;
      accuracy?: number | null;
      migration: boolean;
    }) => {
      const controller = new AbortController();
      lookupAbortRef.current?.abort();
      lookupAbortRef.current = controller;
      setLocationBusy(true);
      setLocationStatus(
        migration
          ? "Finding a readable name for the saved coordinates…"
          : "Finding the nearest readable inspection location…"
      );

      try {
        const resolved = await BrowserLocationService.reverseGeocode(
          coordinates,
          { signal: controller.signal }
        );
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) {
          return;
        }
        setPreviewData((current: any) =>
          applyResolvedPreviewLocation(
            current || {},
            resolved.location,
            coordinates
          )
        );
        setLocationAttribution(
          formatBrowserLocationAttribution(resolved.attribution)
        );
        setLocationAttributionUrl(
          resolved.attributionUrl || OPENSTREETMAP_ATTRIBUTION_URL
        );
        setLocationStatus(
          accuracy === undefined || accuracy === null
            ? "Readable inspection location restored from saved coordinates."
            : formatBrowserAccuracyStatus(accuracy)
        );
        setHasChanges(true);
      } catch {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) {
          return;
        }
        setLocationStatus(
          "The coordinates could not be named. Enter a readable inspection location before saving or submitting."
        );
      } finally {
        if (lookupAbortRef.current === controller) {
          lookupAbortRef.current = null;
        }
        if (generation === requestGenerationRef.current) {
          setLocationBusy(false);
        }
      }
    },
    [setHasChanges, setPreviewData]
  );

  useEffect(() => {
    const currentPreviewData = previewDataRef.current;
    if (!isOpen || !currentPreviewData) return;
    if (hasUsableReportLocation(currentPreviewData.location)) {
      setLocationStatus((current) =>
        current || "Readable inspection location ready."
      );
      return;
    }

    const coordinates = getValidBrowserCoordinates(currentPreviewData);
    if (!coordinates) {
      setLocationStatus(
        "Enter a readable inspection location before saving or submitting."
      );
      return;
    }

    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    void resolveCoordinates({ coordinates, generation, migration: true });
  }, [
    isOpen,
    previewData?.latitude,
    previewData?.location,
    previewData?.longitude,
    resolveCoordinates,
  ]);

  const updateLocation = useCallback(
    (location: string) => {
      cancelLocationRequest();
      setPreviewData((current: any) =>
        applyManualPreviewLocation(current || {}, location)
      );
      setLocationAttribution("");
      setLocationAttributionUrl("");
      setLocationStatus(
        hasUsableReportLocation(location)
          ? "Manual location saved; prior browser coordinates were cleared."
          : "Enter a readable inspection location before saving or submitting."
      );
      setHasChanges(true);
    },
    [cancelLocationRequest, setHasChanges, setPreviewData]
  );

  const requestCurrentLocation = useCallback(() => {
    cancelLocationRequest();
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationStatus("Browser location access is unavailable.");
      return;
    }

    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLocationBusy(true);
    setLocationStatus("Waiting for browser location permission…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (generation !== requestGenerationRef.current) return;
        const coordinates = getValidBrowserCoordinates(position.coords);
        if (!coordinates) {
          setLocationBusy(false);
          setLocationStatus(
            "Browser coordinates were unavailable. Enter the location manually."
          );
          return;
        }
        void resolveCoordinates({
          coordinates,
          generation,
          accuracy: position.coords.accuracy,
          migration: false,
        });
      },
      () => {
        if (generation !== requestGenerationRef.current) return;
        setLocationBusy(false);
        setLocationStatus(
          "Browser location access was denied or unavailable. Enter the location manually."
        );
      },
      FRESH_HIGH_ACCURACY_POSITION_OPTIONS
    );
  }, [cancelLocationRequest, resolveCoordinates]);

  return {
    isLocationReady: hasUsableReportLocation(previewData?.location),
    locationAttribution,
    locationAttributionUrl,
    locationBusy,
    locationStatus,
    requestCurrentLocation,
    updateLocation,
  };
}
