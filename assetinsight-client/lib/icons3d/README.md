# CSS 3D Icons for Dashboard

This directory contains SVG definitions for the 3D icons used in the dashboard.

## 🎨 Pure CSS 3D Effects

The icons use **pure CSS transforms** for 3D effects - no external libraries needed! This provides:
- ✅ Next.js 15 & React 19 compatibility
- ✅ Better performance (no Three.js overhead)
- ✅ Smaller bundle size
- ✅ Smooth animations via CSS

## Icons Available

- **buildingIcon** - Real Estate / Building icon (Emerald)
- **carIcon** - Salvage / Vehicle icon (Amber)
- **packageIcon** - Asset / Package icon (Sky)
- **chartIcon** - Reports / Analytics icon (Rose)
- **dollarIcon** - Value / Money icon (Rose)

## Usage

```tsx
import Icon3D from "@/components/common/Icon3D";
import { buildingIcon } from "@/lib/icons3d";

<Icon3D 
  file={buildingIcon} 
  color="#ffffff" 
  scale={6} 
  rotation={true} 
/>
```

## Props

- **file**: string (required) - SVG content as string
- **color**: string (optional, default: "#ffffff") - Icon color
- **scale**: number (optional, default: 6) - Size multiplier
- **rotation**: boolean (optional, default: true) - Enable floating animation
- **style**: CSSProperties (optional) - Additional inline styles
- **className**: string (optional) - Additional CSS classes

## Features

### 3D Effects
- **CSS Perspective** - `perspective: 1000px` for depth
- **Transform 3D** - `translateZ()` for pop-out effect
- **Rotation** - Subtle `rotateX()` tilt

### Animations
- **Float Animation** - Gentle up/down movement
- **Hover Effects** - Scale & brightness on hover
- **Drop Shadow** - Multi-layer shadows for depth

### Performance
- ✅ Zero JavaScript animation (pure CSS)
- ✅ Hardware accelerated transforms
- ✅ Memoized component
- ✅ No external dependencies

## Custom Animation

The `float-subtle` animation is defined in `app/globals.css`:

```css
@keyframes float-subtle {
  0%, 100% {
    transform: translateY(0px) scale(1);
  }
  50% {
    transform: translateY(-4px) scale(1.02);
  }
}
```

## Adding New Icons

1. Create a new `.ts` file with your SVG:
```ts
export const myIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="..." />
</svg>
`;
```

2. Export it from `index.ts`:
```ts
export { myIcon } from "./myIcon";
```

3. Use in your component:
```tsx
<Icon3D file={myIcon} color="#ffffff" />
```
