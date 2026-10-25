# Salvage ruby-glass artwork

`salvage-ruby-glass.png` is a bundled, design-time decorative asset generated with the built-in image generation tool on 2026-09-08. It contains no report text, logo, vehicle, or evidence photo. Production embeds it locally as a data URL: full strength behind the cover and at 11% opacity behind inner-page content. There is no runtime AI call or external asset request.

The file has a pearl-white background, not an alpha channel. Transparency in report stationery is applied in CSS, not baked into source media. An initial attempt contained a simulated checkerboard and was rejected. Only the corrected clean artwork is shipped.

Do not composite this decoration into uploaded photos or alter stored media. Keep real report text, the authentic logo, and photograph pixels separate from the artwork. Verify the complete PDF after any artwork or styling change.

## Generation prompt

Use case: background-extraction
Asset type: transparent decorative artwork layer for an A4 portrait PDF cover and subtle inner-page stationery.
Input image 1: approved Salvage Report concept; use ONLY its sculptural red-glass ribbon material, highlight/refraction effects and sweeping composition as the reference. This is not a new report mockup.
Primary request: Recreate only the beautiful looping crimson glass ribbon and subtle clear pearl-glass curved sheets visible behind the photos. Remove ALL text, logos including faint ghost logos, cars, photographs, rectangular photo frames/cards, and metadata panels, leaving a reusable transparent 3D decorative asset. Continue the ribbon naturally through areas previously hidden by those elements.
Composition: portrait A4 ratio. Ribbon enters from the upper-right edge, bends broadly down the right side and loops across the lower half toward the lower-left edge, like the reference. Keep the upper-left 60% of the page spacious and transparent for title and branding. Clear curved acrylic/pearl sheet contours may cross behind the ribbon. The middle will later hold real photographs, so prioritize the perimeter sweep and lower loop.
Material and lighting: rich transparent ruby/crimson glass, convincing layered optical thickness, rounded polished edges, bright narrow specular glints, internal red refractions, fine caustic highlights and soft ambient shadows. Not flat vector polygons. Elegant smooth sculpted glass with real depth, matching the approved concept closely.
Output: ONLY the decorative cutout on a genuinely transparent background with alpha channel; empty regions truly transparent, no white or grey backdrop and no checkerboard baked into pixels. Preserve translucent alpha and delicate glints at edges.
Avoid: all lettering, logos, watermarks, vehicles, photo frames, cards, UI elements, mockup perspective, floor or environment. Do not reproduce or invent any report information.

## Final corrective edit prompt

Use case: precise-object-edit
Edit target: this decorative red-glass ribbon artwork. Keep the ribbon geometry, rich translucent red material, polished highlights, optical depth, white clear-glass curves and A4 portrait layout unchanged.
Change only the background: completely REMOVE the grey checkerboard pattern, including the pattern distorted through the transparent glass, and replace it with a perfectly clean luminous pearl-white (#ffffff) studio backdrop. The empty top-left and center should be clean white with only very soft pearl light, no grey blocks or grid anywhere. Glass should show smooth optical reflections/refraction of white, never a checkerboard. It will be composited at reduced opacity in our PDF code; the image itself should have a white background, not simulated transparency.
No text, no logo, no faint watermark, no car, no photos, no panels, no photo frames. Preserve the red sculpture and beautiful highlights exactly.
