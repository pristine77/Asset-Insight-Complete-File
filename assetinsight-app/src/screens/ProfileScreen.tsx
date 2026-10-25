import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "../context/AuthContext";
import { useAppTheme, type AppThemeColors } from "../context/ThemeContext";
import api from "../services/api";
import AccountPrivacyLinks from "../components/AccountPrivacyLinks";
import CaptureBackupPanel from '../components/CaptureBackupPanel';

interface ProfileScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
}

const CRM_QUADRANT_OPTIONS = ["NW", "NE", "SW", "SE", "NORTH", "SOUTH", "EAST", "WEST", "CENTRAL"] as const;
const CRM_SPECIALIZATION_OPTIONS = [
  { value: "industrial_construction", label: "Industrial & Construction" },
  { value: "farm_equipment_sales", label: "Farm & Farm Equipment Sales" },
  { value: "others", label: "Others" },
] as const;

function parseCrmQuadrants(value?: string): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

const ProfileScreen = ({ onOpenDrawer, onBack }: ProfileScreenProps) => {
  const { user, refreshUser } = useAuth();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const [formData, setFormData] = useState({
    username: "",
    companyName: "",
    contactEmail: "",
    contactPhone: "",
    companyAddress: "",
    crmAddress: "",
    crmQuadrant: [] as string[],
    crmSpecializations: [] as string[],
  });

  useEffect(() => {
    if (user) {
      setFormData({
        username: user.username || "",
        companyName: user.companyName || "",
        contactEmail: user.contactEmail || "",
        contactPhone: user.contactPhone || "",
        companyAddress: user.companyAddress || "",
        crmAddress: user.crmAddress || "",
        crmQuadrant: parseCrmQuadrants(user.crmQuadrant),
        crmSpecializations: Array.isArray(user.crmSpecializations) ? user.crmSpecializations : [],
      });
    }
  }, [user]);

  const handleQuadrantPress = (value: string) => {
    if (!isEditing) return;
    setFormData((prev) => ({
      ...prev,
      crmQuadrant: prev.crmQuadrant.includes(value)
        ? prev.crmQuadrant.filter((item) => item !== value)
        : [...prev.crmQuadrant, value],
    }));
  };

  const handleSpecializationPress = (value: string) => {
    if (!isEditing) return;
    setFormData((prev) => ({
      ...prev,
      crmSpecializations: prev.crmSpecializations.includes(value)
        ? prev.crmSpecializations.filter((item) => item !== value)
        : [...prev.crmSpecializations, value],
    }));
  };

  const handleSave = async () => {
    try {
      if (user?.isCrmAgent && formData.crmQuadrant.length === 0) {
        Alert.alert("Quadrant required", "Please choose at least one CRM quadrant.");
        return;
      }

      if (user?.isCrmAgent && formData.crmSpecializations.length === 0) {
        Alert.alert("Specialization required", "Please choose at least one CRM specialization.");
        return;
      }

      setSaving(true);
      await api.patch("/user", formData);
      await refreshUser();
      Alert.alert("Success", "Profile updated successfully");
      setIsEditing(false);
    } catch (error: any) {
      Alert.alert("Error", error.response?.data?.message || "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (user) {
      setFormData({
        username: user.username || "",
        companyName: user.companyName || "",
        contactEmail: user.contactEmail || "",
        contactPhone: user.contactPhone || "",
        companyAddress: user.companyAddress || "",
        crmAddress: user.crmAddress || "",
        crmQuadrant: parseCrmQuadrants(user.crmQuadrant),
        crmSpecializations: Array.isArray(user.crmSpecializations) ? user.crmSpecializations : [],
      });
    }
    setIsEditing(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.appBar}>
            <TouchableOpacity onPress={onOpenDrawer} style={styles.appBarButton} activeOpacity={0.72}>
              <Feather name="menu" size={20} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.appBarCopy}>
              <Text style={styles.appBarEyebrow}>ACCOUNT</Text>
              <Text style={styles.appBarTitle}>Profile</Text>
            </View>
            <TouchableOpacity onPress={onBack} style={styles.appBarButton} activeOpacity={0.72}>
              <Feather name="arrow-left" size={19} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.profileCard}>
            <View style={styles.avatarContainer}>
              <Text style={styles.avatarText}>
                {(user?.username || user?.email || "U")[0].toUpperCase()}
              </Text>
              <View style={styles.avatarBadge}>
                <Feather name="check" size={11} color="#FFFFFF" />
              </View>
            </View>
            <View style={styles.profileCopy}>
              <Text style={styles.avatarName} numberOfLines={1}>
                {user?.username || user?.email?.split("@")[0] || "User"}
              </Text>
              <Text style={styles.avatarEmail} numberOfLines={1}>{user?.email}</Text>
              <Text style={styles.profileRole}>{user?.isCrmAgent ? "CRM & Listings" : "Listings"}</Text>
            </View>
            {!isEditing && (
              <TouchableOpacity onPress={() => setIsEditing(true)} style={styles.editProfileBtn}>
                <Feather name="edit-2" size={15} color={colors.accent} />
              </TouchableOpacity>
            )}
          </View>

          {/* Form Fields */}
          <View style={styles.formSection}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIconBox}>
                <Feather name="user" size={16} color={colors.accent} />
              </View>
              <Text style={styles.sectionTitle}>Personal Information</Text>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Username</Text>
              <View style={[styles.fieldInputWrapper, isEditing && styles.fieldInputWrapperActive]}>
                <Feather name="at-sign" size={16} color={isEditing ? colors.accent : colors.textMuted} />
                <TextInput
                  style={styles.fieldInput}
                  value={formData.username}
                  onChangeText={(text) => setFormData({ ...formData, username: text })}
                  placeholder="Enter username"
                  placeholderTextColor={colors.textMuted}
                  editable={isEditing}
                />
              </View>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Email</Text>
              <View style={[styles.fieldInputWrapper, styles.fieldInputWrapperDisabled]}>
                <Feather name="mail" size={16} color={colors.textMuted} />
                <TextInput
                  style={[styles.fieldInput, styles.fieldInputDisabled]}
                  value={user?.email || ""}
                  editable={false}
                />
                <View style={styles.lockBadge}>
                  <Feather name="lock" size={10} color={colors.textMuted} />
                </View>
              </View>
            </View>
          </View>

          <View style={styles.formSection}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIconBox}>
                <Feather name="briefcase" size={16} color={colors.accent} />
              </View>
              <Text style={styles.sectionTitle}>Company Information</Text>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Company Name</Text>
              <View style={[styles.fieldInputWrapper, isEditing && styles.fieldInputWrapperActive]}>
                <Feather name="home" size={16} color={isEditing ? colors.accent : colors.textMuted} />
                <TextInput
                  style={styles.fieldInput}
                  value={formData.companyName}
                  onChangeText={(text) => setFormData({ ...formData, companyName: text })}
                  placeholder="Enter company name"
                  placeholderTextColor={colors.textMuted}
                  editable={isEditing}
                />
              </View>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Contact Email</Text>
              <View style={[styles.fieldInputWrapper, isEditing && styles.fieldInputWrapperActive]}>
                <Feather name="mail" size={16} color={isEditing ? colors.accent : colors.textMuted} />
                <TextInput
                  style={styles.fieldInput}
                  value={formData.contactEmail}
                  onChangeText={(text) => setFormData({ ...formData, contactEmail: text })}
                  placeholder="Enter contact email"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  editable={isEditing}
                />
              </View>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Contact Phone</Text>
              <View style={[styles.fieldInputWrapper, isEditing && styles.fieldInputWrapperActive]}>
                <Feather name="phone" size={16} color={isEditing ? colors.accent : colors.textMuted} />
                <TextInput
                  style={styles.fieldInput}
                  value={formData.contactPhone}
                  onChangeText={(text) => setFormData({ ...formData, contactPhone: text })}
                  placeholder="Enter phone number"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  editable={isEditing}
                />
              </View>
            </View>

            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Company Address</Text>
              <View style={[styles.fieldInputWrapperMultiline, isEditing && styles.fieldInputWrapperActive]}>
                <Feather name="map-pin" size={16} color={isEditing ? colors.accent : colors.textMuted} style={styles.multilineIcon} />
                <TextInput
                  style={[styles.fieldInput, styles.fieldInputMultiline]}
                  value={formData.companyAddress}
                  onChangeText={(text) => setFormData({ ...formData, companyAddress: text })}
                  placeholder="Enter company address"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  numberOfLines={3}
                  editable={isEditing}
                />
              </View>
            </View>

            {user?.isCrmAgent ? (
              <>
                <View style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>CRM Address</Text>
                  <View style={[styles.fieldInputWrapperMultiline, isEditing && styles.fieldInputWrapperActive]}>
                    <Feather
                      name="map-pin"
                      size={16}
                      color={isEditing ? colors.accent : colors.textMuted}
                      style={styles.multilineIcon}
                    />
                    <TextInput
                      style={[styles.fieldInput, styles.fieldInputMultiline]}
                      value={formData.crmAddress}
                      onChangeText={(text) => setFormData({ ...formData, crmAddress: text })}
                      placeholder="Enter CRM service area address"
                      placeholderTextColor={colors.textMuted}
                      multiline
                      numberOfLines={3}
                      editable={isEditing}
                    />
                  </View>
                </View>

                <View style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>CRM Quadrants</Text>
                  <View style={styles.quadrantWrap}>
                    {CRM_QUADRANT_OPTIONS.map((quadrant) => {
                      const selected = formData.crmQuadrant.includes(quadrant);
                      return (
                        <TouchableOpacity
                          key={quadrant}
                          style={[
                            styles.quadrantChip,
                            selected && styles.quadrantChipActive,
                            !isEditing && styles.quadrantChipDisabled,
                          ]}
                          onPress={() => handleQuadrantPress(quadrant)}
                          disabled={!isEditing}
                        >
                          <Text style={[styles.quadrantChipText, selected && styles.quadrantChipTextActive]}>{quadrant}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.fieldContainer}>
                  <Text style={styles.fieldLabel}>CRM Specialization</Text>
                  <Text style={styles.fieldHint}>Tap to choose one or more specialties.</Text>
                  <View style={styles.quadrantWrap}>
                    {CRM_SPECIALIZATION_OPTIONS.map((option) => {
                      const selected = formData.crmSpecializations.includes(option.value);
                      return (
                        <TouchableOpacity
                          key={option.value}
                          style={[
                            styles.quadrantChip,
                            selected && styles.quadrantChipActive,
                            !isEditing && styles.quadrantChipDisabled,
                          ]}
                          onPress={() => handleSpecializationPress(option.value)}
                          disabled={!isEditing}
                        >
                          <Text style={[styles.quadrantChipText, selected && styles.quadrantChipTextActive]}>
                            {option.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </>
            ) : null}
          </View>

          {/* Action Buttons */}
          {isEditing && (
            <View style={styles.actionButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleCancel}
                disabled={saving}
              >
                <Feather name="x" size={18} color={colors.textSecondary} />
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color={colors.accentText} size="small" />
                ) : (
                  <>
                    <Feather name="check" size={18} color={colors.accentText} />
                    <Text style={styles.saveButtonText}>Save Changes</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
          <CaptureBackupPanel />
          <AccountPrivacyLinks />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const createStyles = (colors: AppThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 14,
    paddingBottom: 32,
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
  },
  appBar: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  appBarButton: {
    width: 40,
    height: 40,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  appBarCopy: { flex: 1, minWidth: 0, marginHorizontal: 11 },
  appBarEyebrow: { color: colors.accent, fontSize: 8.5, fontWeight: "900", letterSpacing: 1 },
  appBarTitle: { color: colors.text, fontSize: 21, fontWeight: "900", marginTop: 1 },
  profileCard: {
    minHeight: 88,
    flexDirection: "row",
    alignItems: "center",
    padding: 13,
    marginBottom: 13,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  profileCopy: { flex: 1, minWidth: 0, marginLeft: 11 },
  profileRole: { color: colors.accent, fontSize: 9, fontWeight: "900", marginTop: 4, letterSpacing: 0.5 },
  // Hero Card - Red Theme with 3D depth
  heroCard: {
    backgroundColor: "#F43F5E",
    borderRadius: 22,
    marginBottom: 16,
    overflow: "hidden",
    shadowColor: "#F43F5E",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
  },
  heroGlow: {
    position: "absolute",
    top: -50,
    right: -50,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
  },
  heroContent: {
    padding: 18,
  },
  heroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  menuBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  heroActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  // Avatar Section inside hero
  avatarSection: {
    alignItems: "center",
  },
  avatarContainer: {
    width: 58,
    height: 58,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  avatarText: {
    fontSize: 23,
    fontWeight: "900",
    color: colors.accent,
  },
  avatarBadge: {
    position: "absolute",
    bottom: -4,
    right: -4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.success,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: colors.surface,
  },
  avatarName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900",
  },
  avatarEmail: {
    color: colors.textMuted,
    fontSize: 10.5,
    marginTop: 2,
  },
  editProfileBtn: {
    width: 40,
    height: 40,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Form Sections - Enhanced 3D Cards
  formSection: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
    gap: 10,
  },
  sectionIconBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    justifyContent: "center",
    alignItems: "center",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  fieldContainer: {
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 6,
    marginLeft: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fieldInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    gap: 10,
  },
  fieldInputWrapperActive: {
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  fieldInputWrapperDisabled: {
    backgroundColor: colors.surfaceMuted,
  },
  fieldInputWrapperMultiline: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    gap: 10,
  },
  multilineIcon: {
    marginTop: 4,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    padding: 0,
  },
  fieldInputDisabled: {
    color: colors.textMuted,
  },
  fieldInputMultiline: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  quadrantWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  fieldHint: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 8,
    marginLeft: 4,
  },
  quadrantChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  quadrantChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  quadrantChipDisabled: {
    opacity: 0.75,
  },
  quadrantChipText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: "700",
  },
  quadrantChipTextActive: {
    color: colors.accent,
  },
  lockBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
    justifyContent: "center",
    alignItems: "center",
  },
  // Action Buttons - 3D
  actionButtons: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  cancelButton: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: colors.surfaceMuted,
    borderRadius: 9,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  saveButton: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: colors.accent,
    borderRadius: 9,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  saveButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.accentText,
    letterSpacing: 0.3,
  },
});

export default ProfileScreen;
