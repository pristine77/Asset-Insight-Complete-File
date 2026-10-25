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
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../context/AuthContext';
import realEstateService, { RealEstateDetails, FarmlandDetails } from '../../services/realEstateService';
import { REAL_ESTATE_MAIN_IMAGE_LIMIT, REAL_ESTATE_EXTRA_IMAGE_LIMIT, remainingImageSlots, type ReportUploadImage } from '../../services/reportUploadPolicy';
import { pollAcceptedReport } from '../../services/reportProgressPolling';

interface RealEstateFormSheetProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const initialFarmland = (): FarmlandDetails => ({ use_direct_comparable: true, use_income_approach: false, use_cost_approach: false });

const RealEstateFormSheet: React.FC<RealEstateFormSheetProps> = ({ visible, onClose, onSuccess }) => {
  const { user } = useAuth();

  // Property type
  const [propertyType, setPropertyType] = useState<'residential' | 'commercial' | 'agricultural'>('residential');
  const [language, setLanguage] = useState<'en' | 'fr' | 'es'>('en');

  // Property Details
  const [ownerName, setOwnerName] = useState('');
  const [address, setAddress] = useState('');
  const [landDescription, setLandDescription] = useState('');
  const [municipality, setMunicipality] = useState('');
  const [titleNumber, setTitleNumber] = useState('');
  const [parcelNumber, setParcelNumber] = useState('');
  const [landAreaAcres, setLandAreaAcres] = useState('');

  // Report Dates
  const [reportDate, setReportDate] = useState(isoDate(new Date()));
  const [effectiveDate, setEffectiveDate] = useState(isoDate(new Date()));
  const [inspectionDate, setInspectionDate] = useState(isoDate(new Date()));

  // House Details
  const [yearBuilt, setYearBuilt] = useState('');
  const [squareFootage, setSquareFootage] = useState('');
  const [lotSizeSqft, setLotSizeSqft] = useState('');
  const [numberOfRooms, setNumberOfRooms] = useState('');
  const [numberOfFullBathrooms, setNumberOfFullBathrooms] = useState('');
  const [numberOfHalfBathrooms, setNumberOfHalfBathrooms] = useState('');
  const [knownIssues, setKnownIssues] = useState('');
  const [farmland, setFarmland] = useState<FarmlandDetails>(initialFarmland);
  const [farmlandNumbers, setFarmlandNumbers] = useState<Record<string, string>>({});

  // Inspector Info
  const [inspectorName, setInspectorName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [credentials, setCredentials] = useState('');

  // Images state
  const [images, setImages] = useState<Array<{ uri: string; name: string; type: string }>>([]);
  const [mapImage, setMapImage] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [extraImages, setExtraImages] = useState<ReportUploadImage[]>([]);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle');
  const submissionRef = useRef(false);
  const stopPollingRef = useRef<(() => void) | null>(null);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible) {
      setInspectorName((user as any)?.username || '');
      setContactEmail((user as any)?.email || '');
      setCompanyName((user as any)?.companyName || '');
      setContactPhone((user as any)?.contactPhone || '');
    }
  }, [user, visible]);

  // Dispose polling when the sheet hides as well as on unmount.
  useEffect(() => {
    if (!visible) stopPollingRef.current?.();
    return () => {
      stopPollingRef.current?.();
    };
  }, [visible]);

  const clearError = (field: string) => {
    setErrors((prev) => {
      const { [field]: _, ...rest } = prev;
      return rest;
    });
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!ownerName.trim()) newErrors.ownerName = 'Required';
    if (!address.trim()) newErrors.address = 'Required';
    if (!inspectorName.trim()) newErrors.inspectorName = 'Required';
    if (!contactEmail.trim()) newErrors.contactEmail = 'Required';
    if (images.length === 0) newErrors.images = 'At least one image required';
    if (propertyType === 'agricultural') {
      if (!farmland.use_direct_comparable && !farmland.use_income_approach && !farmland.use_cost_approach) {
        newErrors.farmland = 'Select at least one valuation approach.';
      }
      for (const [key, text] of Object.entries(farmlandNumbers)) {
        if (!text.trim()) continue;
        const value = Number(text);
        if (!Number.isFinite(value) || value < 0 || (key === 'cap_rate' && value <= 0) || (['vacancy_loss_percent', 'operating_expense_ratio', 'cap_rate'].includes(key) && value > 100)) {
          newErrors.farmland = 'Use non-negative numbers; percentages must be at most 100 and capitalization rate must be greater than zero.';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const pickImages = async () => {
    const remaining = remainingImageSlots(images.length, REAL_ESTATE_MAIN_IMAGE_LIMIT);
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
        setImages((prev) => [...prev, ...newImages].slice(0, REAL_ESTATE_MAIN_IMAGE_LIMIT));
        clearError('images');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick images');
    }
  };

  const pickMapImage = async () => {
    if (!mapImage && extraImages.length >= REAL_ESTATE_EXTRA_IMAGE_LIMIT) {
      Alert.alert('Photo limit reached', 'Remove a report-only photo before adding a map.');
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setMapImage({
          uri: asset.uri,
          name: asset.fileName || `map_${Date.now()}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        });
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick map image');
    }
  };

  const pickExtraImages = async () => {
    const remaining = remainingImageSlots(extraImages.length + (mapImage ? 1 : 0), REAL_ESTATE_EXTRA_IMAGE_LIMIT);
    if (!remaining) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: remaining,
      });
      if (!result.canceled) {
        const selected = result.assets.map((asset, index) => ({
          uri: asset.uri,
          name: asset.fileName || `extra_${Date.now()}_${index}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        }));
        setExtraImages((previous) => [...previous, ...selected].slice(0, REAL_ESTATE_EXTRA_IMAGE_LIMIT - (mapImage ? 1 : 0)));
      }
    } catch {
      Alert.alert('Error', 'Failed to pick report-only photos');
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const startPolling = (id: string) => {
    stopPollingRef.current?.();
    stopPollingRef.current = pollAcceptedReport({
      load: () => realEstateService.getProgress(id),
      onDone: () => {
        Alert.alert('Preview ready', 'Your real estate preview is ready. Review it in Previews before submitting for approval.');
        finishAcceptedReport();
      },
      onError: (message) => {
        submissionRef.current = false;
        setSubmitting(false);
        setProgressPhase('error');
        Alert.alert('Generation failed', message);
      },
      onPending: continueInBackground,
    });
  };

  const handleSubmit = async () => {
    if (submissionRef.current) return;
    if (!validateForm()) {
      Alert.alert('Error', 'Please fill all required fields');
      return;
    }

    submissionRef.current = true;
    setSubmitting(true);
    setProgressPhase('uploading');
    setUploadProgress(0);

    try {
      const details: RealEstateDetails = {
        language,
        property_type: propertyType,
        property_details: {
          owner_name: ownerName,
          address,
          land_description: landDescription,
          municipality,
          title_number: titleNumber,
          parcel_number: parcelNumber,
          land_area_acres: landAreaAcres,
          source_quarter_section: '',
        },
        report_dates: {
          report_date: reportDate,
          effective_date: effectiveDate,
          inspection_date: inspectionDate,
        },
        house_details: {
          year_built: yearBuilt,
          square_footage: squareFootage,
          lot_size_sqft: lotSizeSqft,
          number_of_rooms: numberOfRooms,
          number_of_full_bathrooms: numberOfFullBathrooms,
          number_of_half_bathrooms: numberOfHalfBathrooms,
          known_issues: knownIssues.split(',').map((s) => s.trim()).filter(Boolean),
        },
        ...(propertyType === 'agricultural' ? {
          farmland_details: {
            ...farmland,
            ...Object.fromEntries(Object.entries(farmlandNumbers).filter(([, value]) => value.trim()).map(([key, value]) => [key, Number(value)])),
          },
        } : {}),
        inspector_info: {
          inspector_name: inspectorName,
          company_name: companyName,
          contact_email: contactEmail,
          contact_phone: contactPhone,
          credentials,
        },
      };

      const response = await realEstateService.create(
        details,
        images,
        mapImage || undefined,
        (progress) => {
          setUploadProgress(progress);
        },
        extraImages
      );

      if (response.jobId) {
        setProgressPhase('processing');
        startPolling(response.jobId);
      } else {
        setProgressPhase('done');
        Alert.alert('Submission accepted', response.message || 'The server accepted your report. Check Previews for progress.');
        finishAcceptedReport();
      }
    } catch (error: any) {
      submissionRef.current = false;
      setSubmitting(false);
      setProgressPhase('error');
      Alert.alert('Error', error?.response?.data?.message || error?.message || 'Failed to submit report');
    }
  };

  const finishAcceptedReport = () => {
    stopPollingRef.current?.();
    resetForm();
    onSuccess?.();
    onClose();
  };

  const continueInBackground = () => {
    Alert.alert('Upload accepted', 'The server is preparing your preview. You will receive an email when it is ready. Check Previews before submitting again.');
    finishAcceptedReport();
  };

  const requestClose = () => {
    if (submissionRef.current) return;
    onClose();
  };

  const resetForm = () => {
    setOwnerName('');
    setAddress('');
    setLandDescription('');
    setMunicipality('');
    setTitleNumber('');
    setParcelNumber('');
    setLandAreaAcres('');
    setYearBuilt('');
    setSquareFootage('');
    setLotSizeSqft('');
    setNumberOfRooms('');
    setNumberOfFullBathrooms('');
    setNumberOfHalfBathrooms('');
    setKnownIssues('');
    setFarmland(initialFarmland());
    setFarmlandNumbers({});
    setCredentials('');
    setImages([]);
    setMapImage(null);
    setExtraImages([]);
    setProgressPhase('idle');
    setUploadProgress(0);
    submissionRef.current = false;
    setSubmitting(false);
    setErrors({});
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={requestClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={requestClose} disabled={submitting} style={styles.closeButton} accessibilityLabel="Close real estate form">
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Real Estate Appraisal</Text>
          <View style={styles.headerActions}>
            <View style={styles.headerIcon}>
              <Feather name="home" size={20} color="#2563EB" />
            </View>
          </View>
        </View>

        {/* Progress Overlay */}
        {(progressPhase === 'uploading' || progressPhase === 'processing') && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <ActivityIndicator size="large" color="#2563EB" />
              <Text style={styles.progressTitle}>
                {progressPhase === 'uploading' ? 'Uploading...' : 'Processing...'}
              </Text>
              {progressPhase === 'uploading' && (
                <>
                  <View style={styles.progressBarContainer}>
                    <View style={[styles.progressBar, { width: `${uploadProgress}%` }]} />
                  </View>
                  <Text style={styles.progressText}>{uploadProgress}%</Text>
                </>
              )}
              {progressPhase === 'processing' && (
                <>
                  <Text style={styles.progressText}>Upload accepted. Preparing your preview for review; final reports are not yet approved.</Text>
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
            {/* Property Type Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Property Type</Text>
              <View style={styles.typeRow}>
                {(['residential', 'commercial', 'agricultural'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[styles.typeButton, propertyType === type && styles.typeButtonActive]}
                    onPress={() => setPropertyType(type)}>
                    <Feather
                      name={type === 'residential' ? 'home' : type === 'commercial' ? 'briefcase' : 'sun'}
                      size={18}
                      color={propertyType === type ? '#fff' : '#6B7280'}
                    />
                    <Text style={[styles.typeText, propertyType === type && styles.typeTextActive]}>
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Property Details Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Property Details</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Owner Name *</Text>
                <TextInput
                  style={[styles.input, errors.ownerName && styles.inputError]}
                  value={ownerName}
                  onChangeText={(t) => {
                    setOwnerName(t);
                    clearError('ownerName');
                  }}
                  placeholder="Enter owner name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Property Address *</Text>
                <TextInput
                  style={[styles.input, styles.textArea, errors.address && styles.inputError]}
                  value={address}
                  onChangeText={(t) => {
                    setAddress(t);
                    clearError('address');
                  }}
                  placeholder="Enter full property address"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={2}
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Land Description</Text>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  value={landDescription}
                  onChangeText={setLandDescription}
                  placeholder="Describe the land..."
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={3}
                />
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Municipality</Text>
                  <TextInput
                    style={styles.input}
                    value={municipality}
                    onChangeText={setMunicipality}
                    placeholder="Municipality"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Land Area (Acres)</Text>
                  <TextInput
                    style={styles.input}
                    value={landAreaAcres}
                    onChangeText={setLandAreaAcres}
                    placeholder="0.00"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Title Number</Text>
                  <TextInput
                    style={styles.input}
                    value={titleNumber}
                    onChangeText={setTitleNumber}
                    placeholder="Title #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Parcel Number</Text>
                  <TextInput
                    style={styles.input}
                    value={parcelNumber}
                    onChangeText={setParcelNumber}
                    placeholder="Parcel #"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>
            </View>

            {/* Report Dates Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Report Dates</Text>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Report Date</Text>
                  <TextInput
                    style={styles.input}
                    value={reportDate}
                    onChangeText={setReportDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Effective Date</Text>
                  <TextInput
                    style={styles.input}
                    value={effectiveDate}
                    onChangeText={setEffectiveDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#9CA3AF"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Inspection Date</Text>
                <TextInput
                  style={styles.input}
                  value={inspectionDate}
                  onChangeText={setInspectionDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {/* House Details Section (for residential) */}
            {propertyType === 'residential' && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>House Details</Text>

                <View style={styles.row}>
                  <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.fieldLabel}>Year Built</Text>
                    <TextInput
                      style={styles.input}
                      value={yearBuilt}
                      onChangeText={setYearBuilt}
                      placeholder="2000"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                    <Text style={styles.fieldLabel}>Square Footage</Text>
                    <TextInput
                      style={styles.input}
                      value={squareFootage}
                      onChangeText={setSquareFootage}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.fieldLabel}>Lot Size (sqft)</Text>
                    <TextInput
                      style={styles.input}
                      value={lotSizeSqft}
                      onChangeText={setLotSizeSqft}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                    <Text style={styles.fieldLabel}>Rooms</Text>
                    <TextInput
                      style={styles.input}
                      value={numberOfRooms}
                      onChangeText={setNumberOfRooms}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <View style={styles.row}>
                  <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                    <Text style={styles.fieldLabel}>Full Bathrooms</Text>
                    <TextInput
                      style={styles.input}
                      value={numberOfFullBathrooms}
                      onChangeText={setNumberOfFullBathrooms}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                    <Text style={styles.fieldLabel}>Half Bathrooms</Text>
                    <TextInput
                      style={styles.input}
                      value={numberOfHalfBathrooms}
                      onChangeText={setNumberOfHalfBathrooms}
                      placeholder="0"
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <View style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>Known Issues (comma separated)</Text>
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    value={knownIssues}
                    onChangeText={setKnownIssues}
                    placeholder="e.g., Roof leak, Foundation crack"
                    placeholderTextColor="#9CA3AF"
                    multiline
                    numberOfLines={2}
                  />
                </View>
              </View>
            )}

            {/* Inspector Info Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Inspector Information</Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Inspector Name *</Text>
                <TextInput
                  style={[styles.input, errors.inspectorName && styles.inputError]}
                  value={inspectorName}
                  onChangeText={(t) => {
                    setInspectorName(t);
                    clearError('inspectorName');
                  }}
                  placeholder="Enter inspector name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Company Name</Text>
                <TextInput
                  style={styles.input}
                  value={companyName}
                  onChangeText={setCompanyName}
                  placeholder="Enter company name"
                  placeholderTextColor="#9CA3AF"
                />
              </View>

              <View style={styles.row}>
                <View style={[styles.fieldContainer, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.fieldLabel}>Email *</Text>
                  <TextInput
                    style={[styles.input, errors.contactEmail && styles.inputError]}
                    value={contactEmail}
                    onChangeText={(t) => {
                      setContactEmail(t);
                      clearError('contactEmail');
                    }}
                    placeholder="Email"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
                <View style={[styles.fieldContainer, { flex: 1, marginLeft: 8 }]}>
                  <Text style={styles.fieldLabel}>Phone</Text>
                  <TextInput
                    style={styles.input}
                    value={contactPhone}
                    onChangeText={setContactPhone}
                    placeholder="Phone"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="phone-pad"
                  />
                </View>
              </View>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Credentials</Text>
                <TextInput
                  style={styles.input}
                  value={credentials}
                  onChangeText={setCredentials}
                  placeholder="e.g., CRA, MAI"
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            {propertyType === 'agricultural' && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Farmland & valuation approaches</Text>
                {errors.farmland ? <Text style={styles.errorText}>{errors.farmland}</Text> : null}
                {([
                  ['total_title_acres', 'Total title acres', true],
                  ['cultivated_acres', 'Cultivated acres', true],
                  ['rm_area', 'Rural municipality / area', false],
                  ['soil_class', 'Soil class', false],
                  ['crop_type', 'Crop type', false],
                  ['distance_to_city_km', 'Distance to city (km)', true],
                  ['annual_rent_per_acre', 'Annual rent per acre', true],
                  ['notes', 'Farmland notes', false],
                  ['subject_name', 'Valuation subject name', false],
                  ['valuation_date', 'Valuation date (YYYY-MM-DD)', false],
                ] as const).map(([key, label, numeric]) => (
                  <View key={key} style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <TextInput
                      accessibilityLabel={label}
                      style={styles.input}
                      value={numeric ? farmlandNumbers[key] || '' : String(farmland[key] ?? '')}
                      keyboardType={numeric ? 'decimal-pad' : 'default'}
                      onChangeText={(value) => {
                        clearError('farmland');
                        if (numeric) setFarmlandNumbers((previous) => ({ ...previous, [key]: value }));
                        else setFarmland((previous) => ({ ...previous, [key]: value }));
                      }}
                    />
                  </View>
                ))}
                {([
                  ['is_rented', 'Currently rented'],
                  ['irrigation', 'Irrigation'],
                  ['use_direct_comparable', 'Direct comparable approach'],
                  ['use_income_approach', 'Income approach'],
                  ['use_cost_approach', 'Cost approach'],
                ] as const).map(([key, label]) => (
                  <View key={key} style={[styles.row, { alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }]}>
                    <Text style={[styles.fieldLabel, { flex: 1 }]}>{label}</Text>
                    <Switch accessibilityLabel={label} value={farmland[key] === true} onValueChange={(value) => setFarmland((previous) => ({ ...previous, [key]: value }))} />
                  </View>
                ))}
                {farmland.use_income_approach && ([
                  ['market_rent_per_acre', 'Market rent per acre'],
                  ['vacancy_loss_percent', 'Vacancy loss (%)'],
                  ['operating_expense_ratio', 'Operating expense ratio (%)'],
                  ['cap_rate', 'Capitalization rate (%)'],
                ] as const).map(([key, label]) => (
                  <View key={key} style={styles.fieldContainer}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <TextInput accessibilityLabel={label} style={styles.input} value={farmlandNumbers[key] || ''} keyboardType="decimal-pad" onChangeText={(value) => {
                      clearError('farmland');
                      setFarmlandNumbers((previous) => ({ ...previous, [key]: value }));
                    }} />
                  </View>
                ))}
              </View>
            )}

            {/* Settings Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Settings</Text>

              <View style={styles.fieldContainer}>
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

            {/* Images Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Property Images</Text>

              <TouchableOpacity
                style={[styles.addImageButton, errors.images && styles.addImageButtonError]}
                disabled={images.length >= REAL_ESTATE_MAIN_IMAGE_LIMIT}
                onPress={pickImages}>
                <Feather name="image" size={24} color="#2563EB" />
                <Text style={styles.addImageText}>Add Images ({images.length}/{REAL_ESTATE_MAIN_IMAGE_LIMIT})</Text>
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

              <View style={styles.mapSection}>
                <Text style={styles.fieldLabel}>Report-only photos (not analyzed)</Text>
                <TouchableOpacity style={styles.addMapButton} onPress={pickExtraImages} disabled={extraImages.length + (mapImage ? 1 : 0) >= REAL_ESTATE_EXTRA_IMAGE_LIMIT}>
                  <Feather name="image" size={20} color="#2563EB" />
                  <Text style={styles.addMapText}>Add report-only photos ({extraImages.length + (mapImage ? 1 : 0)}/{REAL_ESTATE_EXTRA_IMAGE_LIMIT}, including map)</Text>
                </TouchableOpacity>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.imagePreviewScroll}>
                  {extraImages.map((image, index) => (
                    <View key={`${image.uri}-${index}`} style={styles.imagePreviewContainer}>
                      <Image source={{ uri: image.uri }} style={styles.imagePreview} />
                      <TouchableOpacity accessibilityLabel={`Remove report-only photo ${index + 1}`} style={styles.removeImageButton} onPress={() => setExtraImages((previous) => previous.filter((_, position) => position !== index))}>
                        <Feather name="x" size={14} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              </View>

              {/* Map Image */}
              <View style={styles.mapSection}>
                <Text style={styles.fieldLabel}>Map/Survey Image (Optional)</Text>
                <TouchableOpacity style={styles.addMapButton} onPress={pickMapImage}>
                  <Feather name="map" size={20} color="#2563EB" />
                  <Text style={styles.addMapText}>
                    {mapImage ? 'Change Map Image' : 'Add Map Image'}
                  </Text>
                </TouchableOpacity>
                {mapImage && (
                  <View style={styles.mapPreviewContainer}>
                    <Image source={{ uri: mapImage.uri }} style={styles.mapPreview} />
                    <TouchableOpacity
                      style={styles.removeMapButton}
                      onPress={() => setMapImage(null)}>
                      <Feather name="x" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>

            {/* Submit Button */}
            <TouchableOpacity
              accessibilityLabel="Submit real estate report"
              style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={submitting}>
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Text style={styles.submitButtonText}>Submit Report</Text>
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
    backgroundColor: '#DBEAFE',
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
  typeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  typeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    gap: 6,
  },
  typeButtonActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  typeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  typeTextActive: {
    color: '#fff',
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
  errorText: {
    fontSize: 12,
    color: '#EF4444',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
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
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
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
    borderColor: '#2563EB',
    borderRadius: 12,
    backgroundColor: '#EFF6FF',
    gap: 8,
  },
  addImageButtonError: {
    borderColor: '#EF4444',
  },
  addImageText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2563EB',
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
  mapSection: {
    marginTop: 16,
  },
  addMapButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#2563EB',
    borderRadius: 8,
    backgroundColor: '#fff',
    gap: 8,
  },
  addMapText: {
    flexShrink: 1,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
    color: '#2563EB',
  },
  mapPreviewContainer: {
    marginTop: 12,
    position: 'relative',
    alignSelf: 'flex-start',
  },
  mapPreview: {
    width: 120,
    height: 120,
    borderRadius: 8,
  },
  removeMapButton: {
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
    backgroundColor: '#2563EB',
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
    backgroundColor: '#2563EB',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 8,
    textAlign: 'center',
  },
});

export default RealEstateFormSheet;
