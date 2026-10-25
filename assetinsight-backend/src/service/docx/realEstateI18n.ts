/**
 * Internationalization strings for Real Estate DOCX reports
 * Supports: English (en), French (fr), Spanish (es)
 */

export type RealEstateI18nStrings = {
  // Document sections
  letterOfTransmittal: string;
  executiveSummary: string;
  certificationAndCompliance: string;
  assumptionsAndConditions: string;
  scopeOfAssignment: string;
  basisOfAppraisal: string;
  factualInformation: string;
  siteDescription: string;
  highestAndBestUse: string;
  valuationAnalysis: string;
  marketContext: string;
  conclusionsAndRecommendations: string;

  // Section headings
  propertyOverview: string;
  purposeAndIntendedUse: string;
  clientAndUsers: string;
  effectiveDateAndInspection: string;
  summaryOfKeyFacts: string;
  highestBestUseSummary: string;
  marketValueConclusion: string;
  propertyTypeHighlights: string;

  // Certification section
  appraiserCertification: string;
  professionalMembership: string;
  complianceStatement: string;
  conflictOfInterest: string;

  // Assumptions section
  generalAssumptions: string;
  extraordinaryAssumptions: string;
  environmentalLimitations: string;
  confidentialityDisclaimer: string;

  // Scope section
  purposeAndFunction: string;
  intendedUseAndUsers: string;
  propertyRightsAppraised: string;
  scopeOfWork: string;
  researchAndVerification: string;

  // Basis section
  definitionOfMarketValue: string;
  interestAndRights: string;
  exposureAndMarketing: string;

  // Factual section
  legalDescAndAddress: string;
  ownershipAndTitle: string;
  assessmentAndTaxation: string;
  municipalAndRegional: string;
  economicAndMarket: string;

  // Site section
  locationAndAccess: string;
  sizeShapeTopography: string;
  utilitiesAndServices: string;

  // HBU section
  definitionAndFramework: string;
  legallyPermissible: string;
  physicallyPossible: string;
  financiallyFeasible: string;
  maximallyProductive: string;
  conclusionOfHBU: string;

  // Valuation section
  overviewOfApproaches: string;
  directComparisonApproach: string;
  incomeCapitalizationApproach: string;
  reconciliationOfIndications: string;
  finalEstimateOfValue: string;

  // Market section
  marketTrendsAndConditions: string;
  regionalAndProvincialOutlook: string;
  riskAssessment: string;

  // Conclusions section
  summaryOfFindings: string;
  reconciliationOfApproaches: string;
  finalMarketValueOpinion: string;
  professionalOpinion: string;

  // Labels
  effectiveDate: string;
  inspectionDate: string;
  reportDate: string;
  propertyAddress: string;
  legalDescription: string;
  propertyType: string;
  owner: string;
  marketValue: string;
  civicAddress: string;
  municipality: string;
  totalAcres: string;
  cultivatedAcres: string;
  soilClass: string;
  terrain: string;
  marketRentPerAcre: string;
  capRate: string;
  indicatedValue: string;

  // Property types
  agricultural: string;
  commercial: string;
  residential: string;

  // Common text
  dollars: string;
  cad: string;
  respectfullySubmitted: string;
  per: string;
  attentionPropertyOwner: string;
  reStatement: string;
  seeDocumentation: string;
  perTitleDocumentation: string;
  notApplicable: string;
  
  // Value conclusion
  marketValueConclusionTitle: string;
  asOf: string;
  finalMarketValue: string;
  estimatedMarketValue: string;
};

const en: RealEstateI18nStrings = {
  // Document sections
  letterOfTransmittal: "Letter of Transmittal",
  executiveSummary: "1.0 EXECUTIVE SUMMARY",
  certificationAndCompliance: "2.0 CERTIFICATION AND COMPLIANCE",
  assumptionsAndConditions: "3.0 ASSUMPTIONS, LIMITING CONDITIONS, AND LIABILITY",
  scopeOfAssignment: "4.0 SCOPE OF THE ASSIGNMENT",
  basisOfAppraisal: "5.0 BASIS OF THE APPRAISAL",
  factualInformation: "6.0 FACTUAL INFORMATION",
  siteDescription: "7.0 SITE DESCRIPTION",
  highestAndBestUse: "8.0 HIGHEST AND BEST USE ANALYSIS",
  valuationAnalysis: "9.0 VALUATION ANALYSIS",
  marketContext: "10.0 MARKET CONTEXT AND RISK ANALYSIS",
  conclusionsAndRecommendations: "11.0 CONCLUSIONS AND RECOMMENDATIONS",

  // Section headings
  propertyOverview: "1.1 Property Overview and Location Context",
  purposeAndIntendedUse: "1.2 Purpose and Intended Use of the Appraisal",
  clientAndUsers: "1.3 Client and Intended Users",
  effectiveDateAndInspection: "1.4 Effective Date of Valuation and Inspection",
  summaryOfKeyFacts: "1.5 Summary of Key Facts and Conclusions",
  highestBestUseSummary: "1.6 Highest and Best Use Summary",
  marketValueConclusion: "1.7 Market Value Conclusion",
  propertyTypeHighlights: "1.8 Property Type Highlights",

  // Certification section
  appraiserCertification: "2.1 Appraiser's Certification Statement",
  professionalMembership: "2.2 Professional Membership and Competency",
  complianceStatement: "2.3 Compliance with CUSPAP and IVS",
  conflictOfInterest: "2.4 Conflict of Interest and Independence Statement",

  // Assumptions section
  generalAssumptions: "3.1 General Assumptions and Limiting Conditions",
  extraordinaryAssumptions: "3.2 Extraordinary Assumptions and Hypothetical Conditions",
  environmentalLimitations: "3.3 Environmental, Legal, and Physical Limitations",
  confidentialityDisclaimer: "3.4 Confidentiality and Liability Disclaimer",

  // Scope section
  purposeAndFunction: "4.1 Purpose and Function of the Appraisal",
  intendedUseAndUsers: "4.2 Intended Use and Users",
  propertyRightsAppraised: "4.3 Property Rights Appraised",
  scopeOfWork: "4.4 Scope of Work and Methodology",
  researchAndVerification: "4.5 Research, Verification, and Data Sources",

  // Basis section
  definitionOfMarketValue: "5.1 Definition of Market Value",
  interestAndRights: "5.2 Interest and Rights Appraised",
  exposureAndMarketing: "5.3 Exposure and Marketing Periods",

  // Factual section
  legalDescAndAddress: "6.1 Legal Description and Civic Address",
  ownershipAndTitle: "6.2 Ownership and Title History",
  assessmentAndTaxation: "6.3 Assessment and Taxation Summary",
  municipalAndRegional: "6.4 Municipal and Regional Context",
  economicAndMarket: "6.5 Economic and Market Overview",

  // Site section
  locationAndAccess: "7.1 Location and Access",
  sizeShapeTopography: "7.2 Size, Shape, and Topography",
  utilitiesAndServices: "7.3 Utilities and Site Services",

  // HBU section
  definitionAndFramework: "8.1 Definition and Analytical Framework",
  legallyPermissible: "8.2 Legally Permissible Use",
  physicallyPossible: "8.3 Physically Possible Use",
  financiallyFeasible: "8.4 Financially Feasible Use",
  maximallyProductive: "8.5 Maximally Productive Use",
  conclusionOfHBU: "8.6 Conclusion of Highest and Best Use",

  // Valuation section
  overviewOfApproaches: "9.1 Overview of Approaches to Value",
  directComparisonApproach: "9.2 Direct Comparison Approach",
  incomeCapitalizationApproach: "9.3 Income Capitalization Approach",
  reconciliationOfIndications: "9.5 Reconciliation of Indications",
  finalEstimateOfValue: "9.6 Final Estimate of Market Value",

  // Market section
  marketTrendsAndConditions: "10.1 Market Trends and Economic Conditions",
  regionalAndProvincialOutlook: "10.2 Regional and Provincial Outlook",
  riskAssessment: "10.3 Risk Assessment and Sensitivity Analysis",

  // Conclusions section
  summaryOfFindings: "11.1 Summary of Findings",
  reconciliationOfApproaches: "11.2 Reconciliation of Approaches",
  finalMarketValueOpinion: "11.3 Final Market Value Opinion",
  professionalOpinion: "11.4 Professional Opinion and Commentary",

  // Labels
  effectiveDate: "Effective Date",
  inspectionDate: "Inspection Date",
  reportDate: "Report Date",
  propertyAddress: "Property Address",
  legalDescription: "Legal Description",
  propertyType: "Property Type",
  owner: "Owner",
  marketValue: "Market Value",
  civicAddress: "Civic Address",
  municipality: "Municipality",
  totalAcres: "Total Acres",
  cultivatedAcres: "Cultivated Acres",
  soilClass: "Soil Class",
  terrain: "Terrain",
  marketRentPerAcre: "Market Rent/Acre",
  capRate: "Cap Rate",
  indicatedValue: "Indicated Value",

  // Property types
  agricultural: "Agricultural",
  commercial: "Commercial",
  residential: "Residential",

  // Common text
  dollars: "Dollars",
  cad: "CAD",
  respectfullySubmitted: "Respectfully submitted,",
  per: "Per:",
  attentionPropertyOwner: "Attention: Property Owner",
  reStatement: "RE: A {propertyType} Property Located at {address}",
  seeDocumentation: "See title documentation",
  perTitleDocumentation: "Per title documentation",
  notApplicable: "N/A",

  // Value conclusion
  marketValueConclusionTitle: "MARKET VALUE CONCLUSION",
  asOf: "As of",
  finalMarketValue: "Final Market Value:",
  estimatedMarketValue: "Estimated Market Value:",
};

const fr: RealEstateI18nStrings = {
  // Document sections
  letterOfTransmittal: "Lettre de transmission",
  executiveSummary: "1.0 RÉSUMÉ EXÉCUTIF",
  certificationAndCompliance: "2.0 CERTIFICATION ET CONFORMITÉ",
  assumptionsAndConditions: "3.0 HYPOTHÈSES, CONDITIONS LIMITATIVES ET RESPONSABILITÉ",
  scopeOfAssignment: "4.0 PORTÉE DE LA MISSION",
  basisOfAppraisal: "5.0 BASE DE L'ÉVALUATION",
  factualInformation: "6.0 INFORMATIONS FACTUELLES",
  siteDescription: "7.0 DESCRIPTION DU SITE",
  highestAndBestUse: "8.0 ANALYSE DE L'UTILISATION OPTIMALE",
  valuationAnalysis: "9.0 ANALYSE DE L'ÉVALUATION",
  marketContext: "10.0 CONTEXTE DU MARCHÉ ET ANALYSE DES RISQUES",
  conclusionsAndRecommendations: "11.0 CONCLUSIONS ET RECOMMANDATIONS",

  // Section headings
  propertyOverview: "1.1 Aperçu de la propriété et contexte de localisation",
  purposeAndIntendedUse: "1.2 Objectif et utilisation prévue de l'évaluation",
  clientAndUsers: "1.3 Client et utilisateurs prévus",
  effectiveDateAndInspection: "1.4 Date d'évaluation effective et d'inspection",
  summaryOfKeyFacts: "1.5 Résumé des faits clés et conclusions",
  highestBestUseSummary: "1.6 Résumé de l'utilisation optimale",
  marketValueConclusion: "1.7 Conclusion de la valeur marchande",
  propertyTypeHighlights: "1.8 Points saillants du type de propriété",

  // Certification section
  appraiserCertification: "2.1 Déclaration de certification de l'évaluateur",
  professionalMembership: "2.2 Adhésion professionnelle et compétence",
  complianceStatement: "2.3 Conformité aux NUPPEC et NIE",
  conflictOfInterest: "2.4 Déclaration de conflit d'intérêts et d'indépendance",

  // Assumptions section
  generalAssumptions: "3.1 Hypothèses générales et conditions limitatives",
  extraordinaryAssumptions: "3.2 Hypothèses extraordinaires et conditions hypothétiques",
  environmentalLimitations: "3.3 Limitations environnementales, juridiques et physiques",
  confidentialityDisclaimer: "3.4 Clause de confidentialité et de responsabilité",

  // Scope section
  purposeAndFunction: "4.1 Objectif et fonction de l'évaluation",
  intendedUseAndUsers: "4.2 Utilisation et utilisateurs prévus",
  propertyRightsAppraised: "4.3 Droits de propriété évalués",
  scopeOfWork: "4.4 Étendue des travaux et méthodologie",
  researchAndVerification: "4.5 Recherche, vérification et sources de données",

  // Basis section
  definitionOfMarketValue: "5.1 Définition de la valeur marchande",
  interestAndRights: "5.2 Intérêts et droits évalués",
  exposureAndMarketing: "5.3 Périodes d'exposition et de commercialisation",

  // Factual section
  legalDescAndAddress: "6.1 Description légale et adresse civique",
  ownershipAndTitle: "6.2 Historique de propriété et de titre",
  assessmentAndTaxation: "6.3 Résumé de l'évaluation et de la taxation",
  municipalAndRegional: "6.4 Contexte municipal et régional",
  economicAndMarket: "6.5 Aperçu économique et du marché",

  // Site section
  locationAndAccess: "7.1 Emplacement et accès",
  sizeShapeTopography: "7.2 Taille, forme et topographie",
  utilitiesAndServices: "7.3 Services publics et services du site",

  // HBU section
  definitionAndFramework: "8.1 Définition et cadre analytique",
  legallyPermissible: "8.2 Utilisation légalement permise",
  physicallyPossible: "8.3 Utilisation physiquement possible",
  financiallyFeasible: "8.4 Utilisation financièrement réalisable",
  maximallyProductive: "8.5 Utilisation maximalement productive",
  conclusionOfHBU: "8.6 Conclusion de l'utilisation optimale",

  // Valuation section
  overviewOfApproaches: "9.1 Aperçu des approches de la valeur",
  directComparisonApproach: "9.2 Approche de comparaison directe",
  incomeCapitalizationApproach: "9.3 Approche de capitalisation des revenus",
  reconciliationOfIndications: "9.5 Réconciliation des indications",
  finalEstimateOfValue: "9.6 Estimation finale de la valeur marchande",

  // Market section
  marketTrendsAndConditions: "10.1 Tendances du marché et conditions économiques",
  regionalAndProvincialOutlook: "10.2 Perspectives régionales et provinciales",
  riskAssessment: "10.3 Évaluation des risques et analyse de sensibilité",

  // Conclusions section
  summaryOfFindings: "11.1 Résumé des conclusions",
  reconciliationOfApproaches: "11.2 Réconciliation des approches",
  finalMarketValueOpinion: "11.3 Opinion finale sur la valeur marchande",
  professionalOpinion: "11.4 Opinion professionnelle et commentaires",

  // Labels
  effectiveDate: "Date effective",
  inspectionDate: "Date d'inspection",
  reportDate: "Date du rapport",
  propertyAddress: "Adresse de la propriété",
  legalDescription: "Description légale",
  propertyType: "Type de propriété",
  owner: "Propriétaire",
  marketValue: "Valeur marchande",
  civicAddress: "Adresse civique",
  municipality: "Municipalité",
  totalAcres: "Acres totaux",
  cultivatedAcres: "Acres cultivés",
  soilClass: "Classe de sol",
  terrain: "Terrain",
  marketRentPerAcre: "Loyer du marché/acre",
  capRate: "Taux de capitalisation",
  indicatedValue: "Valeur indiquée",

  // Property types
  agricultural: "Agricole",
  commercial: "Commercial",
  residential: "Résidentiel",

  // Common text
  dollars: "Dollars",
  cad: "CAD",
  respectfullySubmitted: "Respectueusement soumis,",
  per: "Par:",
  attentionPropertyOwner: "À l'attention du: Propriétaire",
  reStatement: "RE: Une propriété {propertyType} située au {address}",
  seeDocumentation: "Voir la documentation du titre",
  perTitleDocumentation: "Selon la documentation du titre",
  notApplicable: "S/O",

  // Value conclusion
  marketValueConclusionTitle: "CONCLUSION DE LA VALEUR MARCHANDE",
  asOf: "En date du",
  finalMarketValue: "Valeur marchande finale:",
  estimatedMarketValue: "Valeur marchande estimée:",
};

const es: RealEstateI18nStrings = {
  // Document sections
  letterOfTransmittal: "Carta de Transmisión",
  executiveSummary: "1.0 RESUMEN EJECUTIVO",
  certificationAndCompliance: "2.0 CERTIFICACIÓN Y CUMPLIMIENTO",
  assumptionsAndConditions: "3.0 SUPUESTOS, CONDICIONES LIMITANTES Y RESPONSABILIDAD",
  scopeOfAssignment: "4.0 ALCANCE DE LA ASIGNACIÓN",
  basisOfAppraisal: "5.0 BASE DE LA VALORACIÓN",
  factualInformation: "6.0 INFORMACIÓN FACTUAL",
  siteDescription: "7.0 DESCRIPCIÓN DEL SITIO",
  highestAndBestUse: "8.0 ANÁLISIS DEL USO ÓPTIMO",
  valuationAnalysis: "9.0 ANÁLISIS DE VALORACIÓN",
  marketContext: "10.0 CONTEXTO DEL MERCADO Y ANÁLISIS DE RIESGOS",
  conclusionsAndRecommendations: "11.0 CONCLUSIONES Y RECOMENDACIONES",

  // Section headings
  propertyOverview: "1.1 Descripción general de la propiedad y contexto de ubicación",
  purposeAndIntendedUse: "1.2 Propósito y uso previsto de la valoración",
  clientAndUsers: "1.3 Cliente y usuarios previstos",
  effectiveDateAndInspection: "1.4 Fecha efectiva de valoración e inspección",
  summaryOfKeyFacts: "1.5 Resumen de hechos clave y conclusiones",
  highestBestUseSummary: "1.6 Resumen del uso óptimo",
  marketValueConclusion: "1.7 Conclusión del valor de mercado",
  propertyTypeHighlights: "1.8 Aspectos destacados del tipo de propiedad",

  // Certification section
  appraiserCertification: "2.1 Declaración de certificación del tasador",
  professionalMembership: "2.2 Membresía profesional y competencia",
  complianceStatement: "2.3 Cumplimiento con CUSPAP y NIV",
  conflictOfInterest: "2.4 Declaración de conflicto de intereses e independencia",

  // Assumptions section
  generalAssumptions: "3.1 Supuestos generales y condiciones limitantes",
  extraordinaryAssumptions: "3.2 Supuestos extraordinarios y condiciones hipotéticas",
  environmentalLimitations: "3.3 Limitaciones ambientales, legales y físicas",
  confidentialityDisclaimer: "3.4 Cláusula de confidencialidad y responsabilidad",

  // Scope section
  purposeAndFunction: "4.1 Propósito y función de la valoración",
  intendedUseAndUsers: "4.2 Uso y usuarios previstos",
  propertyRightsAppraised: "4.3 Derechos de propiedad valorados",
  scopeOfWork: "4.4 Alcance del trabajo y metodología",
  researchAndVerification: "4.5 Investigación, verificación y fuentes de datos",

  // Basis section
  definitionOfMarketValue: "5.1 Definición del valor de mercado",
  interestAndRights: "5.2 Intereses y derechos valorados",
  exposureAndMarketing: "5.3 Períodos de exposición y comercialización",

  // Factual section
  legalDescAndAddress: "6.1 Descripción legal y dirección cívica",
  ownershipAndTitle: "6.2 Historial de propiedad y título",
  assessmentAndTaxation: "6.3 Resumen de evaluación e impuestos",
  municipalAndRegional: "6.4 Contexto municipal y regional",
  economicAndMarket: "6.5 Panorama económico y del mercado",

  // Site section
  locationAndAccess: "7.1 Ubicación y acceso",
  sizeShapeTopography: "7.2 Tamaño, forma y topografía",
  utilitiesAndServices: "7.3 Servicios públicos y del sitio",

  // HBU section
  definitionAndFramework: "8.1 Definición y marco analítico",
  legallyPermissible: "8.2 Uso legalmente permitido",
  physicallyPossible: "8.3 Uso físicamente posible",
  financiallyFeasible: "8.4 Uso financieramente viable",
  maximallyProductive: "8.5 Uso máximamente productivo",
  conclusionOfHBU: "8.6 Conclusión del uso óptimo",

  // Valuation section
  overviewOfApproaches: "9.1 Descripción general de los enfoques de valor",
  directComparisonApproach: "9.2 Enfoque de comparación directa",
  incomeCapitalizationApproach: "9.3 Enfoque de capitalización de ingresos",
  reconciliationOfIndications: "9.5 Reconciliación de indicaciones",
  finalEstimateOfValue: "9.6 Estimación final del valor de mercado",

  // Market section
  marketTrendsAndConditions: "10.1 Tendencias del mercado y condiciones económicas",
  regionalAndProvincialOutlook: "10.2 Perspectivas regionales y provinciales",
  riskAssessment: "10.3 Evaluación de riesgos y análisis de sensibilidad",

  // Conclusions section
  summaryOfFindings: "11.1 Resumen de hallazgos",
  reconciliationOfApproaches: "11.2 Reconciliación de enfoques",
  finalMarketValueOpinion: "11.3 Opinión final del valor de mercado",
  professionalOpinion: "11.4 Opinión profesional y comentarios",

  // Labels
  effectiveDate: "Fecha efectiva",
  inspectionDate: "Fecha de inspección",
  reportDate: "Fecha del informe",
  propertyAddress: "Dirección de la propiedad",
  legalDescription: "Descripción legal",
  propertyType: "Tipo de propiedad",
  owner: "Propietario",
  marketValue: "Valor de mercado",
  civicAddress: "Dirección cívica",
  municipality: "Municipio",
  totalAcres: "Acres totales",
  cultivatedAcres: "Acres cultivados",
  soilClass: "Clase de suelo",
  terrain: "Terreno",
  marketRentPerAcre: "Renta de mercado/acre",
  capRate: "Tasa de capitalización",
  indicatedValue: "Valor indicado",

  // Property types
  agricultural: "Agrícola",
  commercial: "Comercial",
  residential: "Residencial",

  // Common text
  dollars: "Dólares",
  cad: "CAD",
  respectfullySubmitted: "Respetuosamente presentado,",
  per: "Por:",
  attentionPropertyOwner: "Atención: Propietario",
  reStatement: "RE: Una propiedad {propertyType} ubicada en {address}",
  seeDocumentation: "Ver documentación del título",
  perTitleDocumentation: "Según documentación del título",
  notApplicable: "N/D",

  // Value conclusion
  marketValueConclusionTitle: "CONCLUSIÓN DEL VALOR DE MERCADO",
  asOf: "A partir del",
  finalMarketValue: "Valor de mercado final:",
  estimatedMarketValue: "Valor de mercado estimado:",
};

const translations: Record<string, RealEstateI18nStrings> = { en, fr, es };

export function getRealEstateI18n(lang: string): RealEstateI18nStrings {
  return translations[lang] || translations.en;
}

export function getPropertyTypeName(type: string, lang: string): string {
  const t = getRealEstateI18n(lang);
  switch (type?.toLowerCase()) {
    case "agricultural":
      return t.agricultural;
    case "commercial":
      return t.commercial;
    case "residential":
    default:
      return t.residential;
  }
}
