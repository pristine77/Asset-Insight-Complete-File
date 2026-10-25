import React, { forwardRef } from 'react';
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';

/** A stable native input: never create field component types inside a form render. */
const ListingTextInput = forwardRef<TextInput, TextInputProps>(function ListingTextInput(
  { style, multiline, accessibilityLabel, placeholder, ...props }, ref,
) {
  return (
    <TextInput
      ref={ref}
      multiline={multiline}
      accessibilityLabel={accessibilityLabel || placeholder}
      placeholder={placeholder}
      textAlignVertical={multiline ? 'top' : 'center'}
      scrollEnabled={multiline}
      submitBehavior={multiline ? 'newline' : 'blurAndSubmit'}
      {...props}
      style={[styles.control, multiline && styles.multiline, style]}
    />
  );
});

const styles = StyleSheet.create({
  control: { minHeight: 44, minWidth: 0 },
  multiline: { minHeight: 88, maxHeight: 200, textAlignVertical: 'top' },
});

export default ListingTextInput;
