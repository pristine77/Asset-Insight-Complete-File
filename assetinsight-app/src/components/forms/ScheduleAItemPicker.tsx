import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import auctioneerService, {
  type AuctioneerScheduleAChoice,
  type AuctioneerWorkItemSetup,
} from '../../services/auctioneerService';
import { auctioneerErrorMessage } from '../../services/auctioneerErrors';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import {
  SCHEDULE_A_ITEM_NONE_MESSAGE,
  scheduleAChoicesFor,
  scheduleAItemBlockMessage,
  validScheduleAChoice,
} from './auctioneerFormPolicy';

/**
 * The "Schedule A item" choice of one Incoming form (owner 2026-10-28).
 *
 * A Create Lot & Continue or Re-Open lot on a Schedule A contract arrives with
 * no Schedule A line of its own. The appraiser chooses which item ticked
 * "Several lots" in Auctioneer 2.0 the lots belong to, and that one choice
 * applies to every lot in the form, so no lot reaches Auctioneer orphaned.
 * When the setup does not require it, nothing is shown and nothing is sent.
 */
export function useScheduleAItemChoice(setup?: AuctioneerWorkItemSetup) {
  const required = setup?.requiresScheduleAItem === true;
  // "Check again" reads the list for the setup on screen. A newer setup from the
  // boundary replaces both, so an old list never outlives its assignment.
  const [refreshed, setRefreshed] = useState<{ setup: AuctioneerWorkItemSetup; choices: AuctioneerScheduleAChoice[] }>();
  const choices = refreshed && refreshed.setup === setup ? refreshed.choices : scheduleAChoicesFor(setup);
  const [picked, setPicked] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const checkingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A saved choice the server no longer offers counts as no choice: the lots
  // could otherwise be sent to an item that is no longer ticked "Several lots".
  const parentLotId = required ? validScheduleAChoice(choices, picked) : undefined;

  const choose = useCallback((next?: string) => {
    setPicked(next);
    setMessage('');
  }, []);

  // Stable, so draft loading can call it without re-running its own effect.
  const restore = useCallback((saved: unknown) => {
    setPicked(validScheduleAChoice(choicesRef.current, saved));
  }, []);

  const refresh = useCallback(async () => {
    if (!setup || !required || checkingRef.current) return;
    const owner = OfflineCaptureStore.getOwnerId();
    const stillHere = () => mountedRef.current && owner === OfflineCaptureStore.getOwnerId();
    checkingRef.current = true;
    setChecking(true);
    setMessage('');
    try {
      // The server refreshes the list each time the setup is read (the office
      // may have ticked "Several lots" while this form was open).
      const fresh = await auctioneerService.getSetup(setup.workItemId);
      if (!stillHere()) return;
      if (fresh.workItemId !== setup.workItemId || fresh.contract.id !== setup.contract.id) {
        throw new Error('This Incoming assignment changed. Close this form and reopen it from Incoming.');
      }
      const next = fresh.scheduleAChoices ?? [];
      setRefreshed({ setup, choices: next });
      setPicked((current) => validScheduleAChoice(next, current));
    } catch (error) {
      if (stillHere()) {
        setMessage(auctioneerErrorMessage(error, 'The Schedule A items could not be checked. Check the connection, then try again.'));
      }
    } finally {
      checkingRef.current = false;
      if (mountedRef.current) setChecking(false);
    }
  }, [required, setup]);

  /**
   * Returns why Submit must stop, or undefined when the lots may be sent. The
   * "choose" reason is also shown under the picker; the "none" reason already
   * stands in place of the list.
   */
  const blockSubmit = (): string | undefined => {
    const reason = scheduleAItemBlockMessage(required, choices, parentLotId);
    if (reason && reason !== SCHEDULE_A_ITEM_NONE_MESSAGE) setMessage(reason);
    return reason;
  };

  return { required, choices, parentLotId, choose, restore, refresh, checking, message, blockSubmit };
}

export type ScheduleAItemChoiceState = ReturnType<typeof useScheduleAItemChoice>;

interface Props {
  item: ScheduleAItemChoiceState;
  disabled?: boolean;
  /** The host form's own section and title styles, so the picker looks like its neighbours. */
  style?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
}

/** Same chip-with-check pattern as the Lot Listing service picker, as a single choice. */
export default function ScheduleAItemPicker({ item, disabled = false, style, titleStyle }: Props) {
  if (!item.required) return null;
  const empty = item.choices.length === 0;
  return (
    <View testID="schedule-a-item-picker" style={style}>
      <Text style={titleStyle}>Schedule A item *</Text>
      {empty ? (
        <Text style={styles.notice}>{SCHEDULE_A_ITEM_NONE_MESSAGE}</Text>
      ) : (
        <>
          <Text style={styles.help}>Choose the item these lots belong to. It applies to every lot in this form.</Text>
          <View accessibilityRole="radiogroup" style={styles.choices}>
            {item.choices.map((choice) => {
              const selected = choice.parentLotId === item.parentLotId;
              return (
                <TouchableOpacity
                  key={choice.parentLotId}
                  accessibilityRole="radio"
                  accessibilityLabel={choice.title}
                  accessibilityState={{ checked: selected, disabled }}
                  disabled={disabled}
                  onPress={() => item.choose(choice.parentLotId)}
                  style={[styles.chip, selected && styles.chipActive]}
                  activeOpacity={0.86}>
                  <Text style={[styles.chipText, selected && styles.chipTextActive]}>{choice.title}</Text>
                  <View style={[styles.check, selected && styles.checkActive]}>
                    {selected ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
      {item.message ? (
        <Text accessibilityRole="alert" style={styles.error}>{item.message}</Text>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={empty ? 'Check Schedule A items again' : 'Refresh Schedule A items'}
        accessibilityState={{ disabled: disabled || item.checking, busy: item.checking }}
        disabled={disabled || item.checking}
        onPress={() => void item.refresh()}
        style={styles.refresh}>
        {item.checking ? (
          <ActivityIndicator size="small" color="#2563EB" />
        ) : (
          <Feather name="refresh-cw" size={14} color="#2563EB" />
        )}
        <Text style={styles.refreshText}>{empty ? 'Check again' : 'Refresh list'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  help: { color: '#475569', fontSize: 12, lineHeight: 17, marginBottom: 8 },
  notice: {
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    lineHeight: 19,
  },
  choices: { gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chipActive: { borderColor: '#2563EB', backgroundColor: '#DBEAFE' },
  chipText: { flex: 1, color: '#475569', fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: '#1D4ED8' },
  check: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#94A3B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkActive: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  error: { color: '#DC2626', fontSize: 12, marginTop: 6 },
  refresh: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  refreshText: { color: '#2563EB', fontSize: 13, fontWeight: '700' },
});
