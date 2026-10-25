/**
 * Follow-up date in CRM Task Update (owner decision 2026-10-11): pick the day
 * the agent will next contact or visit the lead, and a time if they want one.
 * Rules and reminders: services/crmFollowUp.ts and the server's
 * crmFollowUpService. Android shows the system date/time dialogs; iOS shows an
 * inline spinner with Done, like the rest of the CRM forms.
 */
import React, { useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Feather } from '@expo/vector-icons';
import { crmTouchTarget } from './CrmModalFrame';
import {
  type FollowUpDraft,
  asSentence,
  formatFollowUpDate,
  formatFollowUpTime,
  localDate,
  localDateString,
  localTimeString,
} from '../../services/crmFollowUp';

type Props = {
  value: FollowUpDraft;
  onChange: (next: FollowUpDraft) => void;
  disabled?: boolean;
};

/** A time picked for the first time starts here. */
const DEFAULT_TIME = '09:00';

export default function CrmFollowUpPicker({ value, onChange, disabled = false }: Props) {
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const pickerValue = value.date ? localDate(value.date, value.time || DEFAULT_TIME) : localDate(localDateString(new Date()), DEFAULT_TIME);

  const handlePicked = (event: DateTimePickerEvent, picked?: Date) => {
    const mode = picking;
    // Android's dialog is done once it reports; iOS keeps its spinner until Done.
    if (Platform.OS !== 'ios') setPicking(null);
    if (event.type === 'dismissed' || !picked || !mode) return;
    if (mode === 'date') onChange({ date: localDateString(picked), time: value.time });
    else onChange({ date: value.date || localDateString(picked), time: localTimeString(picked) });
  };

  return (
    <View style={styles.wrap} testID="crm-follow-up-picker">
      <Text style={styles.label}>Follow-up date</Text>
      <TouchableOpacity
        style={[styles.trigger, disabled && styles.triggerDisabled]}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={value.date ? `${asSentence(`Follow-up date: ${formatFollowUpDate(value.date)}`)} Change` : 'Pick a follow-up date'}
        accessibilityState={{ disabled, expanded: picking === 'date' }}
        onPress={() => setPicking('date')}
        activeOpacity={0.8}>
        <Feather name="calendar" size={16} color={disabled ? '#94A3B8' : '#0284C7'} />
        <Text style={[styles.triggerText, disabled && styles.triggerTextDisabled]}>
          {value.date ? formatFollowUpDate(value.date) : 'Pick a follow-up date (optional)'}
        </Text>
        <Feather name="chevron-down" size={16} color="#64748B" />
      </TouchableOpacity>

      {value.date ? (
        <View style={styles.metaRow}>
          <TouchableOpacity
            style={styles.metaButton}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={value.time ? `${asSentence(`Follow-up time: ${formatFollowUpTime(value.date, value.time)}`)} Change` : 'Add a follow-up time'}
            onPress={() => setPicking('time')}>
            <Feather name="clock" size={14} color="#0C4A6E" />
            <Text style={styles.metaButtonText}>
              {value.time ? formatFollowUpTime(value.date, value.time) : 'Add time (optional)'}
            </Text>
          </TouchableOpacity>
          {value.time ? (
            <TouchableOpacity
              style={styles.metaButton}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Remove the follow-up time"
              onPress={() => onChange({ date: value.date, time: null })}>
              <Text style={styles.clearText}>No time</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={styles.metaButton}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Clear the follow-up date"
            onPress={() => onChange({ date: null, time: null })}>
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {picking ? (
        <View style={Platform.OS === 'ios' ? styles.pickerWrap : undefined}>
          <DateTimePicker
            testID={`crm-follow-up-${picking}-picker`}
            value={pickerValue}
            mode={picking}
            minimumDate={picking === 'date' ? today : undefined}
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handlePicked}
          />
          {Platform.OS === 'ios' ? (
            <TouchableOpacity style={styles.doneButton} accessibilityRole="button" accessibilityLabel="Done choosing" onPress={() => setPicking(null)}>
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  label: { fontSize: 13, fontWeight: '700', color: '#0F172A', marginBottom: 6 },
  trigger: {
    ...crmTouchTarget,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    backgroundColor: '#F0F9FF',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  triggerDisabled: { borderColor: '#E2E8F0', backgroundColor: '#F8FAFC' },
  triggerText: { flex: 1, fontSize: 13, lineHeight: 18, color: '#0C4A6E', fontWeight: '700' },
  triggerTextDisabled: { color: '#64748B' },
  metaRow: { marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  metaButton: { ...crmTouchTarget, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  metaButtonText: { fontSize: 12, color: '#0C4A6E', fontWeight: '700' },
  clearText: { fontSize: 12, color: '#B91C1C', fontWeight: '700' },
  pickerWrap: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    paddingTop: 2,
    paddingBottom: 8,
    paddingHorizontal: 6,
  },
  doneButton: {
    alignSelf: 'flex-end',
    marginTop: 4,
    marginRight: 6,
    backgroundColor: '#0284C7',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  doneText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
