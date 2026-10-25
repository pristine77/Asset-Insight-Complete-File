import fs from "fs/promises";
import path from "path";
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Paragraph,
  Packer,
  Table,
  TableOfContents,
  TextRun,
  convertInchesToTwip,
  SectionType,
  PageOrientation,
} from "docx";
import { buildHeaderTable, buildFooterTable } from "./builders/header.js";
import { buildCover } from "./builders/cover.js";
import { buildTOC } from "./builders/toc.js";
import { buildTransmittalLetter } from "./builders/transmittal.js";
import {
  buildCertificateOfAppraisal,
  resolveSelectedAssetValuationMethods,
} from "./builders/certificate.js";
import { buildMarketOverview } from "./builders/marketOverview.js";
import { buildCertificationSection } from "./builders/certification.js";
import { buildAssetScheduleSection } from "./builders/assetScheduleSection.js";
import { buildAppraisalOverview } from "./builders/appraisalOverview.js";
import {
  formatDateUS,
  formatMonthYear,
  goldDivider,
  fetchImageBuffer,
  toTitleCaseWords,
} from "./builders/utils.js";
import {
  DAMAGE_ANALYSIS_LABEL,
  buildPolicySafeReportDamageAnalysis,
  formatDamageAnalysisDisplayText,
} from "../../utils/assetDamageAnalysis.js";
import { resolveDamageAnalysisEnabled } from "../../utils/lotDamagePolicy.js";

/**
 * Builds the production asset-appraisal document used for mixed source data.
 * It resolves localization and valuation once, assembles portrait narrative,
 * then places certificate, landscape Schedule A, and market evidence at explicit
 * section boundaries. Those boundaries are required for page geometry and merges.
 */
export async function generateMixedDocx(reportData: any): Promise<Buffer> {
  // Restrict locale selection to dictionaries maintained in this module. Unknown
  // values fall back to English rather than mixing undefined translated strings.
  const lang: "en" | "fr" | "es" = ((): any => {
    const l = String((reportData as any)?.language || "").toLowerCase();
    return l === "fr" || l === "es" ? l : "en";
  })();
  const t = {
    en: {
      assetReport: "Asset Report",
      reportSummary: "Report Summary",
      groupingMode: "Grouping Mode",
      totalLots: "Total Lots",
      totalImages: "Total Images",
      summaryOfValue: "Summary of Value Conclusions",
      valueBody: (v: string) =>
        `Based upon our analysis and methodology, we estimate the reported assets have a value of ${v}.`,
      noValueBody:
        "Based upon our analysis and methodology, please refer to the detailed sections for value information.",
      reportDetails: "Report Details",
      lotWord: "Lot",
      perItem: "Per Item",
      perPhoto: "Per Photo",
      singleLot: "Bundle",
      lotsWord: "Lots",
      mixed: "Mixed",
      page: "Page ",
      contractNo: "Contract No",
      // Narrative: headings and bodies
      conditionsHeading: "Conditions of Appraisal",
      conditionsBody:
        "The value stated in this appraisal report is based on the best judgment of the appraiser, given the facts and conditions available at the date of valuation. The use of this report is limited to the purpose of determining the value of the assets. This report is to be used in its entirety only.",
      purposeHeading: "Purpose of This Report",
      purposeBody: (client: string) =>
        `The purpose of this appraisal report is to provide an opinion of value of the subject for internal consideration and to assist ${client} and the specified personnel within their corporation in establishing a current Orderly Liquidation Value (OLV) for financial considerations. This report is not intended to be used for any other purpose. Based on the purpose of the appraisal, we have valued the subject assets under the premise of OLV.`,
      identHeading: "Identification of Assets Appraised",
      identBody:
        "As set out in the attached sections of this report, the assets appraised within this engagement include: Construction & Transportation Equipment.",
      scopeHeading: "Scope of Work",
      scopeIntro:
        "Valuation process and methodology — the appraiser employed the following procedures to determine the value conclusions rendered herein:",
      scopeBullet1:
        "Review and analysis of asset records and other informational materials.",
      scopeBullet2:
        "Inspection and analysis of assets and equipment at the client location(s).",
      observationsHeading: "Observations and Comments",
      observationsBody:
        "Available data and market comparables utilized were up to 120 days old. Increased weighting was given to recent regionally specific comparables when available.",
      intendedHeading: "Intended Users",
      intendedBody:
        "This appraisal is not intended to be reproduced or used for any purpose other than that outlined in this appraisal and is for the internal use of the client.",
      valueTermHeading: "Value Terminology",
      valueOLVHeading: "Orderly Liquidation Value (OLV)",
      valueOLVBody: (ccy: string) =>
        `The estimated amount, expressed in terms of cash in ${ccy}, that could typically be realized from a liquidation sale, with the seller being compelled to sell on an 'as-is condition, where-is location' basis, as of a specific date and over a 120 day period.`,
      valueOLVScenarioBody:
        "For the purpose of this appraisal, we have considered a properly advertised and professionally managed privately negotiated sale scenario, over a period of 120 days, during normal business operations or while winding down operations, with the buyer responsible for dismantling and removal at their own risk and expense.",
      definitionsHeading: "Definitions and Obsolescence",
      physicalDetHeading: "Physical Deterioration",
      physicalDetBody:
        "A form of depreciation where the loss in value or usefulness of a property is due to the using up or expiration of its useful life caused by wear and tear, deterioration, exposure to various elements, physical stresses, and similar factors.",
      functionalObsHeading: "Functional Obsolescence",
      functionalObsBody:
        "A form of depreciation in which the loss in value or usefulness is caused by inefficiencies or inadequacies of the asset itself when compared to a more efficient or less costly replacement that newer technology has developed.",
      economicObsHeading: "Economic Obsolescence",
      economicObsBody:
        "A form of depreciation or loss in value caused by external factors such as industry economics, availability of financing, legislation, increased cost of inputs without offsetting price increases, reduced demand, increased competition, inflation, or high interest rates.",
      depreciationHeading: "Depreciation",
      depreciationBody:
        "The actual loss in value or worth of a property from all causes including physical deterioration, functional obsolescence, and economic obsolescence.",
      limitingHeading: "Limiting Conditions and Critical Assumptions",
      assetCondHeading: "Asset Conditions",
      assetCondBody:
        "Certain information was provided to the appraiser regarding repairs, engines, undercarriages, and upgrades. These were considered when appraising and comparing the subject assets with market comparables. Some assets may have extended warranties.",
      titleAssetsHeading: "Title to the Assets",
      titleAssetsBody:
        "No investigation has been made of, and no responsibility is assumed for, legal matters including title or encumbrances. Title is assumed to be good and marketable unless otherwise stated.",
      responsibleOwnHeading: "Responsible Ownership",
      responsibleOwnBody:
        "It is assumed that the subject assets are under responsible ownership and competent management.",
      statedPurposeHeading: "Stated Purpose",
      statedPurposeBody:
        "This appraisal and report have been made only for the stated purpose and cannot be used for any other purpose.",
      valuationDateHeading: "Valuation Date",
      valuationDateBody: (dateStr: string, ccy: string) =>
        `The valuation date is ${dateStr || "the effective date"}; values are in ${ccy} as of that date.`,
      inspectionHeading: "Inspection",
      inspectionBody: (monthStr?: string) =>
        `The subject assets were inspected ${monthStr ? `in ${monthStr}` : "as noted in the report"}. When the inspection date differs from the valuation date, no material change is assumed unless otherwise stated.`,
      hazardousHeading: "Hazardous Substances",
      hazardousBody:
        "No allowance has been made for potential environmental problems. The value estimate assumes full compliance with applicable regulations and the absence of hazardous materials unless stated.",
      changeMarketHeading: "Change in Market Conditions",
      changeMarketBody:
        "We are not responsible for changes in market conditions after the valuation date and have no obligation to revise the report for subsequent events.",
      unexpectedHeading: "Unexpected Conditions",
      unexpectedBody:
        "It is assumed there are no hidden or non-apparent conditions that would affect value. No responsibility is assumed for such conditions.",
      companySubjectHeading: "Company, Subject Asset Description",
      companyDiscussionHeading: "Company Discussion",
      companyDiscussionBody: (client: string) =>
        `${client} operates across multiple divisions and locations. The subject engagement focuses on relevant operating divisions connected to the subject assets.`,
      subjectAssetsHeading: "Subject Assets Discussion",
      subjectAssetsBody:
        "The major subject assets include Construction and Transportation equipment. Overall, these were found to be in good to excellent condition, subject to the assumptions and limiting conditions.",
      approachesHeading: "Approaches to Value",
      costApproachHeading: "Cost Approach",
      costApproachBody:
        "A set of procedures in which an appraiser derives a value indication by estimating the current cost to reproduce or replace the assets, deducting for all depreciation, including physical deterioration, functional obsolescence, and external or economic obsolescence.",
      marketApproachHeading: "Sales Comparison (Market) Approach",
      marketApproachBody:
        "A set of procedures in which an appraiser derives a value indication by comparing the assets being appraised with similar assets that have been sold recently and making appropriate adjustments.",
      incomeApproachHeading: "Income Capitalization Approach",
      incomeApproachBody:
        "A set of procedures in which an appraiser derives a value indication for income-producing assets by converting anticipated benefits into value via capitalization or discounting of cash flows.",
      alternateUseHeading: "Alternate Use & Appropriate Market Approach",
      alternateUseBody:
        "We considered the appropriate market and level of trade, availability of reliable market data, market conditions as of the valuation date, and a marketing period consistent with the intended use identified.",
      reconciliationHeading: "Reconciliation of Valuation Approaches",
      reconciliationBody:
        "The Cost and Market approaches were utilized and reconciled. The Income approach was considered but not applied for reasons discussed within this report.",
      hbuHeading: "Highest and Best Use",
      hbuBody:
        "We considered the highest and best use of the subject assets, including what is legally permissible, physically possible, financially feasible, and maximally productive.",
      valProcessHeading: "Valuation Process and Methodology",
      dataCollectionHeading: "Data Collection",
      dataCollectionBody: (monthStr?: string) =>
        `Site visits were performed ${monthStr ? `in ${monthStr}` : "as required"}. Discussions with client personnel informed our understanding of operations and maintenance policies.`,
      valuationProcessHeading2: "Valuation Process",
      valuationProcessBody:
        "We considered the income, sales comparison, and cost approaches and concluded on the appropriate methods given the asset types and available data.",
      researchMethodHeading: "Research Methodology",
      researchMethodBody:
        "Research included auction and dealer results, OEM data, used equipment marketplaces, and current market/geographic conditions for similar assets.",
      codeEthicsHeading: "Code of Ethics",
      competencyHeading: "Competency",
      competencyBody:
        "Under CPPAG, McDougall Auctioneers Ltd. must disclose if there is a lack of knowledge and/or experience that would not allow us to complete this appraisal in a competent manner or to develop credible results. McDougall Auctioneers Ltd. and the appraiser performing this appraisal have performed valuations of assets like the Subject Assets for various purposes in the past. In addition, the appraiser performing this appraisal has the appropriate knowledge and experience to be able to develop credible results for the purpose and use outlined in this report.",
      confidentialityHeading: "Confidentiality",
      confidentialityBody:
        "This report and supporting file documentation are confidential. Neither all nor any part of the contents of this appraisal (including the report and the supporting file documentation) shall be disclosed to any party, or conveyed orally or in writing through advertising, public relations, news, sales, or in any other manner without the prior written consent and approval of McDougall Auctioneers Ltd. This Appraisal Report provides a summary discussion of the data, analysis, and reasoning used by the appraiser to arrive at the opinions of value identified herein. A copy of this report and the data, reasoning, and analysis supporting our value conclusions shall remain in our files and be retained for a period of at least five (5) years after preparation, or at least two (2) years after final disposition of any judicial proceeding as required by the Records Keeping section of CPPAG. As this is an Appraisal Report, the conclusions and data contained herein can only be used by the Client for the purpose stated. The opinions and conclusions set forth in this report may not be understood properly by anyone else without additional information which is contained in the appraiser’s work file. Neither this report, nor any of the data contained herein should be distributed to another party.",
      experienceHeading: "EXPERIENCE",
      experienceBody1:
        "McDougall Auctioneers is one of Western Canada’s leading full-service auction and valuation firms, with over 40 years of experience in marketing, selling, and appraising assets across a diverse range of industries. Headquartered in Saskatchewan and operating throughout Canada and the United States, McDougall Auctioneers has built a reputation for impartial, defensible valuations that meet or exceed industry and regulatory standards.",
      experienceBody2:
        "Our appraisal team combines Certified Personal Property Appraisers, experienced auctioneers, and subject-matter specialists who have inspected and valued tens of thousands of assets annually. We deliver comprehensive appraisals for equipment, vehicles, industrial machinery, agricultural assets, and business inventories, using recognised methodologies such as the Market Approach, Cost Approach, and, where applicable, the Income Approach. All assignments are performed in compliance with the Uniform Standards of Professional Appraisal Practice (USPAP) and relevant Canadian appraisal guidelines.",
      experienceBody3:
        "McDougall’s extensive auction platform provides us with current, real-world market data on comparable sales. This proprietary database allows us to support our valuations with up-to-date evidence of pricing trends, demand fluctuations, and liquidation values. Whether for insurance, financing, litigation, or internal asset management, our appraisals provide accurate, timely, and defensible fair market values.",
      experienceBody4:
        "Our industry experience spans construction, transportation, agriculture, heavy equipment, manufacturing, and retail inventories. We are frequently engaged by banks, insolvency professionals, legal counsel, government agencies, and private owners to appraise assets ranging from single high-value machines to large, multi-site fleets. This depth of experience ensures that every McDougall appraisal assignment is approached with professionalism, objectivity, and an understanding of how market conditions translate into asset value. Clients can rely on McDougall Auctioneers for clear, well-documented reports that withstand scrutiny from lenders, courts, insurers, and auditors alike.",
    },
    fr: {
      assetReport: "Rapport d'actifs",
      reportSummary: "Résumé du rapport",
      groupingMode: "Mode de regroupement",
      totalLots: "Total des lots",
      totalImages: "Nombre d'images",
      summaryOfValue: "Résumé des conclusions de valeur",
      valueBody: (v: string) =>
        `D’après notre analyse et notre méthodologie, nous estimons que la valeur des actifs évalués est de ${v}.`,
      noValueBody:
        "D’après notre analyse et notre méthodologie, veuillez vous référer aux sections détaillées pour les informations de valeur.",
      reportDetails: "Détails du rapport",
      lotWord: "Lot",
      perItem: "Par article",
      perPhoto: "Par photo",
      singleLot: "Lot unique",
      lotsWord: "Lots",
      mixed: "Mixte",
      page: "Page ",
      contractNo: "Numéro de contrat",
      // Narrative
      conditionsHeading: "Conditions de l’évaluation",
      conditionsBody:
        "La valeur indiquée dans ce rapport d’évaluation est fondée sur le meilleur jugement de l’évaluateur, compte tenu des faits et conditions disponibles à la date de valeur. L’utilisation de ce rapport est limitée à la détermination de la valeur des actifs. Ce rapport doit être utilisé uniquement dans son intégralité.",
      purposeHeading: "Objet du rapport",
      purposeBody: (client: string) =>
        `L’objet de ce rapport est de fournir une opinion de valeur du sujet à des fins internes et d’aider ${client} et les personnes désignées au sein de son organisation à établir une Valeur de Liquidation Ordonnée (VLO) actuelle à des fins financières. Ce rapport n’est pas destiné à un autre usage. Compte tenu de cet objectif, nous avons valorisé les actifs selon l’hypothèse de VLO.`,
      identHeading: "Identification des actifs évalués",
      identBody:
        "Comme indiqué dans les sections ci-jointes, les actifs évalués dans le cadre de ce mandat comprennent : équipements de construction et de transport.",
      scopeHeading: "Étendue des travaux",
      scopeIntro:
        "Processus et méthodologie d’évaluation — l’évaluateur a appliqué les procédures suivantes pour déterminer les conclusions de valeur :",
      scopeBullet1:
        "Examen et analyse des dossiers d’actifs et autres documents d’information.",
      scopeBullet2:
        "Inspection et analyse des actifs et des équipements sur le(s) site(s) du client.",
      observationsHeading: "Observations et commentaires",
      observationsBody:
        "Les données disponibles et les comparables de marché utilisés dataient jusqu’à 120 jours. Un poids accru a été accordé aux comparables régionaux récents lorsque disponibles.",
      intendedHeading: "Utilisateurs visés",
      intendedBody:
        "Cette évaluation ne doit pas être reproduite ni utilisée à d’autres fins que celles indiquées et est destinée à l’usage interne du client.",
      valueTermHeading: "Terminologie de la valeur",
      valueOLVHeading: "Valeur de Liquidation Ordonnée (VLO)",
      valueOLVBody: (ccy: string) =>
        `Montant estimé, exprimé en espèces en ${ccy}, qui pourrait généralement être obtenu lors d’une vente de liquidation, le vendeur étant contraint de vendre selon le principe « tel quel, là où il se trouve », à une date précise et sur une période d’environ 120 jours.`,
      valueOLVScenarioBody:
        "Aux fins de cette évaluation, nous avons considéré un scénario de vente privée, correctement annoncée et gérée de manière professionnelle, sur une période de 120 jours, pendant l’exploitation normale ou la cessation des activités, l’acheteur étant responsable du démontage et de l’enlèvement à ses risques et frais.",
      definitionsHeading: "Définitions et obsolescence",
      physicalDetHeading: "Détérioration physique",
      physicalDetBody:
        "Forme de dépréciation où la perte de valeur ou d’utilité d’un bien est due à l’usure, la détérioration, l’exposition aux éléments, les contraintes physiques, et facteurs similaires.",
      functionalObsHeading: "Obsolescence fonctionnelle",
      functionalObsBody:
        "Forme de dépréciation causée par les inefficacités ou insuffisances intrinsèques de l’actif par rapport à un remplacement plus efficace ou moins coûteux issu d’une technologie plus récente.",
      economicObsHeading: "Obsolescence économique",
      economicObsBody:
        "Forme de dépréciation ou perte de valeur due à des facteurs externes tels que l’économie du secteur, la disponibilité du financement, la réglementation, l’augmentation des coûts d’intrants sans hausse compensatoire des prix, la baisse de la demande, la concurrence accrue, l’inflation ou des taux d’intérêt élevés.",
      depreciationHeading: "Dépréciation",
      depreciationBody:
        "Perte réelle de valeur ou d’utilité d’un bien, toutes causes confondues, incluant la détérioration physique, l’obsolescence fonctionnelle et l’obsolescence économique.",
      limitingHeading: "Conditions limitatives et hypothèses critiques",
      assetCondHeading: "État des actifs",
      assetCondBody:
        "Certaines informations ont été fournies à l’évaluateur concernant des réparations, moteurs, trains de roulement et améliorations. Elles ont été prises en compte lors de l’évaluation et de la comparaison avec les comparables de marché. Certains actifs peuvent bénéficier de garanties prolongées.",
      titleAssetsHeading: "Titre de propriété des actifs",
      titleAssetsBody:
        "Aucune vérification n’a été effectuée et aucune responsabilité n’est assumée pour les questions juridiques, y compris le titre ou les charges. Le titre est présumé valable et cessible sauf indication contraire.",
      responsibleOwnHeading: "Propriété responsable",
      responsibleOwnBody:
        "On suppose que les actifs sont sous une propriété responsable et une gestion compétente.",
      statedPurposeHeading: "Objet déclaré",
      statedPurposeBody:
        "Cette évaluation et ce rapport ont été réalisés uniquement pour l’objet déclaré et ne peuvent être utilisés à d’autres fins.",
      valuationDateHeading: "Date de valeur",
      valuationDateBody: (dateStr: string, ccy: string) =>
        `La date de valeur est ${dateStr || "la date d’effet"} ; les valeurs sont exprimées en ${ccy} à cette date.`,
      inspectionHeading: "Inspection",
      inspectionBody: (monthStr?: string) =>
        `Les actifs ont été inspectés ${monthStr ? `en ${monthStr}` : "tel que noté dans le rapport"}. Lorsque la date d’inspection diffère de la date de valeur, aucun changement matériel n’est présumé sauf indication contraire.`,
      hazardousHeading: "Substances dangereuses",
      hazardousBody:
        "Aucune provision n’a été faite pour d’éventuels problèmes environnementaux. L’estimation suppose la conformité aux réglementations applicables et l’absence de matières dangereuses, sauf indication contraire.",
      changeMarketHeading: "Changements des conditions du marché",
      changeMarketBody:
        "Nous ne sommes pas responsables des changements de conditions de marché après la date de valeur et n’avons aucune obligation de réviser le rapport pour des événements ultérieurs.",
      unexpectedHeading: "Conditions imprévues",
      unexpectedBody:
        "On suppose qu’il n’existe pas de conditions cachées ou non apparentes susceptibles d’affecter la valeur. Aucune responsabilité n’est assumée pour de telles conditions.",
      companySubjectHeading: "Entreprise et description des actifs",
      companyDiscussionHeading: "Présentation de l’entreprise",
      companyDiscussionBody: (client: string) =>
        `${client} exploite plusieurs divisions et emplacements. Le mandat porte sur les divisions pertinentes liées aux actifs objet de l’évaluation.`,
      subjectAssetsHeading: "Présentation des actifs",
      subjectAssetsBody:
        "Les principaux actifs comprennent des équipements de construction et de transport. Dans l’ensemble, ils ont été jugés en bon à excellent état, sous réserve des hypothèses et conditions limitatives.",
      approachesHeading: "Approches de valeur",
      costApproachHeading: "Approche par le coût",
      costApproachBody:
        "Procédures par lesquelles l’évaluateur détermine une indication de valeur en estimant le coût actuel de reproduction ou de remplacement des actifs, en déduisant toutes les dépréciations, y compris la détérioration physique, l’obsolescence fonctionnelle et l’obsolescence économique.",
      marketApproachHeading: "Approche par comparaison (marché)",
      marketApproachBody:
        "Procédures par lesquelles l’évaluateur détermine une indication de valeur en comparant les actifs évalués à des actifs similaires récemment vendus et en effectuant les ajustements appropriés.",
      incomeApproachHeading: "Approche par capitalisation du revenu",
      incomeApproachBody:
        "Procédures par lesquelles l’évaluateur détermine une indication de valeur pour des actifs générateurs de revenus en convertissant les avantages anticipés en valeur via la capitalisation ou l’actualisation des flux de trésorerie.",
      alternateUseHeading: "Usage alternatif et marché approprié",
      alternateUseBody:
        "Nous avons pris en compte le marché approprié et le niveau d’échange, la disponibilité de données fiables, les conditions du marché à la date de valeur, et une période de commercialisation cohérente avec l’usage visé.",
      reconciliationHeading: "Rapprochement des approches de valeur",
      reconciliationBody:
        "Les approches du coût et du marché ont été utilisées et rapprochées. L’approche par le revenu a été prise en considération mais non appliquée pour les raisons exposées dans ce rapport.",
      hbuHeading: "Usage optimal",
      hbuBody:
        "Nous avons considéré l’usage optimal des actifs, y compris ce qui est légalement permis, physiquement possible, financièrement réalisable et maximisant la valeur.",
      valProcessHeading: "Processus et méthodologie d’évaluation",
      dataCollectionHeading: "Collecte des données",
      dataCollectionBody: (monthStr?: string) =>
        `Des visites de site ont été effectuées ${monthStr ? `en ${monthStr}` : "au besoin"}. Les échanges avec le personnel du client ont éclairé notre compréhension des opérations et des politiques d’entretien.`,
      valuationProcessHeading2: "Processus de valorisation",
      valuationProcessBody:
        "Nous avons considéré les approches par le revenu, par comparaison et par le coût et retenu les méthodes appropriées selon les types d’actifs et les données disponibles.",
      researchMethodHeading: "Méthodologie de recherche",
      researchMethodBody:
        "La recherche a inclus des résultats d’enchères et de concessionnaires, des données d’OEM, des places de marché d’équipements d’occasion et les conditions de marché/géographiques actuelles pour des actifs similaires.",
      codeEthicsHeading: "Code d’éthique",
      competencyHeading: "Compétence",
      competencyBody:
        "L’évaluateur possède les connaissances et l’expérience appropriées pour produire des résultats crédibles pour l’usage décrit dans ce rapport.",
      confidentialityHeading: "Confidentialité",
      confidentialityBody:
        "Ce rapport et la documentation de travail sont confidentiels. Toute diffusion à des tiers nécessite un consentement écrit préalable.",
      experienceHeading: "EXPÉRIENCE",
      experienceBody1:
        "McDougall Auctioneers est l’une des principales sociétés de vente aux enchères et d’évaluation à service complet de l’Ouest canadien, avec plus de 40 ans d’expérience dans la commercialisation, la vente et l’évaluation d’actifs dans divers secteurs. Basée en Saskatchewan et opérant au Canada et aux États-Unis, McDougall s’est forgé une réputation d’évaluations impartiales et défendables, conformes aux normes de l’industrie et réglementaires.",
      experienceBody2:
        "Notre équipe regroupe des évaluateurs certifiés, des commissaires-priseurs expérimentés et des spécialistes sectoriels ayant inspecté et évalué des dizaines de milliers d’actifs chaque année. Nous réalisons des évaluations complètes d’équipements, de véhicules, de machines industrielles, d’actifs agricoles et d’inventaires, en utilisant des méthodologies reconnues telles que l’approche par le marché, par le coût et, le cas échéant, par le revenu. Toutes les missions sont conformes à l’USPAP et aux lignes directrices canadiennes pertinentes.",
      experienceBody3:
        "La vaste plateforme d’enchères de McDougall nous fournit des données de marché actuelles et réelles sur les ventes comparables. Cette base de données propriétaire étaye nos évaluations avec des éléments probants à jour sur les tendances de prix, la demande et les valeurs de liquidation. Pour l’assurance, le financement, les litiges ou la gestion interne, nos évaluations offrent des valeurs justes, précises et défendables.",
      experienceBody4:
        "Notre expérience couvre la construction, le transport, l’agriculture, les équipements lourds, la fabrication et les inventaires de détail. Nous sommes régulièrement mandatés par des banques, professionnels de l’insolvabilité, avocats, organismes publics et propriétaires privés. Cette profondeur d’expérience garantit des évaluations professionnelles et objectives, et des rapports clairs et documentés acceptés par prêteurs, tribunaux, assureurs et auditeurs.",
    },
    es: {
      assetReport: "Informe de activos",
      reportSummary: "Resumen del informe",
      groupingMode: "Modo de agrupación",
      totalLots: "Total de lotes",
      totalImages: "Total de imágenes",
      summaryOfValue: "Resumen de conclusiones de valor",
      valueBody: (v: string) =>
        `Según nuestro análisis y metodología, estimamos que el valor de los activos reportados es de ${v}.`,
      noValueBody:
        "Según nuestro análisis y metodología, consulte las secciones detalladas para la información de valor.",
      reportDetails: "Detalles del informe",
      lotWord: "Lote",
      perItem: "Por artículo",
      perPhoto: "Por foto",
      singleLot: "Lote único",
      lotsWord: "Lotes",
      mixed: "Mixto",
      page: "Página ",
      contractNo: "Número de contrato",
      // Narrative
      conditionsHeading: "Condiciones de la tasación",
      conditionsBody:
        "El valor indicado en este informe se basa en el mejor juicio del tasador, considerando los hechos y condiciones disponibles a la fecha de valoración. El uso de este informe se limita a determinar el valor de los activos. Debe utilizarse únicamente en su totalidad.",
      purposeHeading: "Propósito de este informe",
      purposeBody: (client: string) =>
        `El propósito de este informe es proporcionar una opinión de valor del sujeto para consideración interna y ayudar a ${client} y al personal designado dentro de su organización a establecer un Valor de Liquidación Ordenada (VLO) actual para fines financieros. No está destinado para ningún otro propósito. En función de ello, hemos valorado los activos bajo el supuesto de VLO.`,
      identHeading: "Identificación de los activos tasados",
      identBody:
        "Como se expone en las secciones adjuntas, los activos tasados en este encargo incluyen: equipos de construcción y transporte.",
      scopeHeading: "Alcance del trabajo",
      scopeIntro:
        "Proceso y metodología de valoración: el tasador empleó los siguientes procedimientos para determinar las conclusiones de valor:",
      scopeBullet1:
        "Revisión y análisis de registros de activos y otros materiales informativos.",
      scopeBullet2:
        "Inspección y análisis de los activos y equipos en las ubicaciones del cliente.",
      observationsHeading: "Observaciones y comentarios",
      observationsBody:
        "Los datos disponibles y los comparables de mercado utilizados tenían hasta 120 días. Se dio mayor peso a comparables recientes específicos de la región cuando estuvieron disponibles.",
      intendedHeading: "Usuarios previstos",
      intendedBody:
        "Esta tasación no debe reproducirse ni utilizarse para fines distintos a los aquí establecidos y es para uso interno del cliente.",
      valueTermHeading: "Terminología del valor",
      valueOLVHeading: "Valor de Liquidación Ordenada (VLO)",
      valueOLVBody: (ccy: string) =>
        `El monto estimado, expresado en efectivo en ${ccy}, que típicamente podría realizarse en una venta de liquidación, con el vendedor obligado a vender en condición “tal como está, donde está”, en una fecha específica y durante un periodo de 120 días.`,
      valueOLVScenarioBody:
        "Para esta tasación, consideramos un escenario de venta privada correctamente anunciada y profesionalmente gestionada, durante 120 días, en operación normal o en proceso de cierre, con el comprador responsable del desmontaje y retiro bajo su propio riesgo y costo.",
      definitionsHeading: "Definiciones y obsolescencia",
      physicalDetHeading: "Deterioro físico",
      physicalDetBody:
        "Forma de depreciación en la que la pérdida de valor o utilidad se debe al desgaste, deterioro, exposición a elementos, tensiones físicas y factores similares.",
      functionalObsHeading: "Obsolescencia funcional",
      functionalObsBody:
        "Forma de depreciación en la que la pérdida de valor o utilidad es causada por ineficiencias o insuficiencias propias del activo frente a un reemplazo más eficiente o económico que ofrece la tecnología más reciente.",
      economicObsHeading: "Obsolescencia económica",
      economicObsBody:
        "Forma de depreciación o pérdida de valor causada por factores externos como la economía del sector, la disponibilidad de financiamiento, la legislación, el aumento de costos sin incrementos de precio compensatorios, la baja demanda, la mayor competencia, la inflación o tasas de interés altas.",
      depreciationHeading: "Depreciación",
      depreciationBody:
        "Pérdida real de valor o de utilidad de un bien por todas las causas, incluyendo deterioro físico, obsolescencia funcional y obsolescencia económica.",
      limitingHeading: "Condiciones limitantes y supuestos críticos",
      assetCondHeading: "Condición de los activos",
      assetCondBody:
        "Se proporcionó cierta información al tasador sobre reparaciones, motores, trenes de rodaje y mejoras. Se consideró al tasar y comparar los activos con comparables de mercado. Algunos activos pueden tener garantías extendidas.",
      titleAssetsHeading: "Título de los activos",
      titleAssetsBody:
        "No se ha investigado ni se asume responsabilidad por asuntos legales, incluidos título o gravámenes. Se presume que el título es válido y negociable salvo indicación en contrario.",
      responsibleOwnHeading: "Propiedad responsable",
      responsibleOwnBody:
        "Se asume que los activos están bajo propiedad responsable y gestión competente.",
      statedPurposeHeading: "Propósito declarado",
      statedPurposeBody:
        "Esta tasación y el informe se han realizado únicamente para el propósito declarado y no pueden usarse para otro fin.",
      valuationDateHeading: "Fecha de valoración",
      valuationDateBody: (dateStr: string, ccy: string) =>
        `La fecha de valoración es ${dateStr || "la fecha de vigencia"}; los valores están en ${ccy} a esa fecha.`,
      inspectionHeading: "Inspección",
      inspectionBody: (monthStr?: string) =>
        `Los activos fueron inspeccionados ${monthStr ? `en ${monthStr}` : "según se indica en el informe"}. Cuando la fecha de inspección difiera de la fecha de valoración, se asume que no hubo cambios materiales salvo que se indique lo contrario.`,
      hazardousHeading: "Sustancias peligrosas",
      hazardousBody:
        "No se ha hecho ninguna provisión por posibles problemas ambientales. La estimación de valor supone cumplimiento pleno con la normativa y ausencia de materiales peligrosos salvo que se indique.",
      changeMarketHeading: "Cambios en las condiciones del mercado",
      changeMarketBody:
        "No somos responsables de cambios en las condiciones del mercado posteriores a la fecha de valoración ni estamos obligados a revisar el informe por eventos subsecuentes.",
      unexpectedHeading: "Condiciones imprevistas",
      unexpectedBody:
        "Se asume que no existen condiciones ocultas o no evidentes que afecten el valor. No se asume responsabilidad por tales condiciones.",
      companySubjectHeading: "Empresa y descripción de los activos",
      companyDiscussionHeading: "Descripción de la empresa",
      companyDiscussionBody: (client: string) =>
        `${client} opera en múltiples divisiones y ubicaciones. El encargo se centra en las divisiones relacionadas con los activos objeto de esta tasación.`,
      subjectAssetsHeading: "Descripción de los activos",
      subjectAssetsBody:
        "Los principales activos incluyen equipos de construcción y transporte. En general, se encontraron en buen a excelente estado, sujeto a las condiciones y supuestos limitantes.",
      approachesHeading: "Enfoques de valoración",
      costApproachHeading: "Enfoque del costo",
      costApproachBody:
        "Procedimientos mediante los cuales el tasador determina una indicación de valor estimando el costo actual de reproducir o reemplazar los activos, deduciendo toda depreciación, incluyendo deterioro físico, obsolescencia funcional y obsolescencia económica.",
      marketApproachHeading: "Enfoque de comparación de ventas (mercado)",
      marketApproachBody:
        "Procedimientos mediante los cuales el tasador determina una indicación de valor comparando los activos con otros similares vendidos recientemente y realizando los ajustes necesarios.",
      incomeApproachHeading: "Enfoque de capitalización de ingresos",
      incomeApproachBody:
        "Procedimientos mediante los cuales el tasador determina una indicación de valor para activos generadores de ingresos convirtiendo los beneficios anticipados en valor mediante capitalización o descuento de flujos.",
      alternateUseHeading: "Uso alternativo y mercado apropiado",
      alternateUseBody:
        "Se consideró el mercado adecuado y el nivel de intercambio, la disponibilidad de datos confiables, las condiciones del mercado a la fecha de valoración y un periodo de comercialización acorde con el uso previsto.",
      reconciliationHeading: "Conciliación de enfoques de valoración",
      reconciliationBody:
        "Se utilizaron y conciliaron los enfoques de Costo y de Mercado. El enfoque de Ingresos fue considerado pero no aplicado por las razones expuestas en este informe.",
      hbuHeading: "Máximo y mejor uso",
      hbuBody:
        "Se consideró el máximo y mejor uso de los activos, incluyendo lo legalmente permitido, físicamente posible, financieramente factible y que maximiza la productividad.",
      valProcessHeading: "Proceso y metodología de valoración",
      dataCollectionHeading: "Recopilación de datos",
      dataCollectionBody: (monthStr?: string) =>
        `Se realizaron visitas a sitio ${monthStr ? `en ${monthStr}` : "según fue necesario"}. Las conversaciones con el personal del cliente ayudaron a comprender operaciones y políticas de mantenimiento.`,
      valuationProcessHeading2: "Proceso de valoración",
      valuationProcessBody:
        "Se consideraron los enfoques de ingresos, comparación de ventas y costo, concluyendo los métodos apropiados según los tipos de activos y los datos disponibles.",
      researchMethodHeading: "Metodología de investigación",
      researchMethodBody:
        "La investigación incluyó resultados de subastas y concesionarios, datos de OEM, mercados de equipos usados y condiciones de mercado/geográficas actuales para activos similares.",
      codeEthicsHeading: "Código de ética",
      competencyHeading: "Competencia",
      competencyBody:
        "El tasador posee el conocimiento y la experiencia adecuados para desarrollar resultados confiables para el propósito y uso descritos en este informe.",
      confidentialityHeading: "Confidencialidad",
      confidentialityBody:
        "Este informe y la documentación de respaldo son confidenciales. La distribución a terceros requiere consentimiento previo por escrito.",
      experienceHeading: "EXPERIENCIA",
      experienceBody1:
        "McDougall Auctioneers es una de las principales firmas de subastas y valoración de servicio completo en el oeste de Canadá, con más de 40 años de experiencia en comercialización, venta y tasación de activos en diversos sectores. Con sede en Saskatchewan y operaciones en Canadá y Estados Unidos, McDougall se ha ganado una reputación por valoraciones imparciales y defendibles que cumplen o superan las normas de la industria y regulatorias.",
      experienceBody2:
        "Nuestro equipo combina tasadores certificados de bienes muebles, subastadores experimentados y especialistas en la materia que inspeccionan y valoran decenas de miles de activos al año. Realizamos tasaciones integrales de equipos, vehículos, maquinaria industrial, activos agrícolas e inventarios, utilizando metodologías reconocidas como los enfoques de Mercado, Costo y, cuando corresponde, Ingresos. Todas las asignaciones se realizan conforme al USPAP y a las directrices canadienses pertinentes.",
      experienceBody3:
        "La amplia plataforma de subastas de McDougall nos proporciona datos de mercado actuales y reales sobre ventas comparables. Esta base de datos propietaria respalda nuestras valoraciones con evidencia actualizada de tendencias de precios, fluctuaciones de demanda y valores de liquidación. Ya sea para seguros, financiamiento, litigios o gestión interna, nuestras tasaciones proporcionan valores justos, oportunos y defendibles.",
      experienceBody4:
        "Nuestra experiencia cubre construcción, transporte, agricultura, equipo pesado, manufactura e inventarios minoristas. Con frecuencia trabajamos para bancos, profesionales de insolvencia, abogados, organismos gubernamentales y propietarios privados. Esta profundidad de experiencia garantiza profesionalismo y objetividad en cada tasación, con informes claros y bien documentados aceptados por prestamistas, tribunales, aseguradoras y auditores.",
    },
  }[lang];
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const rootImageUrls: string[] = Array.isArray(reportData?.imageUrls)
    ? reportData.imageUrls
    : [];
  const contentWidthTw = convertInchesToTwip(7);
  const scheduleContentWidthTw = convertInchesToTwip(10);
  // Portrait and landscape widths are separate layout contracts. Passing the
  // wrong width to a builder causes Word to reflow fixed tables unpredictably.
  const appraisalStyle = {
    monochrome: true,
    compact: false,
    font: "Times New Roman",
  } as const;
  const appraisalDivider = () => goldDivider("111111", true);

  // Load logo from public to create
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    logoBuffer = await fs.readFile(logoPath);
  } catch {
    logoBuffer = null;
  }

  // The proposal layout uses the original full-colour corporate logo on all
  // pages. Body copy, rules, and headings remain monochrome.
  const appraisalLogoBuffer = logoBuffer;

  // Header table via builder
  const headerTable = buildHeaderTable(
    appraisalLogoBuffer,
    contentWidthTw,
    (reportData as any)?.user_email,
    appraisalStyle
  );

  // Footer table via builder (with corporate address and appraiser details)
  const footerTable = buildFooterTable(
    contentWidthTw,
    reportData?.appraiser || (reportData as any)?.inspector_name,
    (reportData as any)?.user_email,
    appraisalStyle
  );

  // Landscape Schedule A needs the same proposal block sized to its wider page.
  const scheduleHeaderTable = buildHeaderTable(
    appraisalLogoBuffer,
    scheduleContentWidthTw,
    (reportData as any)?.user_email,
    appraisalStyle
  );
  const scheduleFooterTable = buildFooterTable(
    scheduleContentWidthTw,
    reportData?.appraiser || (reportData as any)?.inspector_name,
    (reportData as any)?.user_email,
    appraisalStyle
  );

  const includeCover = !(reportData as any)?.custom_cover;
  // `custom_cover` is an external merge boundary: omit the generated cover so a
  // merger can prepend the supplied document without leaving a duplicate page.

  const children: Array<Paragraph | Table | TableOfContents> = [];
  const reportDate = formatDateUS(
    reportData?.createdAt || new Date().toISOString()
  );

  children.push(...buildAppraisalOverview(reportData, contentWidthTw));

  // Additional narrative sections (aligned with Catalogue report)
  const purposeClient = toTitleCaseWords(reportData?.client_name) || "XYZ Ltd";
  const valuationMethods = resolveSelectedAssetValuationMethods(reportData);
  const valuationMethodNames = valuationMethods
    .map((method) => method.label)
    .join(" and ");

  // Conditions of Appraisal
  children.push(
    new Paragraph({
      text: t.conditionsHeading,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 120 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: t.conditionsBody,
    })
  );

  // Purpose of This Report
  children.push(
    new Paragraph({
      text: t.purposeHeading,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: valuationMethods.length
        ? `The purpose of this appraisal report is to provide an opinion of value of the subject assets for internal consideration and to assist ${purposeClient} and the specified personnel within their organization in establishing ${valuationMethodNames}. This report is not intended to be used for any other purpose. Based on the purpose of the appraisal, we have valued the subject assets under the selected premise${valuationMethods.length === 1 ? "" : "s"}.`
        : `This report describes the subject assets for ${purposeClient} and their specified personnel for internal consideration. No valuation methods were selected.`,
    })
  );

  // Scope of Work
  children.push(
    new Paragraph({
      text: t.scopeHeading,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: false,
      spacing: { after: 100 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: t.scopeIntro,
      spacing: { after: 60 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: t.scopeBullet1,
      bullet: { level: 0 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: t.scopeBullet2,
      bullet: { level: 0 },
    })
  );

  // Factors Affecting Value
  children.push(
    new Paragraph({
      text: "Factors Affecting Value",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: false,
      spacing: { after: 80 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({ text: "AGE & CONDITION:", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text:
        (reportData as any)?.factors_age_condition ||
        "The assets are of average age and appear to be in average condition. Regular maintenance and cleaning appears to have been completed as required. This is based on a visual inspection only and no review of maintenance records.",
    })
  );
  children.push(
    new Paragraph({ text: "QUALITY:", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text:
        (reportData as any)?.factors_quality ||
        "Some items are brand names that are recognized in the industry.",
    })
  );
  children.push(
    new Paragraph({ text: "ANALYSIS:", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text:
        (reportData as any)?.factors_analysis ||
        "In a general overview listing of these items, some assets are household, and some assets are for a chiropractor and massage clinic. Sentimental items do not reflect the actual physical value of an item and therefore we must value accordingly. The values given are based off the information provided.",
    })
  );
  if (resolveDamageAnalysisEnabled((reportData as any)?.include_damage_analysis, true)) {
    // Rebuild the report summary exclusively from eligible lots. A stale
    // report-level summary may still contain text from a lot that was later
    // renumbered above 1000, so it is never trusted at this output boundary.
    const damageText = formatDamageAnalysisDisplayText(
      buildPolicySafeReportDamageAnalysis(
        Array.isArray((reportData as any)?.lots)
          ? ((reportData as any).lots as any[])
          : [],
        (reportData as any)?.damage_analysis,
        true
      )
    );
    if (damageText) {
      children.push(
        new Paragraph({
          text: `${DAMAGE_ANALYSIS_LABEL.toUpperCase()}:`,
          heading: HeadingLevel.HEADING_2,
        })
      );
      children.push(
        new Paragraph({
          style: "BodyLarge",
          text: damageText,
        })
      );
    }
  }

  // Value Terminology
  children.push(
    new Paragraph({
      text: t.valueTermHeading,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 60 },
    })
  );
  children.push(appraisalDivider());
  for (const method of valuationMethods) {
    children.push(
      new Paragraph({
        text: `${method.label} (${method.code})`,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 40 },
      })
    );
    children.push(
      new Paragraph({
        style: "BodyLarge",
        text: method.definition,
      })
    );
  }

  // Limiting Conditions and Critical Assumptions
  children.push(
    new Paragraph({
      text: t.limitingHeading,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(appraisalDivider());
  // Preamble replacing removed "Asset Conditions"
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "This appraisal report and the above noted recovery values are based on a subject to the following conditions, qualifications, assumptions, and limitations:",
    })
  );
  children.push(
    new Paragraph({
      text: t.titleAssetsHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "No investigation has been made of, and no responsibility is assumed for, the legal description or for legal matters including title or encumbrances. Unless otherwise noted in this report, title to the property is assumed to be good and marketable. The property is valued as if it is free and clear of liens, easements, encroachments, and other encumbrances unless otherwise stated, and all improvements are assumed to lie within property boundaries. Conducting a title search is outside the scope of this appraisal.",
    })
  );
  children.push(
    new Paragraph({
      text: t.responsibleOwnHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "It is assumed that subject assets are under responsible ownership and competent management. No allowance has been made for possible liens or encumbrances that may be against the property other than those discussed in the report.",
    })
  );
  children.push(
    new Paragraph({
      text: t.statedPurposeHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "This appraisal and report have been made only for the purpose stated within the transmittal letter and the body of this appraisal report. This report cannot be used for any other purpose.",
    })
  );
  children.push(
    new Paragraph({
      text: t.valuationDateHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The valuation date to which the conclusions and opinions expressed in this report apply is set forth in the transmittal letter and in the report. The dollar amount of any value reported is based on the purchasing power of the Canadian dollar (or the currency specified in the report) as of that date.",
    })
  );
  children.push(
    new Paragraph({
      text: t.inspectionHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The subject assets were inspected as noted in the body of the report. When the date of inspection differs from the valuation date, we have assumed no material change in the condition of the property unless otherwise noted in the report.",
    })
  );
  children.push(
    new Paragraph({ text: t.hazardousHeading, heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "No allowance has been made nor was any consideration given to potential environmental problems and the possible impact those problems would have on the findings within this appraisal. It is assumed that there is full compliance with all applicable environmental regulations and laws unless non-compliance is stated, defined and considered in the appraisal report. We have not been engaged nor are we qualified to detect the existence of hazardous material, which may or may not be present on or near the property. The presence of potentially hazardous substances such as asbestos, urea-formaldehyde foam insulation, industrial wastes, etc. may affect the value of the property. The value estimate herein is predicated on the assumption that there is no such material on, in or near the property that would cause a loss in value. No responsibility is assumed for any such conditions or for any expertise or engineering knowledge required to discover them. The client should retain an expert in this field if further information is desired.",
    })
  );
  children.push(
    new Paragraph({
      text: t.changeMarketHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "McDougall Auctioneers Ltd. is not responsible for changes in market conditions and no obligation is assumed to revise this report to reflect events or conditions which occur subsequent to the valuation date. Additionally, McDougall Auctioneers Ltd. cannot be held responsible for the inability of the owner to locate a purchaser at the appraised value.",
    })
  );
  children.push(
    new Paragraph({
      text: t.unexpectedHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "It is assumed that there are no hidden or non-apparent conditions of the property that would affect the value of the subject assets. No responsibility is assumed for such conditions or for arranging for engineering studies that may be required to discover them.",
    })
  );
  // Additional limiting statements
  children.push(
    new Paragraph({
      text: "CONFIDENTIALITY / MARKETING",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "This report and supporting files documentation are confidential. No part of the contents of this appraisal (including the report and the supporting file documentation) shall be disclosed to any party, or conveyed orally or in writing through advertising, public relations, news, sales, or in any other manner without the prior written consent and approval of both McDougall Auctioneers Ltd. and the client.",
    })
  );
  children.push(
    new Paragraph({ text: "COURT TESTIMONY", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "Neither McDougall Auctioneers Ltd. or any individuals signing or associated with this report shall be required by reason of this report to give further consultation, to provide testimony, or appear in court or other legal proceedings unless specific arrangements for such services have been made.",
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "Since conclusions by the appraiser are based upon judgements, isolation of any single element as the sole basis for comparison to the whole appraisal may be inaccurate.",
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The effective date of the appraisal establishes the current value and is not prospective or retrospective.",
    })
  );

  // Approaches to Value
  children.push(
    new Paragraph({
      text: t.approachesHeading,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 80 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({
      text: t.costApproachHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.costApproachBody })
  );
  children.push(
    new Paragraph({
      text: t.marketApproachHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.marketApproachBody })
  );
  children.push(
    new Paragraph({
      text: t.incomeApproachHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.incomeApproachBody })
  );
  children.push(
    new Paragraph({
      text: t.alternateUseHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.alternateUseBody })
  );
  children.push(
    new Paragraph({
      text: t.reconciliationHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.reconciliationBody })
  );
  children.push(
    new Paragraph({ text: t.hbuHeading, heading: HeadingLevel.HEADING_2 })
  );
  children.push(new Paragraph({ style: "BodyLarge", text: t.hbuBody }));

  // Valuation Process and Methodology
  children.push(
    new Paragraph({
      text: t.valProcessHeading,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: false,
      spacing: { after: 80 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({
      text: t.dataCollectionHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: t.dataCollectionBody(
        formatMonthYear(reportData?.inspection_date) || undefined
      ),
    })
  );
  children.push(
    new Paragraph({
      text: t.valuationProcessHeading2,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.valuationProcessBody })
  );
  children.push(
    new Paragraph({
      text: t.researchMethodHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", text: t.researchMethodBody })
  );

  // Code of Ethics
  children.push(
    new Paragraph({
      text: t.codeEthicsHeading,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      keepNext: true,
      spacing: { after: 80 },
    })
  );
  children.push(appraisalDivider());
  children.push(
    new Paragraph({
      text: t.competencyHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(new Paragraph({ text: t.competencyBody, style: "BodyLarge" }));
  children.push(
    new Paragraph({
      text: t.confidentialityHeading,
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({ text: t.confidentialityBody, style: "BodyLarge" })
  );
  // Signature block (as requested)
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: "______________________________", color: "A3A3A3" })],
      spacing: { before: 120, after: 20 },
    })
  );
  children.push(
    new Paragraph({ style: "BodyLarge", children: [new TextRun({ text: "Sincerely," })], spacing: { after: 360 } })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: "______________________________", color: "111111" })],
      spacing: { after: 60 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [new TextRun({ text: toTitleCaseWords(reportData?.appraiser) || "Appraiser Name" })],
      spacing: { after: 40 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text:
            toTitleCaseWords(
              reportData?.appraiser_role ||
                reportData?.appraiser_title ||
                reportData?.inspector_role
            ) || "Certified Appraiser",
        }),
      ],
      spacing: { after: 40 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text:
            toTitleCaseWords(reportData?.appraisal_company) ||
            "McDougall Auctioneers Ltd.",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  // Legacy per-lot detail pages were removed from the Asset appraisal DOCX.
  // Schedule A remains as the asset listing output.
  /*
  // Results: table per mixed lot group, using sub-mode specific layout
  // Group lots by mixed_group_index
  const groupMap = new Map<number, any[]>();
  for (const lot of lots) {
    const gi = Number(lot?.mixed_group_index) || 0;
    if (!groupMap.has(gi)) groupMap.set(gi, []);
    groupMap.get(gi)!.push(lot);
  }
  const groupIds = Array.from(groupMap.keys())
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const useGroupIds = groupIds.length ? groupIds : [0];

  for (const gid of useGroupIds) {
    const items = groupMap.get(gid) || lots;
    const subMode: string = String(
      items[0]?.sub_mode ||
        (items[0]?.tags || [])
          .find?.((t: string) => typeof t === "string" && t.startsWith("mode:"))
          ?.split?.(":")?.[1] ||
        "single_lot"
    );
    const label = `${t.lotWord} ${gid || 1} — ${subMode === "per_item" ? t.perItem : subMode === "per_photo" ? t.perPhoto : t.singleLot}`;

    if (subMode === "per_item") {
      const pseudo = { ...reportData, lots: items };
      children.push(
        ...(await buildPerItemTable(
          pseudo,
          rootImageUrls,
          contentWidthTw,
          label
        ))
      );
      // Render extra images once for this mixed group (report-only)
      try {
        const first = items[0] || {};
        let extraUrls: string[] = Array.isArray(
          (first as any)?.extra_image_urls
        )
          ? ((first as any).extra_image_urls as string[]).filter(Boolean)
          : [];
        if (
          !extraUrls.length &&
          Array.isArray((first as any)?.extra_image_indexes)
        ) {
          extraUrls = ((first as any).extra_image_indexes as number[])
            .map((i) =>
              Number.isFinite(i) && i >= 0 ? rootImageUrls[i] : undefined
            )
            .filter(Boolean) as string[];
        }
        extraUrls = Array.from(new Set(extraUrls));
        if (extraUrls.length) {
          children.push(
            new Paragraph({
              text: "Additional Images",
              heading: HeadingLevel.HEADING_3,
              spacing: { before: 120, after: 80 },
            })
          );
          const gridCols = 4;
          const cellW = Math.round(contentWidthTw / gridCols);
          const imgCellMargins = {
            top: 60,
            bottom: 60,
            left: 60,
            right: 60,
          } as const;
          const bufs = await Promise.all(
            extraUrls.map((u) => fetchImageBuffer(u))
          );
          const rows: TableRow[] = [];
          for (let i = 0; i < bufs.length; i += gridCols) {
            const slice = bufs.slice(i, i + gridCols);
            rows.push(
              new TableRow({
                cantSplit: true,
                children: Array.from({ length: gridCols }, (_, col) => {
                  const b = slice[col];
                  return new TableCell({
                    width: { size: cellW, type: WidthType.DXA },
                    margins: imgCellMargins,
                    children: b
                      ? [
                          new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [
                              new ImageRun({
                                data: b as any,
                                transformation: { width: 160, height: 120 },
                              } as any),
                            ],
                          }),
                        ]
                      : [new Paragraph({ text: "" })],
                  });
                }),
              })
            );
          }
          children.push(
            new Table({
              width: { size: contentWidthTw, type: WidthType.DXA },
              layout: TableLayoutType.FIXED,
              columnWidths: Array.from({ length: gridCols }).map(() => cellW),
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                left: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                right: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                insideHorizontal: {
                  style: BorderStyle.SINGLE,
                  size: 1,
                  color: "F3F4F6",
                },
                insideVertical: {
                  style: BorderStyle.SINGLE,
                  size: 1,
                  color: "F3F4F6",
                },
              },
              rows,
            })
          );
        }
      } catch {}
    } else if (subMode === "per_photo") {
      children.push(
        ...(await buildPerPhotoTable(
          items,
          rootImageUrls,
          contentWidthTw,
          label,
          (reportData as any)?.currency
        ))
      );
      // Render extra images once for this mixed group (report-only)
      try {
        const first = items[0] || {};
        let extraUrls: string[] = Array.isArray(
          (first as any)?.extra_image_urls
        )
          ? ((first as any).extra_image_urls as string[]).filter(Boolean)
          : [];
        if (
          !extraUrls.length &&
          Array.isArray((first as any)?.extra_image_indexes)
        ) {
          extraUrls = ((first as any).extra_image_indexes as number[])
            .map((i) =>
              Number.isFinite(i) && i >= 0 ? rootImageUrls[i] : undefined
            )
            .filter(Boolean) as string[];
        }
        extraUrls = Array.from(new Set(extraUrls));
        if (extraUrls.length) {
          children.push(
            new Paragraph({
              text: "Additional Images",
              heading: HeadingLevel.HEADING_3,
              spacing: { before: 120, after: 80 },
            })
          );
          const gridCols = 4;
          const cellW = Math.round(contentWidthTw / gridCols);
          const imgCellMargins = {
            top: 60,
            bottom: 60,
            left: 60,
            right: 60,
          } as const;
          const bufs = await Promise.all(
            extraUrls.map((u) => fetchImageBuffer(u))
          );
          const rows: TableRow[] = [];
          for (let i = 0; i < bufs.length; i += gridCols) {
            const slice = bufs.slice(i, i + gridCols);
            rows.push(
              new TableRow({
                cantSplit: true,
                children: Array.from({ length: gridCols }, (_, col) => {
                  const b = slice[col];
                  return new TableCell({
                    width: { size: cellW, type: WidthType.DXA },
                    margins: imgCellMargins,
                    children: b
                      ? [
                          new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [
                              new ImageRun({
                                data: b as any,
                                transformation: { width: 160, height: 120 },
                              } as any),
                            ],
                          }),
                        ]
                      : [new Paragraph({ text: "" })],
                  });
                }),
              })
            );
          }
          children.push(
            new Table({
              width: { size: contentWidthTw, type: WidthType.DXA },
              layout: (Table as any).LayoutType?.FIXED || undefined,
              columnWidths: Array.from({ length: gridCols }).map(() => cellW),
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                left: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                right: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
                insideHorizontal: {
                  style: BorderStyle.SINGLE,
                  size: 1,
                  color: "F3F4F6",
                },
                insideVertical: {
                  style: BorderStyle.SINGLE,
                  size: 1,
                  color: "F3F4F6",
                },
              },
              rows,
            })
          );
        }
      } catch {}
    } else {
      const pseudo = { ...reportData, lots: items };
      children.push(
        ...(await buildAssetLots(pseudo, rootImageUrls, contentWidthTw, label))
      );
    }
  }

  */

  // Valuation Comparison Table (if enabled)
  if (reportData?.include_valuation_table) {
    console.log('[mixedDocxBuilder] Valuation table requested');
    console.log('[mixedDocxBuilder] include_valuation_table:', reportData?.include_valuation_table);
    console.log('[mixedDocxBuilder] valuation_data:', reportData?.valuation_data);
    console.log('[mixedDocxBuilder] valuation_methods:', reportData?.valuation_methods);
    
    if (reportData?.valuation_data) {
      try {
        const { buildValuationTable } = await import(
          "./builders/valuationTable.js"
        );
        children.push(
          ...(await buildValuationTable(reportData, lang, appraisalStyle))
        );
        console.log('[mixedDocxBuilder] Valuation table added successfully');
      } catch (error) {
        console.error('[mixedDocxBuilder] Failed to build valuation table:', error);
      }
    } else {
      console.warn('[mixedDocxBuilder] Valuation table requested but valuation_data is missing or null');
    }
  }

  // Certification (separate page)
  children.push(...buildCertificationSection(reportData));

  // Optional: Appraiser CV link (shown only if explicitly allowed)
  if (reportData?.user_cv_url && reportData?.show_cv_link === true) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "Appraiser CV: ",
            bold: true,
            color: "111111",
            font: "Times New Roman",
          }),
          new TextRun({
            text: String(reportData.user_cv_filename || reportData.user_cv_url),
            color: "111111",
            font: "Times New Roman",
            underline: {},
          }),
          new TextRun({ text: "\n" }),
          new TextRun({
            text: String(reportData.user_cv_url),
            color: "111111",
            font: "Times New Roman",
            underline: {},
          }),
        ],
        spacing: { before: 140, after: 100 },
      })
    );
  }

  const scheduleAChildren = await buildAssetScheduleSection(
    reportData,
    scheduleContentWidthTw
  );

  const marketOverviewChildren = await buildMarketOverview(reportData, {
    pageBreakBefore: false,
    monochrome: true,
    compact: false,
  });

  // Finalize document with sections and pack
  // Document structure:
  // 1. Cover (optional, no header/footer) - merged externally if custom_cover is set
  // 2. Portrait report sections use the proposal-style header/footer.
  // 3. The Certificate of Value is a dedicated full-page branded section.
  // 4. Schedule A uses that same block sized to its landscape content width.
  // 5. Appraiser CV (optional, merged externally, no header/footer)
  const docSections: any[] = [];
  // Push sections in final reading order. The array is deliberately assembled
  // conditionally rather than filtered later so optional merge points stay clear.
  if (includeCover) {
    docSections.push({
      properties: {
        page: {
          size: {
            width: convertInchesToTwip(8.5),
            height: convertInchesToTwip(11),
            orientation: PageOrientation.PORTRAIT,
          },
          margin: {
            top: convertInchesToTwip(0),
            right: convertInchesToTwip(0),
            bottom: convertInchesToTwip(0),
            left: convertInchesToTwip(0),
          },
        },
      },
      headers: { default: new Header({ children: [] }) },
      footers: { default: new Footer({ children: [] }) },
      children: [
        await buildCover(
          reportData,
          logoBuffer,
          contentWidthTw,
          "Appraisal Report"
        ),
      ],
    });
  }

  docSections.push({
    properties: {
      type: SectionType.NEXT_PAGE,
      titlePage: false,
      page: {
        margin: {
          top: convertInchesToTwip(0.65),
          right: convertInchesToTwip(0.75),
          bottom: convertInchesToTwip(0.65),
          left: convertInchesToTwip(0.75),
        },
        pageNumbers: { start: 2 },
      },
    },
    headers: { default: new Header({ children: [headerTable] }) },
    footers: { default: new Footer({ children: [footerTable] }) },
    children: buildTransmittalLetter(reportData, reportDate, appraisalStyle),
  });

  docSections.push({
    properties: {
      type: SectionType.NEXT_PAGE,
      titlePage: false,
      page: {
        margin: {
          top: convertInchesToTwip(0.65),
          right: convertInchesToTwip(0.75),
          bottom: convertInchesToTwip(0.65),
          left: convertInchesToTwip(0.75),
        },
      },
    },
    headers: { default: new Header({ children: [headerTable] }) },
    footers: { default: new Footer({ children: [footerTable] }) },
    children: buildTOC(reportData, true, contentWidthTw, appraisalStyle),
  });

  if (marketOverviewChildren.length > 0) {
    docSections.push({
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          margin: {
            top: convertInchesToTwip(0.65),
            right: convertInchesToTwip(0.75),
            bottom: convertInchesToTwip(0.65),
            left: convertInchesToTwip(0.75),
          },
        },
      },
      headers: { default: new Header({ children: [headerTable] }) },
      footers: { default: new Footer({ children: [footerTable] }) },
      children: marketOverviewChildren,
    });
  }

  docSections.push({
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        size: {
          width: convertInchesToTwip(8.5),
          height: convertInchesToTwip(11),
          orientation: PageOrientation.PORTRAIT,
        },
        margin: {
          top: convertInchesToTwip(0.5),
          right: convertInchesToTwip(0.5),
          bottom: convertInchesToTwip(0.5),
          left: convertInchesToTwip(0.5),
        },
      },
    },
    headers: { default: new Header({ children: [] }) },
    footers: { default: new Footer({ children: [] }) },
    children: (await buildCertificateOfAppraisal(
      reportData,
      contentWidthTw,
      reportDate,
      appraisalStyle
    )) as any,
  });

  docSections.push({
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        margin: {
          top: convertInchesToTwip(0.65),
          right: convertInchesToTwip(0.75),
          bottom: convertInchesToTwip(0.65),
          left: convertInchesToTwip(0.75),
        },
      },
    },
    headers: { default: new Header({ children: [headerTable] }) },
    footers: { default: new Footer({ children: [footerTable] }) },
    children,
  });

  docSections.push({
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        size: { orientation: PageOrientation.LANDSCAPE },
        margin: {
          top: convertInchesToTwip(0.55),
          right: convertInchesToTwip(0.5),
          bottom: convertInchesToTwip(0.55),
          left: convertInchesToTwip(0.5),
        },
      },
    },
    headers: { default: new Header({ children: [scheduleHeaderTable] }) },
    footers: { default: new Footer({ children: [scheduleFooterTable] }) },
    children: scheduleAChildren,
  });

  // Styles are shared across all sections, while each section owns its page size,
  // margins, header/footer, and numbering behavior.
  const doc = new Document({
    creator:
      (reportData?.appraiser as string) ||
      (reportData?.inspector_name as string) ||
      "Asset Insight",
    title:
      (reportData?.title as string) ||
      `${t.assetReport} - ${lots.length} ${t.lotsWord} (${t.mixed})`,
    features: { updateFields: true },
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: "decimal",
              text: "%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 20, color: "111111" },
          paragraph: { spacing: { line: 250, before: 0, after: 80 } },
        },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          basedOn: "",
          next: "Normal",
          run: { font: "Times New Roman", size: 20, color: "111111" },
          paragraph: { spacing: { line: 250, after: 80 } },
        },
        {
          id: "BodyLarge",
          name: "Body Large",
          basedOn: "Normal",
          next: "BodyLarge",
          quickFormat: true,
          run: { font: "Times New Roman", size: 20, color: "111111" },
          paragraph: { spacing: { line: 250, before: 0, after: 100 } },
        },
        {
          id: "TableSmall",
          name: "Table Small",
          basedOn: "Normal",
          next: "TableSmall",
          quickFormat: true,
          run: { font: "Times New Roman", size: 18, color: "111111" },
          paragraph: { spacing: { line: 240, before: 0, after: 30 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: "Times New Roman",
            size: 26,
            bold: true,
            color: "111111",
          },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { before: 260, after: 90 },
            outlineLevel: 0,
          },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: "Times New Roman",
            size: 22,
            bold: true,
            color: "111111",
          },
          paragraph: { spacing: { before: 140, after: 60 }, outlineLevel: 1 },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: "Times New Roman",
            size: 20,
            bold: true,
            color: "111111",
          },
          paragraph: { spacing: { before: 100, after: 50 }, outlineLevel: 2 },
        },
      ],
    },
    sections: docSections,
  });

  // Return a fully packed DOCX; downstream custom-cover/CV merging operates on
  // this buffer and must not need to understand the internal child graph.
  const buf = await Packer.toBuffer(doc);
  return buf;
}
