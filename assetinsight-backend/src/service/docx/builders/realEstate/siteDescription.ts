import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  ImageRun,
  BorderStyle,
} from "docx";
import { goldDivider, fetchImageBuffer } from "../utils.js";

/**
 * 7.0 SITE DESCRIPTION
 * Resolves property-type facts, then appends a bounded evidence gallery. Facts
 * retain chapter order when images fail; photo limits and grid geometry bound
 * network work, document size, and pagination variance.
 */
export async function buildSiteDescription(
  reportData: any,
  contentWidthTw: number,
  imageUrls?: string[]
): Promise<(Paragraph | Table)[]> {
  const children: (Paragraph | Table)[] = [];
  const propertyType = reportData?.property_type || "residential";
  const addr = reportData?.address || reportData?.property_address || 
    reportData?.property_details?.address || "";
  const municipality = reportData?.municipality || reportData?.city || 
    reportData?.property_details?.municipality || "";
  
  // Extract property details based on type
  const houseDetails = reportData?.house_details || {};
  const farmlandDetails = reportData?.farmland_details || {};
  
  const isAgricultural = propertyType === "agricultural" || propertyType === "farmland";
  const lotSize = isAgricultural ? farmlandDetails?.total_title_acres || "" : houseDetails?.lot_size_sqft || "";
  const sqft = houseDetails?.square_footage || "";
  
  // Four images fill the two-column gallery without unbounded row growth. Fetch
  // sequentially to preserve evidence order; failures do not shift factual copy.
  const mainImages: Buffer[] = [];
  if (imageUrls && imageUrls.length > 0) {
    const imagesToFetch = imageUrls.slice(0, 4);
    for (const url of imagesToFetch) {
      try {
        const buf = await fetchImageBuffer(url);
        if (buf) mainImages.push(buf);
      } catch (e) {
        console.warn("Failed to fetch image for site description:", e);
      }
    }
  }

  // Section Title
  children.push(
    new Paragraph({
      text: "7.0 SITE DESCRIPTION",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  // 7.1 Location and Access
  children.push(
    new Paragraph({
      text: "7.1 Location and Access",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The subject property is located at ${addr || "[property location]"}, within the jurisdiction of ${municipality || "[municipality / rural municipality / district]"}.`,
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Access to the site is provided via maintained roadway infrastructure. The access road is suitable for year-round use and provides adequate connectivity to regional transportation networks.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The site benefits from proximity to regional transportation routes, service centres, and supporting infrastructure. Visibility and accessibility are typical for properties of this class within the market area.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 7.2 Size, Shape, and Topography
  children.push(
    new Paragraph({
      text: "7.2 Size, Shape, and Topography",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The property comprises an estimated ${lotSize || "Not provided"} ${isAgricultural ? "acres" : "square feet"}, with a regular configuration that provides efficient use of the site.`,
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Topography is generally level to gently rolling, with drainage appearing adequate based on visual observation at the time of inspection.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Property-Type Highlights
  children.push(
    new Paragraph({
      text: "Property-Type Highlights:",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural Properties ", bold: true }),
        new TextRun({
          text: "– Soil texture, drainage, and Canada Land Inventory (CLI) capability class influence productivity. Level to gently rolling terrain supports typical crop production and machinery operation.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial / Industrial Properties ", bold: true }),
        new TextRun({
          text: "– Lot coverage, loading bays, parking layout, and internal circulation are evaluated for efficiency, truck access, and customer traffic flow.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential Properties ", bold: true }),
        new TextRun({
          text: "– Lot orientation, landscaping, frontage, and curb appeal contribute to aesthetic value, privacy, and market desirability.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 7.3 Utilities and Site Services
  children.push(
    new Paragraph({
      text: "7.3 Utilities and Site Services",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Available services include electricity, natural gas (where applicable), water supply (municipal or private well), sanitary services (municipal sewer or septic system), telephone, and internet connectivity.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Service capacity is considered adequate for current and foreseeable uses of the property. Any future expansion or redevelopment may require service upgrades or municipal approval.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 7.4 Site Improvements
  children.push(
    new Paragraph({
      text: "7.4 Site Improvements (if applicable)",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Improvements located on-site include driveways, landscaping, fencing, outbuildings, storage areas, and other features as observed during the property inspection.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "All improvements are assumed to be in serviceable condition and to contribute proportionally to overall site utility.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "No material deferred maintenance was observed during inspection unless otherwise noted.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 7.5 Flood Risk
  children.push(
    new Paragraph({
      text: "7.5 Flood Risk, Drainage, and Environmental Factors",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "According to available mapping and municipal sources, the property is not situated within a designated floodplain or regulated drainage area, unless otherwise disclosed.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Surface water drainage appears adequate, and no evidence of erosion, ponding, or contamination was observed during the visual inspection.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The valuation assumes compliance with applicable environmental protection and watershed management regulations. Should subsequent investigations reveal deficiencies, the market value opinion may be affected.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 7.6 Subject Property Photographs
  if (mainImages.length > 0) {
    children.push(
      new Paragraph({
        text: "7.6 Subject Property Photographs",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 120 },
      })
    );

    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({
            text: "The following photographs were taken during the property inspection and provide visual documentation of the subject property's current condition and characteristics.",
          }),
        ],
        spacing: { after: 160 },
      })
    );

    // Pair images in source order; fixed halves must sum to contentWidthTw so
    // Word cannot expand the evidence table beyond printable margins.
    const cellMargins = { top: 100, bottom: 100, left: 100, right: 100 };
    const halfWidth = Math.round(contentWidthTw / 2);
    const imageWidth = 280;
    const imageHeight = 210;
    const rows: TableRow[] = [];

    for (let i = 0; i < mainImages.length; i += 2) {
      const leftImg = mainImages[i];
      const rightImg = mainImages[i + 1];

      rows.push(
        new TableRow({
          children: [
            new TableCell({
              width: { size: halfWidth, type: WidthType.DXA },
              margins: cellMargins,
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                left: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                right: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
              },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new ImageRun({
                      data: leftImg as any,
                      transformation: { width: imageWidth, height: imageHeight },
                    } as any),
                  ],
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: { before: 60 },
                  children: [
                    new TextRun({
                      text: `Photo ${i + 1}`,
                      size: 18,
                      color: "6B7280",
                      italics: true,
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: halfWidth, type: WidthType.DXA },
              margins: cellMargins,
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                left: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                right: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
              },
              children: rightImg
                ? [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new ImageRun({
                          data: rightImg as any,
                          transformation: { width: imageWidth, height: imageHeight },
                        } as any),
                      ],
                    }),
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      spacing: { before: 60 },
                      children: [
                        new TextRun({
                          text: `Photo ${i + 2}`,
                          size: 18,
                          color: "6B7280",
                          italics: true,
                        }),
                      ],
                    }),
                  ]
                : [new Paragraph({ text: "" })],
            }),
          ],
        })
      );
    }

    if (rows.length > 0) {
      children.push(
        new Table({
          width: { size: contentWidthTw, type: WidthType.DXA },
          columnWidths: [halfWidth, halfWidth],
          rows,
        })
      );
    }

    children.push(
      new Paragraph({
        text: "",
        spacing: { after: 200 },
      })
    );
  }

  return children;
}
