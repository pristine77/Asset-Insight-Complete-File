import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import offlineCaptureStore from '../../services/offlineCaptureStore';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';
import auctioneerService, {
  type AuctioneerCapturePermission,
} from '../../services/auctioneerService';
import {
  auctioneerReopenErrorMessage,
  auctioneerReopenReason,
} from '../../services/auctioneerErrors';

interface Props {
  contractId: string;
  contractNo: string;
  busy: boolean;
  blocked: boolean;
  onReopen: (confirmationRecovery: boolean) => void;
}

const freshnessMs = 30_000;

function reopenDeadline(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Regina',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return null;
  }
}

/** FlatList mounts this only for rendered cards; permission is never status/date-derived. */
export default function AuctioneerReopenAction({
  contractId,
  contractNo,
  busy,
  blocked,
  onReopen,
}: Props) {
  const { colors } = useAppTheme();
  const [permission, setPermission] = useState<AuctioneerCapturePermission | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async () => {
    const current = ++revision.current;
    const owner = offlineCaptureStore.getOwnerId();
    const epoch = getAuthOperationEpoch();
    const isCurrent = () =>
      current === revision.current &&
      owner === offlineCaptureStore.getOwnerId() &&
      epoch === getAuthOperationEpoch();
    if (expiry.current) clearTimeout(expiry.current);
    setPermission(null);
    setChecking(true);
    setError('');
    try {
      const next = await auctioneerService.getCapturePermission(contractId);
      if (!isCurrent()) return;
      setPermission(next);
      expiry.current = setTimeout(() => {
        if (isCurrent()) setPermission(null);
      }, freshnessMs);
    } catch (cause) {
      if (isCurrent()) setError(auctioneerReopenErrorMessage(cause));
    } finally {
      if (isCurrent()) setChecking(false);
    }
  }, [contractId]);

  useEffect(() => {
    void check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
      else {
        revision.current += 1;
        setPermission(null);
      }
    });
    return () => {
      revision.current += 1;
      if (expiry.current) clearTimeout(expiry.current);
      subscription.remove();
    };
  }, [check]);

  const pending = permission?.confirmationPending === true;
  const allowed = permission?.reopen.allowed === true && !blocked;
  const deadline = permission ? reopenDeadline(permission.reopen.reopenUntil) : null;
  const reason = auctioneerReopenReason(permission?.reopen.reason);
  const actionable = pending || allowed;
  const buttonText = pending ? 'Check Re-Open' : allowed ? 'Re-Open' : 'Check Re-Open availability';
  return (
    <View style={styles.container}>
      {!!deadline && (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Re-open until {deadline} Saskatchewan time
        </Text>
      )}
      {!!reason && !pending && (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>{reason}</Text>
      )}
      {!!error && (
        <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.danger }]}>
          {error}
        </Text>
      )}
      {pending && (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          The previous Re-Open needs confirmation. Check its outcome before adding lots.
        </Text>
      )}
      {checking ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Checking Re-Open availability…
        </Text>
      ) : actionable || !permission ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${buttonText} contract ${contractNo}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          style={[styles.button, { backgroundColor: colors.accent, opacity: busy ? 0.55 : 1 }]}
          onPress={() => (actionable ? onReopen(pending) : void check())}>
          <Text style={[styles.buttonText, { color: colors.accentText }]}>{buttonText}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8, marginTop: 8 },
  meta: { fontSize: 13, lineHeight: 20 },
  button: {
    minHeight: 44,
    padding: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: { fontSize: 13, fontWeight: '700' },
});
