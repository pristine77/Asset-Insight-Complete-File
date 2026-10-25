# Real Estate Section Usage Example

This guide shows how to integrate the new **RealEstateSection** component into your `RealEstateForm.tsx`.

## Components Created

1. **PropertyTypeSelector.tsx** - Property type selection (Agricultural, Commercial, Residential)
2. **ImageManager.tsx** - Manages main images (up to 50 AI-analyzed), extra images (unlimited), and video (1)
3. **RealEstateCameraUI.tsx** - Full-featured camera with zoom, flash, orientation, photo capture, and video recording
4. **RealEstateSection.tsx** - Main component that combines all the above

## Integration Example

```tsx
import React, { useState } from "react";
import RealEstateSection, { type RealEstateProperty } from "./real-estate/RealEstateSection";

export default function RealEstateForm({ onSuccess, onCancel }: Props) {
  const [property, setProperty] = useState<RealEstateProperty | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!property) {
      toast.error("Please select a property type.");
      return;
    }

    if (!property.propertyType) {
      toast.error("Please select a property type.");
      return;
    }

    if (property.mainImages.length === 0) {
      toast.error("Please add at least one image for AI analysis.");
      return;
    }

    try {
      setSubmitting(true);

      // Prepare your payload
      const payload = {
        property_type: property.propertyType, // "agricultural" | "commercial" | "residential"
        // ... other form fields
      };

      // Combine all files for upload
      const allImages = [
        ...property.mainImages,      // First 50 will be AI analyzed
        ...property.extraImages,     // Extra images (report only, unlimited)
      ];

      const videos = property.videoFile ? [property.videoFile] : [];

      // Call your API service
      const res = await RealEstateService.create(
        payload,
        allImages,
        videos,
        {
          onUploadProgress: (fraction: number) => {
            // Handle progress
          },
        }
      );

      toast.success("Report created successfully!");
      onSuccess?.(res?.message);
    } catch (err: any) {
      toast.error(err?.message || "Failed to create report");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      {/* Your existing form fields */}
      {/* ... */}

      {/* New Real Estate Section */}
      <RealEstateSection
        value={property}
        onChange={setProperty}
        maxAIImages={50}
        downloadPrefix="real-estate-property"
      />

      {/* Submit button */}
      <button type="submit" disabled={submitting}>
        Submit Report
      </button>
    </form>
  );
}
```

## Features

### Property Type Selection
- **Agricultural Land**: Direct Comparison Approach
- **Commercial Property**: Income Capitalization Approach
- **Residential Property**: Direct Comparison + Cost Approach

### Image Management
- **Main Images** (AI Analyzing):
  - Up to 50 images
  - These will be analyzed by AI
  - Can be captured via camera or uploaded
  - Download all as ZIP
  
- **Extra Images** (Report Only):
  - Unlimited images
  - Won't be AI analyzed
  - Included in final report
  - Can be captured via camera or uploaded
  - Download all as ZIP

### Video
- **1 video allowed**
- Can be recorded via camera or uploaded
- Shown in report but not AI analyzed

### Camera Features
- **Photo Capture**: Tap camera button
- **Video Recording**: Tap video button (shows timer)
- **Flash/Torch**: Toggle on/off
- **Zoom**: 1x to 3x digital zoom
- **Orientation**: Switch between portrait and landscape
- **Session Management**: Captures accumulated, added on "Done"

## Backend Updates Needed

### 1. Update Type Definitions
```typescript
// In your RealEstateDetails or similar type
type RealEstateDetails = {
  property_type?: "agricultural" | "commercial" | "residential";
  // ... existing fields
};
```

### 2. Update API Service
```typescript
// Modify your create function to accept videos
async function create(
  details: RealEstateDetails,
  images: File[],
  videos?: File[],
  options?: { onUploadProgress?: (fraction: number) => void }
) {
  const formData = new FormData();
  
  // Add details
  formData.append("details", JSON.stringify(details));
  
  // Add images (backend will analyze first 50)
  images.forEach((file) => {
    formData.append("images", file);
  });
  
  // Add videos
  if (videos) {
    videos.forEach((file) => {
      formData.append("videos", file);
    });
  }
  
  // Upload with progress tracking
  return await uploadWithProgress("/api/real-estate", formData, options);
}
```

### 3. Backend Job Processing
```typescript
// In your backend job/controller
async function processRealEstateReport(input: JobInput) {
  const { details, images, videos } = input;
  
  // Take first 50 images for AI analysis
  const imagesToAnalyze = images.slice(0, 50);
  const extraImages = images.slice(50);
  
  // Run AI analysis on first 50
  const aiResults = await analyzeImages(imagesToAnalyze, details.property_type);
  
  // Include all images in report
  // Include video in report (if provided)
  
  // Generate report based on property type
  const reportData = {
    ...details,
    ai_results: aiResults,
    all_images: [...imagesToAnalyze, ...extraImages],
    videos: videos,
  };
  
  await generateReport(reportData);
}
```

## Property Type Specific Logic

You can add property-type-specific behavior in your backend:

```typescript
function getValuationApproach(propertyType: PropertyType) {
  switch (propertyType) {
    case "agricultural":
      return {
        primary: "Direct Comparison Approach",
        description: "Compares with similar agricultural land sales",
      };
    case "commercial":
      return {
        primary: "Income Capitalization Approach",
        supporting: "Direct Comparison",
        description: "Focuses on income potential and market comparables",
      };
    case "residential":
      return {
        primary: "Direct Comparison",
        supporting: "Cost Approach",
        description: "Market comparables with cost analysis for unique features",
      };
  }
}
```

## Notes

1. **Max AI Images**: The first 50 images will be analyzed. Extra images are report-only.
2. **Video Limit**: Only 1 video is allowed per property.
3. **Camera Session**: All photos/videos captured in a camera session are added when you tap "Done".
4. **Download Feature**: Users can download all main images or all extra images as a ZIP file.
5. **Property Type Required**: Users must select a property type before adding images.

## Next Steps

1. Integrate `RealEstateSection` into your existing `RealEstateForm`
2. Update backend API to accept `property_type` field
3. Update backend to handle video uploads
4. Implement property-type-specific valuation logic
5. Test the complete flow end-to-end
