import { Feather } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  ImageBackground,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../context/AuthContext";
import {
  buildNativeDeviceContext,
  NativeCameraVerificationError,
  type NativeDeviceContext,
} from "../services/deviceMetadataService";

const BACKGROUND = require("../../assets/device-access-equipment-yard-v2.png");

const COLORS = {
  accent: "#E31B23",
  accentPressed: "#BE1118",
  panel: "rgba(8, 17, 28, 0.95)",
  panelRaised: "#111C2A",
  panelMuted: "rgba(255,255,255,0.035)",
  border: "rgba(178, 194, 214, 0.28)",
  borderStrong: "rgba(190, 205, 224, 0.5)",
  text: "#F8FAFC",
  textMuted: "#AAB5C5",
  textSubtle: "#8794A7",
  pending: "#F5A51C",
  pendingSoft: "rgba(245, 165, 28, 0.1)",
  danger: "#F0444D",
  dangerSoft: "rgba(240, 68, 77, 0.1)",
} as const;

function bytes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not reported";
  const gb = value / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

function formatDate(value?: string) {
  if (!value) return "just now";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "recently";
  return parsed.toLocaleString();
}

function InfoRow({
  icon,
  text,
  last = false,
}: {
  icon: keyof typeof Feather.glyphMap;
  text: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.infoRow, !last && styles.infoRowBorder]}>
      <View style={styles.infoIcon}>
        <Feather name={icon} size={20} color={COLORS.text} />
      </View>
      <Text style={styles.infoRowText}>{text}</Text>
    </View>
  );
}

function ActionButton({
  label,
  icon,
  busy = false,
  disabled = false,
  secondary = false,
  onPress,
}: {
  label: string;
  icon: keyof typeof Feather.glyphMap;
  busy?: boolean;
  disabled?: boolean;
  secondary?: boolean;
  onPress: () => void;
}) {
  const inactive = busy || disabled;
  const foreground = secondary ? COLORS.text : "#FFFFFF";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      android_ripple={{ color: secondary ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.2)" }}
      style={styles.actionPressable}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.actionButton,
            secondary ? styles.secondaryButton : styles.primaryButton,
            pressed && (secondary ? styles.secondaryPressed : styles.primaryPressed),
            inactive && styles.buttonDisabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={foreground} />
          ) : (
            <>
              <Feather name={icon} size={20} color={foreground} />
              <Text style={secondary ? styles.secondaryButtonText : styles.primaryButtonText}>
                {label}
              </Text>
            </>
          )}
        </View>
      )}
    </Pressable>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function usefulIp(value?: string) {
  if (!value || value === "unknown" || value === "127.0.0.1" || value === "::1") {
    return undefined;
  }
  return value;
}

export default function DeviceAccessScreen() {
  const { width, height } = useWindowDimensions();
  const {
    deviceAccess,
    registerDevice,
    refreshDeviceStatus,
    rerequestDevice,
    logout,
  } = useAuth();
  const [context, setContext] = useState<NativeDeviceContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tablet = width >= 720;
  const compact = height < 760;

  useEffect(() => {
    void buildNativeDeviceContext().then(setContext).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!deviceAccess || !["pending", "rerequest_pending"].includes(deviceAccess.authState)) {
      return;
    }

    let mounted = true;
    const poll = async () => {
      if (!mounted || AppState.currentState !== "active") return;
      try {
        await refreshDeviceStatus();
        if (mounted) setError(null);
      } catch (pollError) {
        if (mounted) {
          setError((pollError as Error).message || "Unable to check approval status.");
        }
      }
    };
    const interval = setInterval(poll, 10_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [deviceAccess, refreshDeviceStatus]);

  const state = deviceAccess?.authState || "registration_required";
  const pending = state === "pending" || state === "rerequest_pending";
  const rejected = state === "rejected" || state === "revoked";
  const blocked = state === "ip_blocked";
  const storage = (context?.metadata.storage || {}) as {
    totalBytes?: number;
    freeBytes?: number;
  };
  const hardwareProfile = record(context?.metadata.hardwareProfile);
  const hardwareCamera = record(hardwareProfile.camera);
  const deviceCamera = deviceAccess?.device?.camera;
  const cameraCount = Number(deviceCamera?.count || hardwareCamera.lensCount || 0);
  const rearMegapixels = Number(
    deviceCamera?.rearMaximumMegapixels || hardwareCamera.rearMaximumMegapixels || 0
  );
  const cameraLine = cameraCount
    ? `${cameraCount} camera${cameraCount === 1 ? "" : "s"}${
        rearMegapixels ? ` · rear up to ${rearMegapixels} MP` : ""
      }`
    : "Camera capabilities verified";

  const presentation = useMemo(() => {
    if (state === "registration_required") {
      return {
        icon: "lock" as const,
        iconColor: COLORS.accent,
        iconBackground: "rgba(227, 27, 35, 0.1)",
        title: "Camera access required",
        message: "Allow camera access to verify this device and send your approval request.",
        statusLabel: "Device verification",
      };
    }
    if (pending) {
      return {
        icon: "clock" as const,
        iconColor: COLORS.pending,
        iconBackground: COLORS.pendingSoft,
        title: state === "rerequest_pending" ? "New review requested" : "Waiting for approval",
        message: "Your device request has been sent to an administrator.",
        statusLabel: state === "rerequest_pending" ? "Re-request pending" : "Pending review",
      };
    }
    if (blocked) {
      return {
        icon: "slash" as const,
        iconColor: COLORS.danger,
        iconBackground: COLORS.dangerSoft,
        title: "IP address blocked",
        message: "Access from this network is blocked for your account. Contact support for help.",
        statusLabel: "Network blocked",
      };
    }
    return {
      icon: "shield-off" as const,
      iconColor: COLORS.danger,
      iconBackground: COLORS.dangerSoft,
      title: state === "revoked" ? "Device access revoked" : "Device request rejected",
      message:
        state === "revoked"
          ? "Your administrator removed access for this device."
          : "Your administrator did not approve this device.",
      statusLabel: state === "revoked" ? "Access revoked" : "Request rejected",
    };
  }, [blocked, pending, state]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError: any) {
      setError(
        actionError?.response?.data?.message ||
          actionError?.message ||
          "Unable to complete this device request."
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister() {
    await run(async () => {
      try {
        await registerDevice();
      } catch (cameraError) {
        if (cameraError instanceof NativeCameraVerificationError) throw cameraError;
        throw cameraError;
      }
    });
  }

  const support = deviceAccess?.supportContact;
  const os = record(context?.metadata.os);

  return (
    <ImageBackground source={BACKGROUND} resizeMode="cover" style={styles.background}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            compact && styles.scrollContentCompact,
            tablet && styles.scrollContentTablet,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.brand, compact && styles.brandCompact]}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>AI</Text>
            </View>
            <Text style={[styles.brandName, tablet && styles.brandNameTablet]}>Asset Insight</Text>
          </View>

          <View style={[styles.panel, compact && styles.panelCompact, tablet && styles.panelTablet]}>
            <View
              style={[
                styles.statusIcon,
                {
                  borderColor: presentation.iconColor,
                  backgroundColor: presentation.iconBackground,
                },
              ]}
            >
              <Feather name={presentation.icon} size={30} color={presentation.iconColor} />
            </View>

            <Text style={[styles.title, tablet && styles.titleTablet]}>{presentation.title}</Text>
            <Text style={styles.message}>{presentation.message}</Text>

            <View style={styles.statusLine}>
              <View style={[styles.statusDot, { backgroundColor: presentation.iconColor }]} />
              <Text style={[styles.statusText, { color: presentation.iconColor }]}>
                {presentation.statusLabel}
              </Text>
            </View>

            {state === "registration_required" ? (
              <View style={styles.infoList}>
                <InfoRow icon="smartphone" text={context?.displayName || "Detecting device…"} />
                <InfoRow
                  icon="cpu"
                  text={`${os.name ? String(os.name) : Platform.OS}${
                    os.version ? ` ${String(os.version)}` : ""
                  }`}
                />
                <InfoRow
                  icon="hard-drive"
                  text={`${bytes(storage.totalBytes)} total · ${bytes(storage.freeBytes)} free`}
                  last
                />
              </View>
            ) : null}

            {pending ? (
              <View style={styles.infoList}>
                <InfoRow
                  icon="smartphone"
                  text={context?.displayName || deviceAccess?.device?.displayName || "This device"}
                />
                <InfoRow icon="camera" text={cameraLine} />
                <InfoRow
                  icon="globe"
                  text={usefulIp(deviceAccess?.device?.lastIp) || "Network address updating"}
                />
                <InfoRow
                  icon="clock"
                  text={`Requested ${formatDate(deviceAccess?.device?.requestedAt)}`}
                  last
                />
              </View>
            ) : null}

            {rejected || blocked ? (
              <View style={styles.decisionArea}>
                {deviceAccess?.device?.displayName ? (
                  <View style={styles.infoList}>
                    <InfoRow icon="smartphone" text={deviceAccess.device.displayName} last />
                  </View>
                ) : null}

                {deviceAccess?.reason ? (
                  <View style={styles.noteBox}>
                    <Text style={styles.noteLabel}>Administrator note</Text>
                    <Text style={styles.noteText}>{deviceAccess.reason}</Text>
                  </View>
                ) : null}

                {support ? (
                  <View style={styles.supportBox}>
                    <Text style={styles.supportTitle}>
                      Contact {support.name || "Asset Insight Support"}
                    </Text>
                    {support.email ? (
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => void Linking.openURL(`mailto:${support.email}`)}
                        style={({ pressed }) => [styles.supportRow, pressed && styles.supportRowPressed]}
                      >
                        <Feather name="mail" size={17} color={COLORS.textMuted} />
                        <Text style={styles.supportText}>{support.email}</Text>
                      </Pressable>
                    ) : null}
                    {support.phone ? (
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => void Linking.openURL(`tel:${support.phone}`)}
                        style={({ pressed }) => [styles.supportRow, pressed && styles.supportRowPressed]}
                      >
                        <Feather name="phone" size={17} color={COLORS.textMuted} />
                        <Text style={styles.supportText}>{support.phone}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}

            {error ? (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={18} color="#FF7A81" />
                <View style={styles.errorCopy}>
                  <Text style={styles.errorText}>{error}</Text>
                  {state === "registration_required" ? (
                    <Pressable onPress={() => void Linking.openSettings()}>
                      <Text style={styles.settingsLink}>Open system settings</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}

            <View style={styles.actions}>
              {state === "registration_required" ? (
                <ActionButton
                  label="Allow camera access"
                  icon="video"
                  busy={busy}
                  onPress={() => void handleRegister()}
                />
              ) : null}
              {pending ? (
                <ActionButton
                  label="Check status"
                  icon="refresh-cw"
                  busy={busy}
                  onPress={() => void run(refreshDeviceStatus)}
                />
              ) : null}
              {rejected ? (
                <ActionButton
                  label="Request again"
                  icon="rotate-cw"
                  busy={busy}
                  onPress={() => void run(rerequestDevice)}
                />
              ) : null}
              <ActionButton
                label="Sign out"
                icon="log-out"
                disabled={busy}
                secondary
                onPress={() => void logout()}
              />
            </View>

            <View style={styles.footerNote}>
              <Feather name="shield" size={18} color={COLORS.textSubtle} />
              <Text style={styles.footerText}>
                {state === "registration_required"
                  ? "No photo or video is saved."
                  : rejected
                    ? "Re-requests are limited to 5 per day."
                    : blocked
                      ? "This exact IP is blocked only for your account."
                      : "We’ll check automatically every 10 seconds."}
              </Text>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: {
    flex: 1,
    backgroundColor: "#061322",
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 26,
    paddingBottom: 24,
  },
  scrollContentCompact: {
    paddingTop: 14,
    paddingBottom: 16,
  },
  scrollContentTablet: {
    paddingHorizontal: 64,
    paddingTop: 38,
    paddingBottom: 38,
  },
  brand: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 30,
  },
  brandCompact: {
    marginBottom: 18,
  },
  brandMark: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.accent,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 5,
  },
  brandMarkText: {
    color: "#FFFFFF",
    fontSize: 19,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  brandName: {
    marginLeft: 13,
    color: COLORS.text,
    fontSize: 23,
    fontWeight: "800",
    letterSpacing: -0.55,
    textShadowColor: "rgba(0,0,0,0.4)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  brandNameTablet: {
    fontSize: 27,
  },
  panel: {
    width: "100%",
    maxWidth: 420,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: 24,
    backgroundColor: COLORS.panel,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.42,
    shadowRadius: 30,
    elevation: 20,
  },
  panelCompact: {
    paddingTop: 18,
    paddingBottom: 14,
  },
  panelTablet: {
    maxWidth: 540,
    paddingHorizontal: 32,
    paddingTop: 30,
    paddingBottom: 24,
    borderRadius: 28,
  },
  statusIcon: {
    width: 60,
    height: 60,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderRadius: 30,
  },
  title: {
    marginTop: 18,
    color: COLORS.text,
    fontSize: 27,
    fontWeight: "800",
    lineHeight: 33,
    textAlign: "center",
    letterSpacing: -0.75,
  },
  titleTablet: {
    fontSize: 31,
    lineHeight: 38,
  },
  message: {
    maxWidth: 330,
    alignSelf: "center",
    marginTop: 8,
    color: COLORS.textMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
  statusLine: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 15,
    fontWeight: "800",
  },
  infoList: {
    overflow: "hidden",
  },
  infoRow: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  infoRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  infoIcon: {
    width: 40,
    height: 40,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: 10,
    backgroundColor: COLORS.panelRaised,
  },
  infoRowText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
  },
  decisionArea: {
    marginTop: 0,
  },
  noteBox: {
    marginTop: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(240, 68, 77, 0.28)",
    borderRadius: 12,
    backgroundColor: COLORS.dangerSoft,
  },
  noteLabel: {
    color: "#FFB5B9",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  noteText: {
    marginTop: 6,
    color: "#E7EBF1",
    fontSize: 13,
    lineHeight: 20,
  },
  supportBox: {
    paddingTop: 16,
  },
  supportTitle: {
    marginBottom: 8,
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "800",
  },
  supportRow: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  supportRowPressed: {
    backgroundColor: COLORS.panelMuted,
  },
  supportText: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(240, 68, 77, 0.42)",
    borderRadius: 12,
    backgroundColor: COLORS.dangerSoft,
  },
  errorCopy: {
    flex: 1,
  },
  errorText: {
    color: "#FFD3D5",
    fontSize: 12.5,
    lineHeight: 18,
  },
  settingsLink: {
    marginTop: 6,
    color: "#FF9DA2",
    fontSize: 12.5,
    fontWeight: "800",
    textDecorationLine: "underline",
  },
  actions: {
    width: "100%",
    gap: 10,
    marginTop: 18,
  },
  actionPressable: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 12,
  },
  actionButton: {
    width: "100%",
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 18,
    borderRadius: 12,
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderWidth: 1,
    borderColor: "#F04A51",
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.3,
    shadowRadius: 13,
    elevation: 7,
  },
  primaryPressed: {
    backgroundColor: COLORS.accentPressed,
    transform: [{ scale: 0.992 }],
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 15.5,
    fontWeight: "800",
    letterSpacing: 0.1,
  },
  secondaryButton: {
    borderWidth: 1.25,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.panelMuted,
  },
  secondaryPressed: {
    backgroundColor: "rgba(255,255,255,0.09)",
    transform: [{ scale: 0.992 }],
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: "700",
  },
  buttonDisabled: {
    opacity: 0.52,
    shadowOpacity: 0,
  },
  footerNote: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    marginTop: 14,
  },
  footerText: {
    flexShrink: 1,
    color: COLORS.textSubtle,
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: "center",
  },
});
