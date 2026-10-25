import React, { useMemo, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import SalvageVehicleDetailsEditor from './SalvageVehicleDetailsEditor';
import { salvageDisplayText } from '../../utils/salvageDisplayText';
import {
  formatAssessmentMoney,
  type SalvageAssessmentInputs,
  type SalvageAssessmentV2,
  type SalvageComparableEvidence,
  type SalvageCostInput,
  type SalvageReference,
} from '../../types/salvageAssessment';

export interface SalvageAssessmentEditorProps {
  assessment: SalvageAssessmentV2;
  inputs: Partial<SalvageAssessmentInputs>;
  disabled: boolean;
  onChange: (inputs: Partial<SalvageAssessmentInputs>) => void;
  photos?: string[];
}
type Styles = ReturnType<typeof createStyles>;
const PROVINCES = [
  '',
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
];
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const nullableText = (value: string) => (value.trim() ? value : null);
const cost = (description: string): SalvageCostInput => ({
  description,
  amount: null,
  referenceIds: [],
  appraiserReason: null,
});
const uniqueId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Display links never launch custom schemes, credentials or local-network targets. */
export function safeAssessmentUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 3000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !['80', '443'].includes(url.port)) ||
      !host.includes('.') ||
      /^[\d.]+$/.test(host) ||
      host.includes(':') ||
      /(?:^|\.)(localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(host) ||
      /(?:^|\.)(?:nip\.io|sslip\.io)$/.test(host)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
async function openEvidence(value: unknown) {
  const url = safeAssessmentUrl(value);
  if (!url) return;
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert('Link unavailable', 'This evidence link could not be opened.');
  }
}

function Field({
  label,
  value,
  onChange,
  disabled,
  styles,
  multiline = false,
  number = false,
  signed = false,
}: {
  label: string;
  value: string | number | null | undefined;
  onChange: (value: string | number | null) => void;
  disabled: boolean;
  styles: Styles;
  multiline?: boolean;
  number?: boolean;
  signed?: boolean;
}) {
  const [numericDraft, setNumericDraft] = useState<{ text: string; value: number | null } | null>(
    null
  );
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={
          number && numericDraft !== null && numericDraft.value === value
            ? numericDraft.text
            : text(value)
        }
        editable={!disabled}
        keyboardType={number ? (signed ? 'numbers-and-punctuation' : 'decimal-pad') : 'default'}
        multiline={multiline}
        maxLength={number ? 18 : multiline ? 8000 : 500}
        placeholder={number ? 'Unknown' : 'Not provided'}
        placeholderTextColor={styles.placeholder.color}
        style={[styles.input, multiline && styles.multiline, disabled && styles.readOnly]}
        onChangeText={(next) => {
          if (!number) {
            onChange(nullableText(next));
            return;
          }
          if (!(signed ? /^-?\d*(?:\.\d*)?$/ : /^\d*(?:\.\d*)?$/).test(next)) return;
          const parsed = ['', '.', '-', '-.'].includes(next) ? null : Number(next);
          if (parsed !== null && !Number.isFinite(parsed)) return;
          setNumericDraft({ text: next, value: parsed });
          onChange(parsed);
        }}
        onBlur={() => setNumericDraft(null)}
      />
    </View>
  );
}
function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
  styles,
}: {
  label: string;
  value: string | null | undefined;
  options: string[];
  onChange: (value: string | null) => void;
  disabled: boolean;
  styles: Styles;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.choices}>
        {options.map((option) => (
          <TouchableOpacity
            key={option}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${option || 'Unknown'}`}
            accessibilityState={{ selected: (value || '') === option, disabled }}
            disabled={disabled}
            onPress={() => onChange(option || null)}
            style={[styles.choice, (value || '') === option && styles.selected]}>
            <Text style={styles.link}>{option || 'Unknown'}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
function Section({
  title,
  children,
  styles,
  initiallyOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  styles: Styles;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen((value) => !value)}
        style={styles.sectionButton}>
        <Text style={styles.heading}>{title}</Text>
        <Text style={styles.link}>{open ? '−' : '+'}</Text>
      </TouchableOpacity>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}
function Button({
  title,
  onPress,
  disabled,
  styles,
}: {
  title: string;
  onPress: () => void;
  disabled: boolean;
  styles: Styles;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.readOnly]}>
      <Text style={styles.link}>{title}</Text>
    </TouchableOpacity>
  );
}
function ReferencePicker({
  label,
  references,
  ids,
  onChange,
  disabled,
  styles,
}: {
  label: string;
  references: SalvageReference[];
  ids: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  styles: Styles;
}) {
  return (
    <Section title={`${label} (${ids.length} selected)`} styles={styles}>
      {!references.length ? (
        <Text style={styles.muted}>
          Add appraiser evidence below, or enter an appraiser rationale for this amount.
        </Text>
      ) : null}
      {references.map((reference) => (
        <TouchableOpacity
          key={reference.id}
          accessibilityRole="checkbox"
          accessibilityLabel={`${label}: ${reference.title}`}
          accessibilityState={{ checked: ids.includes(reference.id), disabled }}
          disabled={disabled}
          style={styles.button}
          onPress={() =>
            onChange(
              ids.includes(reference.id)
                ? ids.filter((id) => id !== reference.id)
                : [...ids, reference.id]
            )
          }>
          <Text style={styles.text}>
            {ids.includes(reference.id) ? '☑ ' : '☐ '}
            {reference.title}
          </Text>
        </TouchableOpacity>
      ))}
    </Section>
  );
}
function CostFields({
  label,
  value,
  onChange,
  references,
  disabled,
  styles,
  fixedDescription = false,
}: {
  label: string;
  value: SalvageCostInput | null;
  onChange: (value: SalvageCostInput | null) => void;
  references: SalvageReference[];
  disabled: boolean;
  styles: Styles;
  fixedDescription?: boolean;
}) {
  const row = value || cost(label);
  const update = (patch: Partial<SalvageCostInput>) => onChange({ ...row, ...patch });
  return (
    <>
      {!fixedDescription ? (
        <Field
          label={`${label} description`}
          value={row.description}
          disabled={disabled}
          styles={styles}
          onChange={(value) => update({ description: String(value || '') })}
        />
      ) : null}
      <Field
        label={`${label} amount (CAD)`}
        value={row.amount}
        number
        disabled={disabled}
        styles={styles}
        onChange={(value) => update({ amount: value as number | null })}
      />
      <Field
        label={`${label} rationale`}
        value={row.appraiserReason}
        multiline
        disabled={disabled}
        styles={styles}
        onChange={(value) => update({ appraiserReason: value as string | null })}
      />
      <ReferencePicker
        label={`${label} evidence`}
        references={references}
        ids={row.referenceIds}
        onChange={(referenceIds) => update({ referenceIds })}
        disabled={disabled}
        styles={styles}
      />
      <Button
        title={`Clear ${label}`}
        disabled={disabled || value === null}
        styles={styles}
        onPress={() => onChange(null)}
      />
    </>
  );
}

function newComparable(): SalvageComparableEvidence {
  return {
    id: uniqueId('manual'),
    basket: 'as_is',
    title: '',
    url: null,
    sourceName: null,
    listingId: null,
    vin: null,
    year: null,
    make: null,
    model: null,
    trim: null,
    powertrain: null,
    odometer: null,
    odometerUnit: null,
    condition: null,
    brand: null,
    location: null,
    province: null,
    country: 'CA',
    eventDate: null,
    price: null,
    currency: 'CAD',
    priceBasis: 'unknown',
    verification: 'appraiser_supplied',
    evidence: {},
    referenceIds: [],
    adjustments: [],
    fx: null,
    appraiserReason: null,
    photoIds: [],
    eligible: false,
    selected: false,
    exclusionReasons: [],
    adjustedPrice: null,
    ageDays: null,
  };
}

/** Input-only editor: saved assessment arithmetic/provenance never changes in this component. */
export default function SalvageAssessmentEditor({
  assessment,
  inputs,
  disabled,
  onChange,
  photos = [],
}: SalvageAssessmentEditorProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const data: SalvageAssessmentInputs = {
    ...assessment.inputs,
    ...inputs,
    repairItems: inputs.repairItems || assessment.inputs.repairItems,
    labourItems: inputs.labourItems || assessment.inputs.labourItems,
    charges: inputs.charges || assessment.inputs.charges,
    suppliedComparables: inputs.suppliedComparables || assessment.inputs.suppliedComparables,
    suppliedReferences: inputs.suppliedReferences || assessment.inputs.suppliedReferences,
    sellerCosts: { ...assessment.inputs.sellerCosts, ...inputs.sellerCosts },
    overrides: { ...assessment.inputs.overrides, ...inputs.overrides },
  };
  const references = [
    ...new Map(
      [...assessment.references, ...data.suppliedReferences].map((reference) => [
        reference.id,
        reference,
      ])
    ).values(),
  ];
  const set = <K extends keyof SalvageAssessmentInputs>(
    key: K,
    value: SalvageAssessmentInputs[K]
  ) => {
    if (!disabled) onChange({ ...data, [key]: value });
  };
  const setComparable = (index: number, patch: Partial<SalvageComparableEvidence>) =>
    set(
      'suppliedComparables',
      data.suppliedComparables.map((row, i) =>
        i === index ? { ...row, ...patch, verification: 'appraiser_supplied' } : row
      )
    );
  const setReference = (index: number, patch: Partial<SalvageReference>) =>
    set(
      'suppliedReferences',
      data.suppliedReferences.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  const sourceLink = (url: unknown, label: string) =>
    safeAssessmentUrl(url) ? (
      <Button
        title={label}
        disabled={false}
        styles={styles}
        onPress={() => {
          void openEvidence(url);
        }}
      />
    ) : null;
  return (
    <View style={styles.container}>
      {assessment.vehicleDetails?.schemaVersion === 1 ? (
        <SalvageVehicleDetailsEditor details={assessment.vehicleDetails} overrides={data.vehicleOverrides}
          disabled={disabled} photos={photos} onChange={(overrides) => set('vehicleOverrides', overrides)} />
      ) : null}
      <View style={styles.panel}>
        <Text style={styles.heading}>Canadian assessment · saved results (CAD)</Text>
        {[
          [
            'Pre-loss market value',
            assessment.valuations.preLoss.amount,
            assessment.valuations.preLoss.status,
          ],
          ['Repair estimate', assessment.repairs.total, assessment.repairs.status],
          [
            'As-is salvage value',
            assessment.valuations.asIs.amount,
            assessment.valuations.asIs.status,
          ],
          ['Net auction recovery', assessment.netRecovery.total, assessment.netRecovery.status],
        ].map(([label, amount, status]) => (
          <View key={String(label)} style={styles.result}>
            <Text style={styles.label}>{String(label)}</Text>
            <Text style={styles.value}>{formatAssessmentMoney(amount)}</Text>
            <Text style={styles.muted}>{String(status).replace(/_/g, ' ')}</Text>
          </View>
        ))}
        <Text style={styles.muted}>
          Saved results update after saving. Blank amounts are unknown, not zero. Calculations and
          source verification are performed by the backend.
        </Text>
        {assessment.stale ? (
          <Text style={styles.warning}>
            Research is stale: material report inputs changed after the last research run.
          </Text>
        ) : null}
      </View>

      <Section title={`Evidence limitations (${assessment.limitations.length})`} styles={styles}>
        {assessment.limitations.map((item) => (
          <Text key={item.code} style={item.severity === 'critical' ? styles.warning : styles.text}>
            {salvageDisplayText(item.message)}
          </Text>
        ))}
        {!assessment.limitations.length ? (
          <Text style={styles.muted}>No limitations were recorded for this saved assessment.</Text>
        ) : null}
        <Text style={styles.muted}>
          This is valuation support, not certification of roadworthiness, legal brand or battery
          safety.
        </Text>
      </Section>

      <Section title="Assessment subject and Canadian market" styles={styles} initiallyOpen>
        {!assessment.vehicleDetails ? <Text style={styles.muted}>Legacy vehicle details: image provenance is unavailable. Review these saved values before relying on them.</Text> : null}
        {!assessment.vehicleDetails && (['year', 'make', 'model', 'trim', 'powertrain', 'vin', 'odometer'] as const).map(
          (key) => (
            <Field
              key={key}
              label={`Assessment ${key === 'vin' ? 'VIN' : key}`}
              value={data[key]}
              number={key === 'year' || key === 'odometer'}
              disabled={disabled}
              styles={styles}
              onChange={(value) => set(key, value as never)}
            />
          )
        )}
        {!assessment.vehicleDetails && <Choice
          label="Odometer unit"
          value={data.odometerUnit}
          options={['', 'km', 'mi']}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('odometerUnit', value as 'km' | 'mi' | null)}
        />}
        <Choice
          label="Market province"
          value={data.province}
          options={PROVINCES}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('province', value)}
        />
        <Field
          label="Market city or region"
          value={data.market}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('market', value as string | null)}
        />
        <Field
          label="Effective valuation date (YYYY-MM-DD)"
          value={data.effectiveDate}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('effectiveDate', value as string | null)}
        />
        <Field
          label="Loss type"
          value={data.lossType}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('lossType', value as string | null)}
        />
        <Field
          label="Documented vehicle brand"
          value={data.documentedBrand}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('documentedBrand', value as string | null)}
        />
        <Choice
          label="Brand province"
          value={data.brandProvince}
          options={PROVINCES}
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('brandProvince', value)}
        />
        <ReferencePicker
          label="Brand documentation"
          references={references}
          ids={data.brandEvidenceRef ? [data.brandEvidenceRef] : []}
          onChange={(ids) => set('brandEvidenceRef', ids[ids.length - 1] || null)}
          disabled={disabled}
          styles={styles}
        />
        <Field
          label="Observed condition"
          value={data.condition}
          multiline
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('condition', value as string | null)}
        />
        <Field
          label="Damage description"
          value={data.damageDescription}
          multiline
          disabled={disabled}
          styles={styles}
          onChange={(value) => set('damageDescription', value as string | null)}
        />
      </Section>

      <Section title={`Repair parts (${data.repairItems.length})`} styles={styles}>
        <Text style={styles.muted}>
          Enter a verified unit price and quantity. Cite supporting evidence or provide an appraiser
          rationale of at least 10 characters.
        </Text>
        {data.repairItems.map((row, index) => (
          <Section
            key={index}
            title={`Part ${index + 1}: ${row.description || 'New part'}`}
            styles={styles}>
            {(['description', 'quantity', 'unitPrice', 'appraiserReason'] as const).map((key) => (
              <Field
                key={key}
                label={`Part ${index + 1} ${key === 'appraiserReason' ? 'rationale' : key === 'unitPrice' ? 'unit price (CAD)' : key}`}
                value={row[key]}
                number={key === 'quantity' || key === 'unitPrice'}
                multiline={key === 'appraiserReason'}
                disabled={disabled}
                styles={styles}
                onChange={(value) =>
                  set(
                    'repairItems',
                    data.repairItems.map((item, i) =>
                      i === index ? { ...item, [key]: value } : item
                    )
                  )
                }
              />
            ))}
            <ReferencePicker
              label={`Part ${index + 1} evidence`}
              references={references}
              ids={row.referenceIds}
              disabled={disabled}
              styles={styles}
              onChange={(referenceIds) =>
                set(
                  'repairItems',
                  data.repairItems.map((item, i) =>
                    i === index ? { ...item, referenceIds } : item
                  )
                )
              }
            />
            <Button
              title={`Remove part ${index + 1}`}
              disabled={disabled}
              styles={styles}
              onPress={() =>
                set(
                  'repairItems',
                  data.repairItems.filter((_, i) => i !== index)
                )
              }
            />
          </Section>
        ))}
        <Button
          title="Add repair part"
          disabled={disabled || data.repairItems.length >= 300}
          styles={styles}
          onPress={() =>
            set('repairItems', [
              ...data.repairItems,
              {
                description: '',
                quantity: null,
                unitPrice: null,
                referenceIds: [],
                appraiserReason: null,
              },
            ])
          }
        />
      </Section>

      <Section title={`Repair labour (${data.labourItems.length})`} styles={styles}>
        {data.labourItems.map((row, index) => (
          <Section
            key={index}
            title={`Labour ${index + 1}: ${row.description || 'New task'}`}
            styles={styles}>
            {(['description', 'hours', 'rate', 'appraiserReason'] as const).map((key) => (
              <Field
                key={key}
                label={`Labour ${index + 1} ${key === 'appraiserReason' ? 'rationale' : key === 'rate' ? 'hourly rate (CAD)' : key}`}
                value={row[key]}
                number={key === 'hours' || key === 'rate'}
                multiline={key === 'appraiserReason'}
                disabled={disabled}
                styles={styles}
                onChange={(value) =>
                  set(
                    'labourItems',
                    data.labourItems.map((item, i) =>
                      i === index ? { ...item, [key]: value } : item
                    )
                  )
                }
              />
            ))}
            <ReferencePicker
              label={`Labour ${index + 1} evidence`}
              references={references}
              ids={row.referenceIds}
              disabled={disabled}
              styles={styles}
              onChange={(referenceIds) =>
                set(
                  'labourItems',
                  data.labourItems.map((item, i) =>
                    i === index ? { ...item, referenceIds } : item
                  )
                )
              }
            />
            <Button
              title={`Remove labour ${index + 1}`}
              disabled={disabled}
              styles={styles}
              onPress={() =>
                set(
                  'labourItems',
                  data.labourItems.filter((_, i) => i !== index)
                )
              }
            />
          </Section>
        ))}
        <Button
          title="Add labour task"
          disabled={disabled || data.labourItems.length >= 300}
          styles={styles}
          onPress={() =>
            set('labourItems', [
              ...data.labourItems,
              { description: '', hours: null, rate: null, referenceIds: [], appraiserReason: null },
            ])
          }
        />
      </Section>

      <Section title={`Other repair charges (${data.charges.length})`} styles={styles}>
        <Text style={styles.muted}>
          Record applicable supplies, taxes or other charges separately. Enter zero only when
          verified to be zero.
        </Text>
        {data.charges.map((row, index) => (
          <Section
            key={index}
            title={`Charge ${index + 1}: ${row.description || 'New charge'}`}
            styles={styles}>
            <CostFields
              label={`Charge ${index + 1}`}
              value={row}
              references={references}
              disabled={disabled}
              styles={styles}
              onChange={(value) =>
                set(
                  'charges',
                  value === null
                    ? data.charges.filter((_, i) => i !== index)
                    : data.charges.map((item, i) => (i === index ? value : item))
                )
              }
            />
          </Section>
        ))}
        <Button
          title="Add repair charge"
          disabled={disabled || data.charges.length >= 50}
          styles={styles}
          onPress={() => set('charges', [...data.charges, cost('')])}
        />
      </Section>

      <Section title="Seller deductions and net recovery inputs" styles={styles}>
        <Text style={styles.muted}>
          Seller-side costs only. Unknown deductions prevent a definitive net recovery. Do not
          substitute buyer fees.
        </Text>
        {(['fees', 'transport', 'storage', 'disposal'] as const).map((key) => (
          <Section key={key} title={`Seller ${key}`} styles={styles}>
            <CostFields
              label={`Seller ${key}`}
              value={data.sellerCosts[key]}
              references={references}
              fixedDescription
              disabled={disabled}
              styles={styles}
              onChange={(value) => set('sellerCosts', { ...data.sellerCosts, [key]: value })}
            />
          </Section>
        ))}
      </Section>

      <Section title="Appraiser valuation overrides" styles={styles}>
        <Text style={styles.muted}>
          Overrides need cited evidence or a genuine appraiser rationale of at least 10 characters.
          They do not become verified sales.
        </Text>
        {(['preLoss', 'asIs'] as const).map((key) => (
          <Section
            key={key}
            title={`${key === 'preLoss' ? 'Pre-loss' : 'As-is'} override`}
            styles={styles}>
            <CostFields
              label={`${key === 'preLoss' ? 'Pre-loss' : 'As-is'} override`}
              value={data.overrides[key]}
              references={references}
              fixedDescription
              disabled={disabled}
              styles={styles}
              onChange={(value) => set('overrides', { ...data.overrides, [key]: value })}
            />
          </Section>
        ))}
      </Section>

      <Section title={`Appraiser evidence (${data.suppliedReferences.length})`} styles={styles}>
        <Text style={styles.muted}>
          Supplied evidence is identified as appraiser-provided, never independently web-verified.
          Add dated source text and link a report photo where appropriate.
        </Text>
        {data.suppliedReferences.map((row, index) => (
          <Section
            key={row.id}
            title={`Evidence ${index + 1}: ${row.title || 'New evidence'}`}
            styles={styles}>
            {(['title', 'publisher', 'url', 'accessedAt', 'excerpt'] as const).map((key) => (
              <Field
                key={key}
                label={`Evidence ${index + 1} ${key === 'accessedAt' ? 'date (YYYY-MM-DD)' : key}`}
                value={row[key]}
                multiline={key === 'excerpt'}
                disabled={disabled}
                styles={styles}
                onChange={(value) => setReference(index, { [key]: value })}
              />
            ))}
            {photos.length ? (
              <Section
                title={`Evidence ${index + 1} linked photos (${row.photoIds.length})`}
                styles={styles}>
                {photos.slice(0, 50).map((_, photoIndex) => {
                  const id = `photo-${String(photoIndex + 1).padStart(3, '0')}`;
                  return (
                    <TouchableOpacity
                      key={id}
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Evidence ${index + 1} photo ${photoIndex + 1}`}
                      accessibilityState={{ checked: row.photoIds.includes(id), disabled }}
                      disabled={disabled}
                      style={styles.button}
                      onPress={() =>
                        setReference(index, {
                          photoIds: row.photoIds.includes(id)
                            ? row.photoIds.filter((photoId) => photoId !== id)
                            : [...row.photoIds, id],
                        })
                      }>
                      <Text style={styles.text}>
                        {row.photoIds.includes(id) ? '☑ ' : '☐ '}Photo {photoIndex + 1}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </Section>
            ) : null}
            <Button
              title={`Remove evidence ${index + 1}`}
              disabled={disabled}
              styles={styles}
              onPress={() =>
                set(
                  'suppliedReferences',
                  data.suppliedReferences.filter((_, i) => i !== index)
                )
              }
            />
          </Section>
        ))}
        <Button
          title="Add appraiser evidence"
          disabled={disabled || data.suppliedReferences.length >= 50}
          styles={styles}
          onPress={() =>
            set('suppliedReferences', [
              ...data.suppliedReferences,
              {
                id: uniqueId('appraiser'),
                kind: 'appraiser',
                title: '',
                publisher: null,
                url: null,
                accessedAt: null,
                excerpt: '',
                photoIds: [],
              },
            ])
          }
        />
      </Section>

      <Section title={`Appraiser comparables (${data.suppliedComparables.length})`} styles={styles}>
        <Text style={styles.muted}>
          Record the actual price basis and dated evidence. A reserve or current bid is not a
          completed sale.
        </Text>
        {data.suppliedComparables.map((row, index) => (
          <Section
            key={row.id}
            title={`Comparable ${index + 1}: ${row.title || 'New vehicle'}`}
            styles={styles}>
            <Text style={styles.muted}>Appraiser supplied · not independently verified</Text>
            <Choice
              label={`Comparable ${index + 1} valuation group`}
              value={row.basket}
              options={['pre_loss', 'as_is']}
              disabled={disabled}
              styles={styles}
              onChange={(value) => setComparable(index, { basket: value as 'pre_loss' | 'as_is' })}
            />
            <Choice
              label={`Comparable ${index + 1} price basis`}
              value={row.priceBasis}
              options={['unknown', 'sold', 'asking', 'reserve', 'current_bid']}
              disabled={disabled}
              styles={styles}
              onChange={(value) =>
                setComparable(index, {
                  priceBasis: value as SalvageComparableEvidence['priceBasis'],
                })
              }
            />
            {(
              [
                'title',
                'sourceName',
                'url',
                'listingId',
                'year',
                'make',
                'model',
                'trim',
                'powertrain',
                'vin',
                'odometer',
                'condition',
                'brand',
                'location',
                'country',
                'eventDate',
                'price',
                'currency',
                'appraiserReason',
              ] as const
            ).map((key) => (
              <Field
                key={key}
                label={`Comparable ${index + 1} ${key === 'eventDate' ? 'evidence date (YYYY-MM-DD)' : key === 'appraiserReason' ? 'rationale' : key}`}
                value={row[key]}
                number={key === 'price' || key === 'year' || key === 'odometer'}
                multiline={key === 'appraiserReason' || key === 'condition'}
                disabled={disabled}
                styles={styles}
                onChange={(value) => setComparable(index, { [key]: value })}
              />
            ))}
            <Choice
              label={`Comparable ${index + 1} odometer unit`}
              value={row.odometerUnit}
              options={['', 'km', 'mi']}
              disabled={disabled}
              styles={styles}
              onChange={(value) =>
                setComparable(index, { odometerUnit: value as 'km' | 'mi' | null })
              }
            />
            <Choice
              label={`Comparable ${index + 1} province`}
              value={row.province}
              options={PROVINCES}
              disabled={disabled}
              styles={styles}
              onChange={(value) => setComparable(index, { province: value })}
            />
            <ReferencePicker
              label={`Comparable ${index + 1} evidence`}
              references={data.suppliedReferences}
              ids={row.referenceIds}
              disabled={disabled}
              styles={styles}
              onChange={(referenceIds) => setComparable(index, { referenceIds })}
            />
            {row.currency && row.currency !== 'CAD' ? (
              <Text style={styles.warning}>
                Foreign-currency evidence remains excluded without a dated Bank of Canada conversion
                verified in research.
              </Text>
            ) : null}
            <Section
              title={`Comparable ${index + 1} adjustments (${row.adjustments.length})`}
              styles={styles}>
              <Text style={styles.muted}>
                Amounts adjust the converted CAD price. Positive adds value; negative deducts value.
                Each adjustment requires evidence or an appraiser rationale.
              </Text>
              {row.adjustments.map((adjustment, adjustmentIndex) => (
                <Section
                  key={adjustmentIndex}
                  title={`Adjustment ${adjustmentIndex + 1}: ${adjustment.description || 'New adjustment'}`}
                  styles={styles}>
                  {(['description', 'amount', 'appraiserReason'] as const).map((key) => (
                    <Field
                      key={key}
                      label={`Comparable ${index + 1} adjustment ${adjustmentIndex + 1} ${key === 'appraiserReason' ? 'rationale' : key}`}
                      value={adjustment[key]}
                      number={key === 'amount'}
                      signed={key === 'amount'}
                      multiline={key === 'appraiserReason'}
                      disabled={disabled}
                      styles={styles}
                      onChange={(value) =>
                        setComparable(index, {
                          adjustments: row.adjustments.map((item, i) =>
                            i === adjustmentIndex ? { ...item, [key]: value } : item
                          ),
                        })
                      }
                    />
                  ))}
                  <ReferencePicker
                    label={`Comparable ${index + 1} adjustment ${adjustmentIndex + 1} evidence`}
                    references={references}
                    ids={adjustment.referenceIds}
                    disabled={disabled}
                    styles={styles}
                    onChange={(referenceIds) =>
                      setComparable(index, {
                        adjustments: row.adjustments.map((item, i) =>
                          i === adjustmentIndex ? { ...item, referenceIds } : item
                        ),
                      })
                    }
                  />
                  <Button
                    title={`Remove comparable ${index + 1} adjustment ${adjustmentIndex + 1}`}
                    disabled={disabled}
                    styles={styles}
                    onPress={() =>
                      setComparable(index, {
                        adjustments: row.adjustments.filter((_, i) => i !== adjustmentIndex),
                      })
                    }
                  />
                </Section>
              ))}
              <Button
                title={`Add comparable ${index + 1} adjustment`}
                disabled={disabled || row.adjustments.length >= 20}
                styles={styles}
                onPress={() =>
                  setComparable(index, {
                    adjustments: [
                      ...row.adjustments,
                      { description: '', amount: null, referenceIds: [], appraiserReason: null },
                    ],
                  })
                }
              />
            </Section>
            <Button
              title={`Remove comparable ${index + 1}`}
              disabled={disabled}
              styles={styles}
              onPress={() =>
                set(
                  'suppliedComparables',
                  data.suppliedComparables.filter((_, i) => i !== index)
                )
              }
            />
          </Section>
        ))}
        <Button
          title="Add appraiser comparable"
          disabled={disabled || data.suppliedComparables.length >= 20}
          styles={styles}
          onPress={() => set('suppliedComparables', [...data.suppliedComparables, newComparable()])}
        />
      </Section>

      <Section
        title={`Saved researched candidates (${assessment.candidates.length})`}
        styles={styles}>
        {assessment.candidates.map((candidate) => (
          <Section
            key={candidate.id}
            title={`${candidate.selected ? 'Selected · ' : ''}${candidate.title}`}
            styles={styles}>
            <Text style={styles.text}>
              {candidate.basket === 'pre_loss' ? 'Pre-loss market' : 'As-is salvage'} ·{' '}
              {candidate.priceBasis.replace(/_/g, ' ')} ·{' '}
              {candidate.verification.replace(/_/g, ' ')}
            </Text>
            <Text style={styles.value}>
              {candidate.currency && /^[A-Z]{3}$/.test(candidate.currency)
                ? formatAssessmentMoney(candidate.price, 'en', candidate.currency)
                : candidate.price === null
                  ? 'Unavailable'
                  : `${candidate.price} · currency unavailable`}
            </Text>
            <Text style={styles.muted}>
              Adjusted CAD: {formatAssessmentMoney(candidate.adjustedPrice)}
            </Text>
            <Text style={styles.text}>
              {[
                candidate.year,
                candidate.make,
                candidate.model,
                candidate.trim,
                candidate.powertrain,
              ]
                .filter((value) => value !== null && value !== '')
                .join(' · ')}
            </Text>
            <Text style={styles.text}>
              {candidate.odometer === null
                ? 'Mileage unavailable'
                : `${candidate.odometer} ${candidate.odometerUnit || ''}`}
            </Text>
            <Text style={styles.text}>
              {candidate.condition || 'Condition unavailable'} · Brand:{' '}
              {candidate.brand || 'Unverified'}
            </Text>
            <Text style={styles.muted}>
              {[candidate.location, candidate.province, candidate.eventDate, candidate.sourceName]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {candidate.exclusionReasons.map((reason, index) => (
              <Text key={`${index}-${reason}`} style={styles.warning}>
                {reason}
              </Text>
            ))}
            {candidate.adjustments.map((adjustment, index) => (
              <Text key={index} style={styles.text}>
                {adjustment.description}: {formatAssessmentMoney(adjustment.amount)} ·{' '}
                {adjustment.appraiserReason || adjustment.referenceIds.join(', ')}
              </Text>
            ))}
            <Text style={styles.muted}>
              References: {candidate.referenceIds.join(', ') || 'None'}
            </Text>
            {sourceLink(candidate.url, `Open source: ${candidate.title}`)}
          </Section>
        ))}
        {!assessment.candidates.length ? (
          <Text style={styles.muted}>
            No candidate evidence was established in this research run.
          </Text>
        ) : null}
      </Section>

      <Section title={`Saved references (${assessment.references.length})`} styles={styles}>
        {assessment.references.map((reference, index) => (
          <Section key={reference.id} title={`[${index + 1}] ${reference.title}`} styles={styles}>
            <Text style={styles.muted}>
              {reference.kind} · {reference.publisher || 'Publisher not provided'} ·{' '}
              {reference.accessedAt || 'Date not provided'} · {reference.id}
            </Text>
            <Text style={styles.text}>{reference.excerpt || 'No supporting excerpt saved.'}</Text>
            {sourceLink(reference.url, `Open reference ${index + 1}`)}
            {reference.photoIds.map((id) => {
              const photoIndex = Number(id.replace('photo-', '')) - 1;
              return photos[photoIndex] ? (
                <React.Fragment key={id}>
                  {sourceLink(photos[photoIndex], `Open ${id}`)}
                </React.Fragment>
              ) : null;
            })}
          </Section>
        ))}
      </Section>
    </View>
  );
}

const createStyles = (c: AppThemeColors) =>
  StyleSheet.create({
    container: { gap: 12, minWidth: 0 },
    panel: {
      padding: 12,
      gap: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.surface,
    },
    section: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.surface,
      overflow: 'hidden',
    },
    sectionButton: {
      minHeight: 48,
      padding: 12,
      gap: 8,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    sectionBody: { padding: 12, paddingTop: 0, gap: 10 },
    heading: { color: c.text, fontSize: 16, fontWeight: '600', flexShrink: 1 },
    label: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
    text: { color: c.text, fontSize: 14, lineHeight: 20 },
    muted: { color: c.textSecondary, fontSize: 13, lineHeight: 19 },
    warning: { color: c.warning, fontSize: 13, lineHeight: 19 },
    value: { color: c.text, fontSize: 18, fontWeight: '700' },
    result: { paddingVertical: 6, borderBottomWidth: 1, borderColor: c.border, gap: 3 },
    field: { gap: 5 },
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
    multiline: { minHeight: 84, textAlignVertical: 'top' },
    placeholder: { color: c.textMuted },
    readOnly: { opacity: 0.65 },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    choice: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 10,
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
    },
    selected: { backgroundColor: c.accentSoft, borderColor: c.accent },
    button: {
      minHeight: 44,
      paddingVertical: 10,
      paddingHorizontal: 8,
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
    },
    link: { color: c.accent, fontSize: 13, fontWeight: '600' },
  });
