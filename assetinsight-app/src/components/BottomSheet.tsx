import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.85;

export type FormType = "realEstate" | "salvage" | "asset" | null;

interface BottomSheetProps {
  visible: boolean;
  formType: FormType;
  onClose: () => void;
}

interface FormFieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  multiline?: boolean;
  keyboardType?: "default" | "numeric" | "email-address" | "phone-pad";
}

const FormField = ({
  label,
  placeholder,
  value,
  onChangeText,
  multiline,
  keyboardType = "default",
}: FormFieldProps) => (
  <View style={styles.fieldContainer}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput
      style={[styles.fieldInput, multiline && styles.fieldInputMultiline]}
      placeholder={placeholder}
      placeholderTextColor="#9CA3AF"
      value={value}
      onChangeText={onChangeText}
      multiline={multiline}
      numberOfLines={multiline ? 4 : 1}
      keyboardType={keyboardType}
    />
  </View>
);

const BottomSheet = ({ visible, formType, onClose }: BottomSheetProps) => {

  const getFormTitle = () => {
    switch (formType) {
      case "realEstate":
        return "Real Estate Appraisal";
      case "salvage":
        return "Salvage Appraisal";
      case "asset":
        return "Asset Appraisal";
      default:
        return "";
    }
  };

  const getFormIcon = () => {
    switch (formType) {
      case "realEstate":
        return "home";
      case "salvage":
        return "truck";
      case "asset":
        return "package";
      default:
        return "file";
    }
  };

  const getFormColor = () => {
    switch (formType) {
      case "realEstate":
        return "#2563EB";
      case "salvage":
        return "#DC2626";
      case "asset":
        return "#059669";
      default:
        return "#6B7280";
    }
  };

  const renderRealEstateForm = () => (
    <>
      <FormField
        label="Property Address"
        placeholder="Enter property address"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Property Type"
        placeholder="e.g., Residential, Commercial"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Square Footage"
        placeholder="Enter square footage"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Year Built"
        placeholder="Enter year built"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Number of Bedrooms"
        placeholder="Enter number of bedrooms"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Number of Bathrooms"
        placeholder="Enter number of bathrooms"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Lot Size"
        placeholder="Enter lot size"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Property Condition"
        placeholder="e.g., Excellent, Good, Fair, Poor"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Additional Notes"
        placeholder="Enter any additional notes"
        value=""
        onChangeText={() => {}}
        multiline
      />
    </>
  );

  const renderSalvageForm = () => (
    <>
      <FormField
        label="Vehicle/Item Description"
        placeholder="Enter description"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Make"
        placeholder="Enter make"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Model"
        placeholder="Enter model"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Year"
        placeholder="Enter year"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="VIN/Serial Number"
        placeholder="Enter VIN or serial number"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Mileage/Hours"
        placeholder="Enter mileage or hours"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Damage Description"
        placeholder="Describe the damage"
        value=""
        onChangeText={() => {}}
        multiline
      />
      <FormField
        label="Salvage Value Estimate"
        placeholder="Enter estimated value"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Location"
        placeholder="Enter current location"
        value=""
        onChangeText={() => {}}
      />
    </>
  );

  const renderAssetForm = () => (
    <>
      <FormField
        label="Asset Name/Title"
        placeholder="Enter asset name"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Category"
        placeholder="e.g., Equipment, Furniture, Electronics"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Manufacturer/Brand"
        placeholder="Enter manufacturer or brand"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Model Number"
        placeholder="Enter model number"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Serial Number"
        placeholder="Enter serial number"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Purchase Date"
        placeholder="MM/DD/YYYY"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Original Cost"
        placeholder="Enter original cost"
        value=""
        onChangeText={() => {}}
        keyboardType="numeric"
      />
      <FormField
        label="Current Condition"
        placeholder="e.g., New, Like New, Good, Fair, Poor"
        value=""
        onChangeText={() => {}}
      />
      <FormField
        label="Description"
        placeholder="Enter detailed description"
        value=""
        onChangeText={() => {}}
        multiline
      />
    </>
  );

  const renderFormFields = () => {
    switch (formType) {
      case "realEstate":
        return renderRealEstateForm();
      case "salvage":
        return renderSalvageForm();
      case "asset":
        return renderAssetForm();
      default:
        return null;
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        {/* Backdrop */}
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />

        {/* Sheet */}
        <View style={styles.sheet}>
          <SafeAreaView style={styles.sheetContent} edges={["bottom"]}>
            {/* Handle */}
            <View style={styles.handleContainer}>
              <View style={styles.handle} />
            </View>

            {/* Header */}
            <View style={styles.sheetHeader}>
              <View style={styles.headerLeft}>
                <View style={[styles.headerIcon, { backgroundColor: getFormColor() + "20" }]}>
                  <Feather name={getFormIcon() as any} size={20} color={getFormColor()} />
                </View>
                <Text style={styles.sheetTitle}>{getFormTitle()}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                <Feather name="x" size={24} color="#6B7280" />
              </TouchableOpacity>
            </View>

            {/* Form Content */}
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              style={styles.formContainer}
            >
              <ScrollView
                style={styles.formScroll}
                contentContainerStyle={styles.formScrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {renderFormFields()}

                {/* Submit Button */}
                <TouchableOpacity
                  style={[styles.submitButton, { backgroundColor: getFormColor() }]}
                  onPress={() => {
                    // TODO: Handle form submission
                    onClose();
                  }}
                >
                  <Text style={styles.submitButtonText}>Create Appraisal</Text>
                </TouchableOpacity>
              </ScrollView>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  sheet: {
    height: SHEET_HEIGHT,
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 20,
  },
  sheetContent: {
    flex: 1,
  },
  handleContainer: {
    alignItems: "center",
    paddingVertical: 12,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: "#D1D5DB",
    borderRadius: 2,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#1F2937",
  },
  closeButton: {
    padding: 4,
  },
  formContainer: {
    flex: 1,
  },
  formScroll: {
    flex: 1,
  },
  formScrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  fieldContainer: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
  },
  fieldInput: {
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#1F2937",
  },
  fieldInputMultiline: {
    minHeight: 100,
    textAlignVertical: "top",
  },
  submitButton: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  submitButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
});

export default BottomSheet;
