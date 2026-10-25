import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../context/AuthContext';
import salvageService, { SalvageDetails, SalvageAssessmentInputs } from '../../services/salvageService';
import { SALVAGE_IMAGE_LIMIT, remainingImageSlots } from '../../services/reportUploadPolicy';
import { pollAcceptedReport } from '../../services/reportProgressPolling';
import { salvageDisplayText } from '../../utils/salvageDisplayText';

interface SalvageFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: (reportId?: string) => void;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const ASSESSMENT_CONTEXT_FIELDS = [
  { key: 'province', label: 'Market province / territory', placeholder: 'Province code, e.g. ON' },
  { key: 'market', label: 'City / local market', placeholder: 'City / local market' },
  { key: 'effectiveDate', label: 'Effective valuation date', placeholder: 'Valuation date YYYY-MM-DD' },
  { key: 'lossType', label: 'Type / cause of loss', placeholder: 'Type / cause of loss (if known)' },
  { key: 'documentedBrand', label: 'Documented vehicle brand', placeholder: 'Exact brand from documentation' },
  { key: 'brandProvince', label: 'Brand document province / territory', placeholder: 'Brand province code, e.g. ON' },
] as const;
const initialAssessment = (): Partial<SalvageAssessmentInputs> => ({ province: null, market: null,
  effectiveDate: isoDate(new Date()), lossType: null, documentedBrand: null, brandProvince: null,
  condition: null, damageDescription: null, currency: 'CAD' });

const SalvageFormSheet: React.FC<SalvageFormSheetProps> = ({ visible, onClose, onSuccess }) => {
  const { user } = useAuth();

  // Form fields
  const [reportDate, setReportDate] = useState(isoDate(new Date()));
  const [fileNumber, setFileNumber] = useState('');
  const [dateReceived, setDateReceived] = useState(isoDate(new Date()));
  const [claimNumber, setClaimNumber] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [appraiserName, setAppraiserName] = useState('');
  const [appraiserPhone, setAppraiserPhone] = useState('');
  const [appraiserEmail, setAppraiserEmail] = useState('');
  const [adjusterName, setAdjusterName] = useState('');
  const [insuredName, setInsuredName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [appraiserComments, setAppraiserComments] = useState('');
  const [nextReportDue, setNextReportDue] = useState(isoDate(new Date()));
  const [language, setLanguage] = useState<'en' | 'fr' | 'es'>('en');
  const [assessmentInputs, setAssessmentInputs] = useState<Partial<SalvageAssessmentInputs>>(initialAssessment);

  // Images state
  const [images, setImages] = useState<Array<{ uri: string; name: string; type: string }>>([]);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle');
  const submissionRef = useRef(false);
  const stopPollingRef = useRef<(() => void) | null>(null);
  const submissionIdRef = useRef<string | null>(null);
  const acceptedReportIdRef = useRef<string | undefined>(undefined);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible) {
      setAppraiserName((user as any)?.username || '');
      setAppraiserEmail((user as any)?.email || '');
      setCompanyName((user as any)?.companyName || '');
      setCompanyAddress((user as any)?.companyAddress || '');
      setAppraiserPhone((user as any)?.contactPhone || '');
    }
  }, [user, visible]);

  // Dispose polling when the sheet hides as well as on unmount.
  useEffect(() => {
    if (!visible) stopPollingRef.current?.();
    return () => {
      stopPollingRef.current?.();
      uploadAbortRef.current?.abort();
    };
  }, [visible]);

  const clearError = (field: string) => {
    setErrors((prev) => {
      const { [field]: _, ...rest } = prev;
      return rest;
    });
  };

  const changeAssessment = (key: keyof SalvageAssessmentInputs, raw: string) => {
    if (submissionRef.current) return;
    const value = raw === '' ? null : raw;
    setAssessmentInputs((previous) => ({ ...previous, [key]: value }));
    clearError('assessment');
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!fileNumber.trim()) newErrors.fileNumber = 'Required';
    if (!claimNumber.trim()) newErrors.claimNumber = 'Required';
    if (!policyNumber.trim()) newErrors.policyNumber = 'Required';
    if (!appraiserName.trim()) newErrors.appraiserName = 'Required';
    if (!appraiserPhone.trim()) newErrors.appraiserPhone = 'Required';
    if (!appraiserEmail.trim()) newErrors.appraiserEmail = 'Required';
    if (!adjusterName.trim()) newErrors.adjusterName = 'Required';
    if (!insuredName.trim()) newErrors.insuredName = 'Required';
    if (!companyName.trim()) newErrors.companyName = 'Required';
    if (!companyAddress.trim()) newErrors.companyAddress = 'Required';
    if (!appraiserComments.trim()) newErrors.appraiserComments = 'Required';
    if ([assessmentInputs.province, assessmentInputs.brandProvince].some((province) => province && !PROVINCES.includes(province))) newErrors.assessment = 'Use a valid Canadian province / territory code, or leave it blank.';
    if (assessmentInputs.effectiveDate && (!/^\d{4}-\d{2}-\d{2}$/.test(assessmentInputs.effectiveDate) || !Number.isFinite(Date.parse(assessmentInputs.effectiveDate)) || isoDate(new Date(assessmentInputs.effectiveDate)) !== assessmentInputs.effectiveDate)) newErrors.assessment = 'Use YYYY-MM-DD for the valuation date, or leave it blank.';
    if (images.length === 0) newErrors.images = 'At least one image required';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const pickImages = async () => {
    const remaining = remainingImageSlots(images.length, SALVAGE_IMAGE_LIMIT);
    if (!remaining) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: remaining,
      });

      if (!result.canceled && result.assets) {
        const newImages = result.assets.map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName || `image_${Date.now()}_${index}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        }));
        setImages((prev) => [...prev, ...newImages].slice(0, SALVAGE_IMAGE_LIMIT));
        clearError('images');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick images');
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const startPolling = (id: string) => {
    stopPollingRef.current?.();
    stopPollingRef.current = pollAcceptedReport({
      load: async () => {
        const progress = await salvageService.getProgress(id);
        if (progress.result?.reportId) acceptedReportIdRef.current = progress.result.reportId;
        return progress;
      },
      onDone: () => {
        Alert.alert('Preview ready', 'Review and edit your salvage preview before submitting it to generate report files.');
        finishAcceptedReport();
      },
      onError: (message) => {
        if (acceptedReportIdRef.current) {
          Alert.alert('Preview needs attention', salvageDisplayText(message));
          finishAcceptedReport();
          return;
        }
        submissionRef.current = false;
        setSubmitting(false);
        setProgressPhase('error');
        Alert.alert('Generation failed', salvageDisplayText(message));
      },
      onPending: continueInBackground,
    });
  };

  const handleSubmit = async () => {
    if (submissionRef.current) return;
    if (acceptedReportIdRef.current) { finishAcceptedReport(); return; }
    if (!validateForm()) {
      Alert.alert('Error', 'Please fill all required fields');
      return;
    }

    submissionRef.current = true;
    setSubmitting(true);
    setProgressPhase('uploading');
    setUploadProgress(0);
    submissionIdRef.current ||= `salvage-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    uploadAbortRef.current = new AbortController();

    try {
      const details: SalvageDetails = {
        report_date: reportDate,
        file_number: fileNumber,
        date_received: dateReceived,
        claim_number: claimNumber,
        policy_number: policyNumber,
        appraiser_name: appraiserName,
        appraiser_phone: appraiserPhone,
        appraiser_email: appraiserEmail,
        adjuster_name: adjusterName,
        insured_name: insuredName,
        company_name: companyName,
        company_address: companyAddress,
        appraiser_comments: appraiserComments,
        next_report_due: nextReportDue,
        language,
        currency: 'CAD',
        assessment_inputs: assessmentInputs,
        client_submission_id: submissionIdRef.current,
      };

      const response = await salvageService.create(details, images, (progress) => {
        setUploadProgress(progress);
      }, uploadAbortRef.current.signal);
      uploadAbortRef.current = null;
      acceptedReportIdRef.current = response.reportId;

      if (response.reportId) {
        finishAcceptedReport();
      } else if (response.jobId) {
        setProgressPhase('processing');
        startPolling(response.jobId);
      } else {
        setProgressPhase('done');
        Alert.alert('Submission accepted', salvageDisplayText(response.message || 'The server accepted your report. Check My Reports for progress.'));
        finishAcceptedReport();
      }
    } catch (error: any) {
      submissionRef.current = false;
      setSubmitting(false);
      setProgressPhase('error');
      uploadAbortRef.current = null;
      Alert.alert('Upload not confirmed', `${salvageDisplayText(error?.response?.data?.message || error?.message || 'Unable to confirm upload.')} Your inputs are retained. Check Previews before starting another report. Retrying here reuses the same submission identifier.`);
    }
  };

  const finishAcceptedReport = () => {
    stopPollingRef.current?.();
    const reportId = acceptedReportIdRef.current;
    resetForm();
    onClose();
    onSuccess?.(reportId);
  };

  const continueInBackground = () => {
    Alert.alert('Upload accepted', 'Your preview is being prepared. Find the same report in Previews or My Reports; do not submit another copy.');
    finishAcceptedReport();
  };

  const requestClose = () => {
    if (submissionRef.current) return;
    onClose();
  };

  const resetForm = () => {
    setFileNumber('');
    setClaimNumber('');
    setPolicyNumber('');
    setAdjusterName('');
    setInsuredName('');
    setAppraiserComments('');
    setAssessmentInputs(initialAssessment());
    setImages([]);
    setProgressPhase('idle');
    setUploadProgress(0);
    submissionRef.current = false;
    setSubmitting(false);
    setErrors({});
    submissionIdRef.current = null;
    acceptedReportIdRef.current = undefined;
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={requestClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={requestClose} disabled={submitting} style={styles.closeButton} accessibilityLabel="Close salvage form">
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Salvage Appraisal</Text>
          <View style={styles.headerActions}>
            <View style={styles.headerIcon}>
              <Feather name="truck" size={20} color="#DC2626" />
            </View>
          </View>
        </View>

        {/* Progress Overlay */}
        {(progressPhase === 'uploading' || progressPhase === 'processing') && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <ActivityIndicator size="large" color="#DC2626" />
              <Text style={styles.progressTitle}>
                {progressPhase === 'uploading' ? 'Uploading...' : 'Processing...'}
              </Text>
              {progressPhase === 'uploading' && (
                <>
                  <View style={styles.progressBarContainer}>
                    <View style={[styles.progressBar, { width: `${uploadProgress}%` }]} />
                  </View>
                  <Text style={styles.progressText}>{uploadProgress}%</Text>
                  <Text style={styles.progressText}>Wait until the upload is accepted. Cancelling stops this device upload, but cannot undo work already accepted by the server.</Text>
                  <TouchableOpacity onPress={() => uploadAbortRef.current?.abort()} style={styles.submitButton} accessibilityRole="button"><Text style={styles.submitButtonText}>Cancel upload</Text></TouchableOpacity>
                </>
              )}
              {progressPhase === 'processing' && (
                <>
                  <Text style={styles.progressText}>Upload accepted. Your editable preview is being prepared. Review it before generating report files.</Text>
                  <TouchableOpacity onPress={continueInBackground} style={styles.submitButton} accessibilityRole="button">
                    <Text style={styles.submitButtonText}>Continue in background</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        )}

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.content}>
          <ScrollView
            style={styles.formScroll}
            contentContainerStyle={styles.formContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {/* Report Details Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Report Details</Text>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Report Date *</Text>
                  <TextInput
                    style={styles.input}
                    value={reportDate}
                    onChangeText={setReportDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Date Received *</Text>
                  <TextInput
                    style={styles.input}
                    value={dateReceived}
                    onChangeText={setDateReceived}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>File Number *</Text>
                <TextInput
                  style={[styles.input, errors.fileNumber && styles.inputError]}
                  value={fileNumber}
                  onChangeText={(t) => {
                    setFileNumber(t);
                    clearError('fileNumber');
                  }}
                  placeholder="Enter file number"
                  placeholderTextColor="#9CA3AF"
                />
                {errors.fileNumber && <Text style={styles.errorText}>{errors.fileNumber}</Text>}
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Claim Number *</Text>
                  <TextInput
                    style={[styles.input, errors.claimNumber && styles.inputError]}
                    value={claimNumber}
                    onChangeText={(t) => {
                      setClaimNumber(t);
                      clearError('claimNumber');
                    }}
                    placeholder="Claim #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Policy Number *</Text>
                  <TextInput
                    style={[styles.input, errors.policyNumber && styles.inputError]}
                    value={policyNumber}
                    onChangeText={(t) => {
                      setPolicyNumber(t);
                      clearError('policyNumber');
                    }}
                    placeholder="Policy #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Next Report Due</Text>
                <TextInput
                  style={styles.input}
                  value={nextReportDue}
                  onChangeText={setNextReportDue}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Canadian assessment context</Text>
              <Text style={[styles.fieldLabel, { fontWeight: '400', marginBottom: 12 }]}>Vehicle details are read from your uploaded photos. Include clear VIN / serial, engine-label and odometer photos. Review the results and add anything marked “Cannot find from image” in the preview.</Text>
              <Text style={[styles.fieldLabel, { fontWeight: '400', marginBottom: 12 }]}>Enter known market and loss details below. A documented brand must match registration or inspection evidence, not a guess from photos.</Text>
              {ASSESSMENT_CONTEXT_FIELDS.map((field) => (
                <View key={field.key} style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>{field.label}</Text>
                  <TextInput style={styles.input} accessibilityLabel={field.label} placeholder={field.placeholder} placeholderTextColor="#9CA3AF"
                    value={assessmentInputs[field.key] == null ? '' : String(assessmentInputs[field.key])}
                    autoCapitalize={field.key === 'province' || field.key === 'brandProvince' ? 'characters' : 'sentences'}
                    maxLength={field.key === 'province' || field.key === 'brandProvince' ? 2 : field.key === 'effectiveDate' ? 10 : 300}
                    onChangeText={(value) => changeAssessment(field.key, field.key === 'province' || field.key === 'brandProvince' ? value.toUpperCase() : value)} />
                </View>
              ))}
              {([['condition', 'Pre-loss condition (if known)'], ['damageDescription', 'Observed damage']] as const).map(([key, label]) => (
                <View key={key} style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>{label}</Text>
                  <TextInput style={[styles.input, styles.textArea]} accessibilityLabel={label} placeholder={label} placeholderTextColor="#9CA3AF"
                    multiline numberOfLines={2} maxLength={key === 'condition' ? 4000 : 8000}
                    value={assessmentInputs[key] || ''} onChangeText={(value) => changeAssessment(key, value)} />
                </View>
              ))}
              {errors.assessment ? <Text style={styles.errorText}>{errors.assessment}</Text> : null}
            </View>

            {/* Parties Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Parties Information</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Insured Name *</Text>
                <TextInput
                  style={[styles.input, errors.insuredName && styles.inputError]}
                  value={insuredName}
                  onChangeText={(t) => {
                    setInsuredName(t);
                    clearError('insuredName');
                  }}
                  placeholder="Enter insured name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Adjuster Name *</Text>
                <TextInput
                  style={[styles.input, errors.adjusterName && styles.inputError]}
                  value={adjusterName}
                  onChangeText={(t) => {
                    setAdjusterName(t);
                    clearError('adjusterName');
                  }}
                  placeholder="Enter adjuster name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {/* Appraiser Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Appraiser Information</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Appraiser Name *</Text>
                <TextInput
                  style={[styles.input, errors.appraiserName && styles.inputError]}
                  value={appraiserName}
                  onChangeText={(t) => {
                    setAppraiserName(t);
                    clearError('appraiserName');
                  }}
                  placeholder="Enter appraiser name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Phone *</Text>
                  <TextInput
                    style={[styles.input, errors.appraiserPhone && styles.inputError]}
                    value={appraiserPhone}
                    onChangeText={(t) => {
                      setAppraiserPhone(t);
                      clearError('appraiserPhone');
                    }}
                    placeholder="Phone"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="phone-pad"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Email *</Text>
                  <TextInput
                    style={[styles.input, errors.appraiserEmail && styles.inputError]}
                    value={appraiserEmail}
                    onChangeText={(t) => {
                      setAppraiserEmail(t);
                      clearError('appraiserEmail');
                    }}
                    placeholder="Email"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Company Name *</Text>
                <TextInput
                  style={[styles.input, errors.companyName && styles.inputError]}
                  value={companyName}
                  onChangeText={(t) => {
                    setCompanyName(t);
                    clearError('companyName');
                  }}
                  placeholder="Enter company name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Company Address *</Text>
                <TextInput
                  style={[styles.input, styles.textArea, errors.companyAddress && styles.inputError]}
                  value={companyAddress}
                  onChangeText={(t) => {
                    setCompanyAddress(t);
                    clearError('companyAddress');
                  }}
                  placeholder="Enter company address"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={2}
                />
              </View>
            </View>

            {/* Settings Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Settings</Text>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Assessment currency</Text>
                  <View style={styles.currencyContainer}>
                    <TextInput
                      style={[styles.input, styles.currencyInput]}
                      value="CAD"
                      accessibilityLabel="Assessment currency"
                      editable={false}
                    />
                  </View>
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Language</Text>
                  <View style={styles.languageRow}>
                    {(['en', 'fr', 'es'] as const).map((lang) => (
                      <TouchableOpacity
                        key={lang}
                        style={[styles.langButton, language === lang && styles.langButtonActive]}
                        onPress={() => setLanguage(lang)}>
                        <Text style={[styles.langText, language === lang && styles.langTextActive]}>
                          {lang.toUpperCase()}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </View>
            </View>

            {/* Comments Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Comments</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Appraiser Comments *</Text>
                <TextInput
                  style={[styles.input, styles.textAreaLarge, errors.appraiserComments && styles.inputError]}
                  value={appraiserComments}
                  onChangeText={(t) => {
                    setAppraiserComments(t);
                    clearError('appraiserComments');
                  }}
                  placeholder="Enter detailed comments about the salvage..."
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={5}
                />
              </View>
            </View>

            {/* Images Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Images</Text>

              <TouchableOpacity
                style={[styles.addImageButton, errors.images && styles.addImageButtonError]}
                disabled={images.length >= SALVAGE_IMAGE_LIMIT}
                onPress={pickImages}>
                <Feather name="image" size={24} color="#DC2626" />
                <Text style={styles.addImageText}>Add Images ({images.length}/{SALVAGE_IMAGE_LIMIT})</Text>
              </TouchableOpacity>
              {errors.images && <Text style={styles.errorText}>{errors.images}</Text>}

              {images.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.imagePreviewScroll}>
                  {images.map((img, index) => (
                    <View key={index} style={styles.imagePreviewContainer}>
                      <Image source={{ uri: img.uri }} style={styles.imagePreview} />
                      <TouchableOpacity
                        style={styles.removeImageButton}
                        onPress={() => removeImage(index)}>
                        <Feather name="x" size={14} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>

            {/* Submit Button */}
            <TouchableOpacity
              style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={submitting}>
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Text style={styles.submitButtonText}>Upload & prepare preview</Text>
                  <Feather name="send" size={18} color="#fff" />
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  closeButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    flex: 1,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FEE2E2',
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  formScroll: {
    flex: 1,
  },
  formContent: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 24,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 12,
  },
  fieldContainer: {
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1F2937',
  },
  inputError: {
    borderColor: '#EF4444',
  },
  textArea: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  textAreaLarge: {
    minHeight: 120,
    textAlignVertical: 'top',
  },
  errorText: {
    fontSize: 12,
    color: '#EF4444',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
  },
  currencyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  currencyInput: {
    flex: 1,
  },
  currencyLoader: {
    marginLeft: 8,
  },
  languageRow: {
    flexDirection: 'row',
    gap: 8,
  },
  langButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
  },
  langButtonActive: {
    backgroundColor: '#DC2626',
    borderColor: '#DC2626',
  },
  langText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  langTextActive: {
    color: '#fff',
  },
  addImageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#DC2626',
    borderRadius: 12,
    backgroundColor: '#FEF2F2',
    gap: 8,
  },
  addImageButtonError: {
    borderColor: '#EF4444',
  },
  addImageText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#DC2626',
  },
  imagePreviewScroll: {
    marginTop: 12,
  },
  imagePreviewContainer: {
    marginRight: 8,
    position: 'relative',
  },
  imagePreview: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  removeImageButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
  },
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 320,
    alignItems: 'center',
  },
  progressTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    marginTop: 16,
    marginBottom: 12,
  },
  progressBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#DC2626',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 8,
    textAlign: 'center',
  },
});

export default SalvageFormSheet;
