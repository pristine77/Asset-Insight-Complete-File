import React, { useMemo, useState } from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import type { SalvageVehicleDetails, SalvageVehicleField } from '../../types/salvageAssessment';
import { salvageDisplayText } from '../../utils/salvageDisplayText';

interface Props {
  details: SalvageVehicleDetails;
  overrides?: Record<string, string | null>;
  disabled: boolean;
  photos?: string[];
  onChange: (overrides: Record<string, string | null>) => void;
}
type Styles = ReturnType<typeof createStyles>;
const ENGINE_KEYS = new Set([
  'powertrain',
  'engineMake',
  'engineModel',
  'engineDisplacement',
  'engineCylinders',
  'fuelType',
  'transmission',
  'driveType',
]);
const EMPTY_OVERRIDES: Record<string, string | null> = {};
const EMPTY_PHOTOS: string[] = [];

function VehicleChoice({
  field,
  value,
  source,
  disabled,
  onChange,
  styles,
}: {
  field: SalvageVehicleField;
  value: string | null;
  source: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
  styles: Styles;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const choices = field.options.filter((option) =>
    option.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  const close = () => {
    setOpen(false);
    setSearch('');
  };
  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Vehicle ${field.label}`}
        accessibilityHint={source}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[styles.input, styles.selectButton, disabled && styles.readOnly]}>
        <Text style={[styles.selectText, !value && styles.placeholder]}>
          {value || 'Cannot find from image'}
        </Text>
        <Text style={styles.link}>⌄</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalPanel} accessibilityViewIsModal>
            <View style={styles.groupButton}>
              <Text style={styles.heading}>Select {field.label}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Close ${field.label} choices`}
                onPress={close}
                style={styles.evidenceButton}>
                <Text style={styles.link}>Close</Text>
              </TouchableOpacity>
            </View>
            {field.options.length > 8 ? (
              <TextInput
                accessibilityLabel={`Search ${field.label} options`}
                value={search}
                onChangeText={setSearch}
                placeholder="Search available options"
                placeholderTextColor={styles.placeholder.color}
                style={styles.input}
                autoCorrect={false}
              />
            ) : null}
            <ScrollView keyboardShouldPersistTaps="handled">
              {[null, ...choices].map((option) => (
                <TouchableOpacity
                  key={option ?? '__clear__'}
                  accessibilityRole="radio"
                  accessibilityLabel={`${field.label}: ${option ?? 'Cannot find from image'}`}
                  accessibilityState={{ selected: (value || null) === option, disabled }}
                  disabled={disabled}
                  style={styles.option}
                  onPress={() => {
                    if (!disabled) {
                      onChange(option);
                      close();
                    }
                  }}>
                  <Text style={styles.selectText}>{option ?? 'Cannot find from image'}</Text>
                  {(value || null) === option ? <Text style={styles.link}>✓</Text> : null}
                </TouchableOpacity>
              ))}
              {!choices.length ? (
                <Text style={styles.muted}>
                  No matching options. Clear the search to see available values.
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

/** A displayed value is either saved evidence or an explicit owner edit, never a client inference. */
function VehicleField({
  field,
  overrides,
  disabled,
  photos,
  onChange,
  styles,
}: {
  field: SalvageVehicleField;
  overrides: Record<string, string | null>;
  disabled: boolean;
  photos: string[];
  onChange: (value: string | null) => void;
  styles: Styles;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const hasOverride = Object.prototype.hasOwnProperty.call(overrides, field.key);
  const manual = hasOverride || field.status === 'manual';
  const observed = !manual && field.status === 'observed';
  const value = hasOverride ? overrides[field.key] : manual || observed ? field.value : null;
  const source = manual
    ? value
      ? 'User-entered · not photo-verified'
      : 'Cleared by user'
    : observed
      ? 'Read from uploaded image'
      : field.status === 'conflict'
        ? 'Conflicting image readings · review needed'
        : 'Cannot find from image';
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{field.label}</Text>
      {field.type === 'select' && field.options.length > 0 ? (
        <VehicleChoice
          field={field}
          value={value ?? null}
          source={source}
          disabled={disabled}
          onChange={onChange}
          styles={styles}
        />
      ) : (
        <TextInput
          accessibilityLabel={`Vehicle ${field.label}`}
          accessibilityHint={source}
          editable={!disabled}
          value={value ?? ''}
          onChangeText={(next) => {
            if (!disabled) onChange(next.trim() ? next : null);
          }}
          placeholder="Cannot find from image"
          placeholderTextColor={styles.placeholder.color}
          autoCapitalize={
            field.key === 'vin' || field.key === 'serialNumber' ? 'characters' : 'sentences'
          }
          autoCorrect={false}
          keyboardType={field.type === 'number' ? 'decimal-pad' : 'default'}
          maxLength={1000}
          style={[styles.input, disabled && styles.readOnly]}
        />
      )}
      <Text style={!manual && !observed ? styles.warning : styles.muted}>{source}</Text>
      {field.evidence.length > 0 ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${field.label} photo evidence`}
          accessibilityState={{ expanded: showEvidence }}
          onPress={() => setShowEvidence((current) => !current)}
          style={styles.evidenceButton}>
          <Text style={styles.link}>
            {showEvidence ? 'Hide' : 'View'} photo evidence ({field.evidence.length})
          </Text>
        </TouchableOpacity>
      ) : null}
      {showEvidence
        ? field.evidence.map((item, index) => {
            const photoNumber = /^photo-(\d+)$/.exec(item.photoId)?.[1];
            const photo = photoNumber ? photos[Number(photoNumber) - 1] : undefined;
            return (
              <View key={`${item.photoId}-${index}`} style={styles.evidence}>
                <Text style={styles.label}>
                  {photoNumber ? `Photo ${Number(photoNumber)}` : item.photoId}
                </Text>
                {photo ? (
                  <Image
                    source={{ uri: photo }}
                    style={styles.photo}
                    resizeMode="contain"
                    accessibilityLabel={`${field.label} evidence photo ${Number(photoNumber)}`}
                  />
                ) : null}
                <Text style={styles.muted}>{item.evidence}</Text>
                {!item.accepted ? (
                  <Text style={styles.warning}>
                    Not accepted: {salvageDisplayText(item.rejectionReason || 'Insufficient readable evidence')}
                  </Text>
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

function FieldGroup({
  title,
  fields,
  initiallyOpen = true,
  styles,
  ...props
}: {
  title: string;
  fields: SalvageVehicleField[];
  initiallyOpen?: boolean;
  styles: Styles;
  overrides: Record<string, string | null>;
  disabled: boolean;
  photos: string[];
  onChange: (key: string, value: string | null) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!fields.length) return null;
  return (
    <View style={styles.group}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        style={styles.groupButton}
        onPress={() => setOpen((current) => !current)}>
        <Text style={styles.heading}>
          {title} ({fields.length})
        </Text>
        <Text style={styles.link}>{open ? '−' : '+'}</Text>
      </TouchableOpacity>
      {open ? (
        <View style={styles.grid}>
          {fields.map((field) => (
            <VehicleField
              key={field.key}
              field={field}
              {...props}
              styles={styles}
              onChange={(value) => props.onChange(field.key, value)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function SalvageVehicleDetailsEditor({
  details,
  overrides = EMPTY_OVERRIDES,
  disabled,
  photos = EMPTY_PHOTOS,
  onChange,
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const groups = useMemo(
    () => ({
      identity: details.fields.filter(
        (field) => !field.key.startsWith('spec:') && !ENGINE_KEYS.has(field.key)
      ),
      engine: details.fields.filter((field) => ENGINE_KEYS.has(field.key)),
      specifications: details.fields.filter((field) => field.key.startsWith('spec:')),
    }),
    [details.fields]
  );
  const change = (key: string, value: string | null) => {
    if (!disabled) onChange({ ...overrides, [key]: value });
  };
  const groupProps = { styles, overrides, disabled, photos, onChange: change };
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Vehicle details from photos</Text>
      <Text style={styles.muted}>
        Only readable uploaded-image evidence is filled in. Workbook specifications define the
        fields, not the values. Add or correct missing details below; your edits are marked
        user-entered.
      </Text>
      {details.warnings.map((warning, index) => (
        <Text key={`${index}-${warning}`} style={styles.warning}>
          {salvageDisplayText(warning)}
        </Text>
      ))}
      <FieldGroup title="Vehicle identity" fields={groups.identity} {...groupProps} />
      <FieldGroup title="Engine and powertrain" fields={groups.engine} {...groupProps} />
      <FieldGroup
        title="Vehicle-type specifications"
        fields={groups.specifications}
        {...groupProps}
      />
    </View>
  );
}

const createStyles = (c: AppThemeColors) =>
  StyleSheet.create({
    panel: {
      gap: 10,
      padding: 12,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
    },
    title: { color: c.text, fontSize: 17, fontWeight: '700' },
    heading: { color: c.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
    label: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
    muted: { color: c.textSecondary, fontSize: 12, lineHeight: 18 },
    warning: { color: c.warning, fontSize: 12, lineHeight: 18 },
    link: { color: c.accent, fontSize: 13, fontWeight: '600' },
    group: { borderTopWidth: 1, borderColor: c.border },
    groupButton: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    field: { gap: 5, flexGrow: 1, flexShrink: 1, flexBasis: 280, minWidth: 0, maxWidth: '100%' },
    input: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      borderRadius: 6,
      padding: 10,
      color: c.text,
      fontSize: 14,
    },
    placeholder: { color: c.textMuted },
    selectButton: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    },
    selectText: { color: c.text, fontSize: 14, flexShrink: 1 },
    modalOverlay: {
      flex: 1,
      backgroundColor: '#0008',
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 24,
    },
    modalPanel: {
      width: '92%',
      maxWidth: 560,
      maxHeight: '85%',
      padding: 16,
      borderRadius: 12,
      backgroundColor: c.surface,
      gap: 10,
    },
    option: {
      minHeight: 48,
      paddingVertical: 12,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
      borderBottomWidth: 1,
      borderColor: c.border,
    },
    readOnly: { opacity: 0.7 },
    evidenceButton: { minHeight: 44, justifyContent: 'center' },
    evidence: { gap: 6, padding: 8, backgroundColor: c.background, borderRadius: 6 },
    photo: { width: '100%', height: 180 },
  });
