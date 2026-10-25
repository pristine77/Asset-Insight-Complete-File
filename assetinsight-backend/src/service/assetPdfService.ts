/**
 * Renders the complete asset report through an isolated Puppeteer page. Data shaping,
 * template resolution, page numbering, and browser cleanup live together so callers
 * receive a deterministic buffer and no browser resources survive either success or
 * failure.
 */
import puppeteer from "puppeteer";
import handlebars from "handlebars";
import fs from "fs/promises";
import path from "path";
import {
  configurePuppeteerPageTimeouts,
  PUPPETEER_NAVIGATION_TIMEOUT_MS,
} from "../utils/puppeteerTimeout.js";
import {
  fetchCanadaAndNorthAmericaIndicators,
  generateTrendChartImage,
  generateBarChartImage,
} from "./marketIntelService.js";
import { toTitleCaseWords } from "./docx/builders/utils.js";

// Helpers
handlebars.registerHelper("formatDate", function (dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
});
// Equality helper for simple comparisons in templates
handlebars.registerHelper("eq", function (a: any, b: any) {
  return a === b;
});
// Title-case helper for templates
handlebars.registerHelper("titleCase", function (value: any) {
  return toTitleCaseWords(value);
});

export async function generateAssetPdfFromReport(
  reportData: any
): Promise<Buffer> {
  try {
    const templatePath = path.resolve(
      process.cwd(),
      reportData?.grouping_mode === "per_item"
        ? "src/templates/asset_per_item.html"
        : reportData?.grouping_mode === "catalogue"
          ? "src/templates/catalogue.html"
          : reportData?.grouping_mode === "mixed"
            ? "src/templates/asset_mixed.html"
            : "src/templates/asset.html"
    );
    const htmlTemplate = await fs.readFile(templatePath, "utf-8");

    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    const logoImage = await fs.readFile(logoPath);
    const logoBase64 = logoImage.toString("base64");
    const logoUrl = `data:image/jpeg;base64,${logoBase64}`;

    const template = handlebars.compile(htmlTemplate);

    const sanitizedData = JSON.parse(JSON.stringify(reportData));

    // Title-case lot titles, descriptions, details, and condition for PDF
    if (Array.isArray(sanitizedData.lots)) {
      for (const lot of sanitizedData.lots) {
        if (lot.title) lot.title = toTitleCaseWords(lot.title);
        if (lot.description) lot.description = toTitleCaseWords(lot.description);
        if (lot.details) lot.details = toTitleCaseWords(lot.details);
        if (lot.condition) lot.condition = toTitleCaseWords(lot.condition);
        // Also title-case nested items
        if (Array.isArray(lot.items)) {
          for (const item of lot.items) {
            if (item.title) item.title = toTitleCaseWords(item.title);
            if (item.description) item.description = toTitleCaseWords(item.description);
            if (item.details) item.details = toTitleCaseWords(item.details);
            if (item.condition) item.condition = toTitleCaseWords(item.condition);
          }
        }
      }
    }

    // i18n translations for templates
    const lang: "en" | "fr" | "es" = ((): any => {
      const l = String((reportData as any)?.language || "").toLowerCase();
      return l === "fr" || l === "es" ? l : "en";
    })();
    const translations = {
      en: {
        assetReport: "Asset Report",
        mixed: "Mixed",
        reportSummary: "Report Summary",
        groupingMode: "Grouping Mode",
        totalLots: "Total Lots",
        totalImages: "Total Images",
        summaryOfValue: "Summary of Value Conclusions",
        reportDetails: "Report Details",
        contractNo: "Contract No",
        perItem: "Per Item",
        perPhoto: "Per Photo",
        singleLot: "Bundle",
        lotWord: "Lot",
        lotsWord: "Lots",
        title: "Title",
        serialNoOrLabel: "Serial / Label",
        description: "Description",
        details: "Details",
        estimatedValue: "Est. Value",
        image: "Image",
        client: "Client",
        inspector: "Inspector",
        page: "Page ",
        effectiveDate: "Effective Date",
        appraisalPurpose: "Appraisal Purpose",
        ownerName: "Owner Name",
        appraiser: "Appraiser",
        appraisalCompany: "Appraisal Company",
        industry: "Industry",
        inspectionDate: "Inspection Date",
        tableOfContents: "Table of Contents",
        results: "Results",
        marketOverview: "Market Overview",
        appendix: "Appendix",
        references: "References",
        canada: "Canada",
        northAmerica: "North America",
        dateLabel: "Date",
        transmittalHeading: "Transmittal Letter",
        transmittalReference: "Reference",
        transmittalDear: "Dear",
        transmittalPara1: (client?: string, owner?: string) => `At the request of ${client || 'the Client'}, we have prepared an appraisal of certain assets owned by ${owner || 'the Owner'}, a copy of which is enclosed. This appraisal report is intended for the exclusive use of ${client || 'the Client'} and only for establishing values of the listed assets.`,
        transmittalPara2:
          "The subject assets were appraised under a premise of value appropriate for internal consideration. The cost and market approaches to value have been considered and applied as appropriate for the value conclusions herein.",
        transmittalPara3: (eff?: string, created?: string) =>
          `After thorough analysis of the assets and information made available to us, it is our opinion that as of the Effective Date (${eff || created || ""}), these assets have fair value as shown on the certificate enclosed.`,
        transmittalPara4:
          "If you require any additional information, please feel free to contact us at your convenience.",
        certificateHeading: "Certificate of Appraisal",
        totalAppraisedValueLabel: "Total Appraised Value",
        seeReportDetailsText:
          "See Report Details and item estimates for values.",
        noGroupResults: 'No grouped results. Showing all lots.',
        // Narrative (EN)
        valueBody: (v: string) =>
          `Based upon our analysis and methodology, we estimate the reported assets have a value of ${v}.`,
        noValueBody:
          "Based upon our analysis and methodology, please refer to the detailed sections for value information.",
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
          "The appraiser has the appropriate knowledge and experience to develop credible results for the purpose and use outlined in this report.",
        confidentialityHeading: "Confidentiality",
        confidentialityBody:
          "This report and supporting file documentation are confidential. Distribution to parties other than the client requires prior written consent.",
        experienceHeading: "EXPERIENCE",
        experienceBody1:
          "McDougall Auctioneers Ltd. is one of Western Canada’s leading full-service auction and valuation firms, with over 40 years of experience in marketing, selling, and appraising assets across a diverse range of industries. Headquartered in Saskatchewan and operating throughout Canada and the United States, McDougall Auctioneers has built a reputation for impartial, defensible valuations that meet or exceed industry and regulatory standards.",
        experienceBody2:
          "Our appraisal team combines Certified Personal Property Appraisers, experienced auctioneers, and subject-matter specialists who have inspected and valued tens of thousands of assets annually. We deliver comprehensive appraisals for equipment, vehicles, industrial machinery, agricultural assets, and business inventories, using recognised methodologies such as the Market Approach, Cost Approach, and, where applicable, the Income Approach. All assignments are performed in compliance with the Uniform Standards of Professional Appraisal Practice (USPAP) and relevant Canadian appraisal guidelines.",
        experienceBody3:
          "McDougall’s extensive auction platform provides us with current, real-world market data on comparable sales. This proprietary database allows us to support our valuations with up-to-date evidence of pricing trends, demand fluctuations, and liquidation values. Whether for insurance, financing, litigation, or internal asset management, our appraisals provide accurate, timely, and defensible fair market values.",
        experienceBody4:
          "Our industry experience spans construction, transportation, agriculture, heavy equipment, manufacturing, and retail inventories. We are frequently engaged by banks, insolvency professionals, legal counsel, government agencies, and private owners to appraise assets ranging from single high-value machines to large, multi-site fleets. This depth of experience ensures that every McDougall appraisal assignment is approached with professionalism, objectivity, and an understanding of how market conditions translate into asset value. Clients can rely on McDougall Auctioneers for clear, well-documented reports that withstand scrutiny from lenders, courts, insurers, and auditors alike.",
      },
      fr: {
        assetReport: "Rapport d'actifs",
        mixed: "Mixte",
        reportSummary: "Résumé du rapport",
        groupingMode: "Mode de regroupement",
        totalLots: "Total des lots",
        totalImages: "Nombre d'images",
        summaryOfValue: "Résumé des conclusions de valeur",
        reportDetails: "Détails du rapport",
        contractNo: "Numéro de contrat",
        perItem: "Par article",
        perPhoto: "Par photo",
        singleLot: "Lot unique",
        lotWord: "Lot",
        lotsWord: "Lots",
        title: "Titre",
        serialNoOrLabel: "N° de série / Étiquette",
        description: "Description",
        details: "Détails",
        estimatedValue: "Valeur estimée",
        image: 'Image',
        client: 'Client',
        inspector: 'Inspecteur',
        page: 'Page ',
        effectiveDate: "Date d’effet",
        appraisalPurpose: "Objet de l’évaluation",
        ownerName: 'Nom du propriétaire',
        appraiser: 'Évaluateur',
        appraisalCompany: 'Société d’évaluation',
        industry: 'Secteur',
        inspectionDate: "Date d’inspection",
        tableOfContents: 'Table des matières',
        results: "Résultats",
        marketOverview: "Aperçu du marché",
        appendix: "Annexe",
        references: "Références",
        canada: "Canada",
        northAmerica: "Amérique du Nord",
        dateLabel: "Date",
        transmittalHeading: "Lettre d’envoi",
        transmittalReference: "Référence",
        transmittalDear: "Madame, Monsieur",
        transmittalPara1: (client?: string, owner?: string) => `À la demande de ${client || 'notre client'}, nous avons préparé une évaluation de certains actifs appartenant à ${owner || "l’Entreprise"}, dont copie est jointe. Ce rapport est destiné à l’usage exclusif de ${client || 'notre client'} et uniquement à l’établissement de la valeur des actifs listés.`,
        transmittalPara2:
          "Les actifs ont été évalués selon une hypothèse de valeur appropriée à un usage interne. Les approches par le coût et par le marché ont été considérées et appliquées, le cas échéant, pour les conclusions de valeur présentées.",
        transmittalPara3: (eff?: string, created?: string) =>
          `Après une analyse approfondie des actifs et des informations mises à disposition, nous sommes d’avis qu’à la date d’effet (${eff || created || ""}), ces actifs ont la valeur indiquée sur le certificat ci-joint.`,
        transmittalPara4:
          "Pour toute information complémentaire, n’hésitez pas à nous contacter.",
        certificateHeading: "Certificat d’évaluation",
        totalAppraisedValueLabel: 'Valeur totale estimée',
        seeReportDetailsText: 'Voir Détails du rapport et estimations des éléments pour les valeurs.',
        noGroupResults: 'Aucun résultat groupé. Affichage de tous les lots.',
        // Narrative (FR)
        valueBody: (v: string) => `D’après notre analyse et notre méthodologie, nous estimons que la valeur des actifs évalués est de ${v}.`,
        noValueBody: 'D’après notre analyse et notre méthodologie, veuillez vous référer aux sections détaillées pour les informations de valeur.',
        conditionsHeading: "Conditions de l’évaluation",
        conditionsBody: "La valeur indiquée dans ce rapport d’évaluation est fondée sur le meilleur jugement de l’évaluateur, compte tenu des faits et conditions disponibles à la date de valeur. L’utilisation de ce rapport est limitée à la détermination de la valeur des actifs. Ce rapport doit être utilisé uniquement dans son intégralité.",
        purposeHeading: 'Objet du rapport',
        purposeBody: (client: string) => `L’objet de ce rapport est de fournir une opinion de valeur du sujet à des fins internes et d’aider ${client} et les personnes désignées au sein de son organisation à établir une Valeur de Liquidation Ordonnée (VLO) actuelle à des fins financières. Ce rapport n’est pas destiné à un autre usage. Compte tenu de cet objectif, nous avons valorisé les actifs selon l’hypothèse de VLO.`,
        identHeading: "Identification des actifs évalués",
        identBody: "Comme indiqué dans les sections ci-jointes, les actifs évalués dans le cadre de ce mandat comprennent : équipements de construction et de transport.",
        scopeHeading: "Étendue des travaux",
        scopeIntro: "Processus et méthodologie d’évaluation — l’évaluateur a appliqué les procédures suivantes pour déterminer les conclusions de valeur :",
        scopeBullet1: "Examen et analyse des dossiers d’actifs et autres documents d’information.",
        scopeBullet2: "Inspection et analyse des actifs et des équipements sur le(s) site(s) du client.",
        observationsHeading: 'Observations et commentaires',
        observationsBody: "Les données disponibles et les comparables de marché utilisés dataient jusqu’à 120 jours. Un poids accru a été accordé aux comparables régionaux récents lorsque disponibles.",
        intendedHeading: 'Utilisateurs visés',
        intendedBody: "Cette évaluation ne doit pas être reproduite ni utilisée à d’autres fins que celles indiquées et est destinée à l’usage interne du client.",
        valueTermHeading: 'Terminologie de la valeur',
        valueOLVHeading: 'Valeur de Liquidation Ordonnée (VLO)',
        valueOLVBody: (ccy: string) => `Montant estimé, exprimé en espèces en ${ccy}, qui pourrait généralement être obtenu lors d’une vente de liquidation, le vendeur étant contraint de vendre selon le principe « tel quel, là où il se trouve », à une date précise et sur une période d’environ 120 jours.`,
        valueOLVScenarioBody: "Aux fins de cette évaluation, nous avons considéré un scénario de vente privée, correctement annoncée et gérée de manière professionnelle, sur une période de 120 jours, pendant l’exploitation normale ou la cessation des activités, l’acheteur étant responsable du démontage et de l’enlèvement à ses risques et frais.",
        definitionsHeading: 'Définitions et obsolescence',
        physicalDetHeading: 'Détérioration physique',
        physicalDetBody: "Forme de dépréciation où la perte de valeur ou d’utilité d’un bien est due à l’usure, la détérioration, l’exposition aux éléments, les contraintes physiques, et facteurs similaires.",
        functionalObsHeading: 'Obsolescence fonctionnelle',
        functionalObsBody: "Forme de dépréciation causée par les inefficacités ou insuffisances intrinsèques de l’actif par rapport à un remplacement plus efficace ou moins coûteux issu d’une technologie plus récente.",
        economicObsHeading: 'Obsolescence économique',
        economicObsBody: "Forme de dépréciation ou perte de valeur due à des facteurs externes tels que l’économie du secteur, la disponibilité du financement, la réglementation, l’augmentation des coûts d’intrants sans hausse compensatoire des prix, la baisse de la demande, la concurrence accrue, l’inflation ou des taux d’intérêt élevés.",
        depreciationHeading: 'Dépréciation',
        depreciationBody: "Perte réelle de valeur ou d’utilité d’un bien, toutes causes confondues, incluant la détérioration physique, l’obsolescence fonctionnelle et l’obsolescence économique.",
        limitingHeading: 'Conditions limitatives et hypothèses critiques',
        assetCondHeading: 'État des actifs',
        assetCondBody: "Certaines informations ont été fournies à l’évaluateur concernant des réparations, moteurs, trains de roulement et améliorations. Elles ont été prises en compte lors de l’évaluation et de la comparaison avec les comparables de marché. Certains actifs peuvent bénéficier de garanties prolongées.",
        titleAssetsHeading: 'Titre de propriété des actifs',
        titleAssetsBody: "Aucune vérification n’a été effectuée et aucune responsabilité n’est assumée pour les questions juridiques, y compris le titre ou les charges. Le titre est présumé valable et cessible sauf indication contraire.",
        responsibleOwnHeading: 'Propriété responsable',
        responsibleOwnBody: "On suppose que les actifs sont sous une propriété responsable et une gestion compétente.",
        statedPurposeHeading: 'Objet déclaré',
        statedPurposeBody: "Cette évaluation et ce rapport ont été réalisés uniquement pour l’objet déclaré et ne peuvent être utilisés à d’autres fins.",
        valuationDateHeading: 'Date de valeur',
        valuationDateBody: (dateStr: string, ccy: string) => `La date de valeur est ${dateStr || 'la date d’effet'} ; les valeurs sont exprimées en ${ccy} à cette date.`,
        inspectionHeading: 'Inspection',
        inspectionBody: (monthStr?: string) => `Les actifs ont été inspectés ${monthStr ? `en ${monthStr}` : 'tel que noté dans le rapport'}. Lorsque la date d’inspection diffère de la date de valeur, aucun changement matériel n’est présumé sauf indication contraire.`,
        hazardousHeading: 'Substances dangereuses',
        hazardousBody: "Aucune provision n’a été faite pour d’éventuels problèmes environnementaux. L’estimation suppose la conformité aux réglementations applicables et l’absence de matières dangereuses, sauf indication contraire.",
        changeMarketHeading: 'Changements des conditions du marché',
        changeMarketBody: "Nous ne sommes pas responsables des changements de conditions de marché après la date de valeur et n’avons aucune obligation de réviser le rapport pour des événements ultérieurs.",
        unexpectedHeading: 'Conditions imprévues',
        unexpectedBody: "On suppose qu’il n’existe pas de conditions cachées ou non apparentes susceptibles d’affecter la valeur. Aucune responsabilité n’est assumée pour de telles conditions.",
        companySubjectHeading: 'Entreprise et description des actifs',
        companyDiscussionHeading: 'Présentation de l’entreprise',
        companyDiscussionBody: (client: string) => `${client} exploite plusieurs divisions et emplacements. Le mandat porte sur les divisions pertinentes liées aux actifs objet de l’évaluation.`,
        subjectAssetsHeading: 'Présentation des actifs',
        subjectAssetsBody: "Les principaux actifs comprennent des équipements de construction et de transport. Dans l’ensemble, ils ont été jugés en bon à excellent état, sous réserve des hypothèses et conditions limitatives.",
        approachesHeading: 'Approches de valeur',
        costApproachHeading: 'Approche par le coût',
        costApproachBody: "Procédures par lesquelles l’évaluateur détermine une indication de valeur en estimant le coût actuel de reproduction ou de remplacement des actifs, en déduisant toutes les dépréciations, y compris la détérioration physique, l’obsolescence fonctionnelle et l’obsolescence économique.",
        marketApproachHeading: 'Approche par comparaison (marché)',
        marketApproachBody: "Procédures par lesquelles l’évaluateur détermine une indication de valeur en comparant les actifs évalués à des actifs similaires récemment vendus et en effectuant les ajustements appropriés.",
        incomeApproachHeading: 'Approche par capitalisation du revenu',
        incomeApproachBody: "Procédures par lesquelles l’évaluateur détermine une indication de valeur pour des actifs générateurs de revenus en convertissant les avantages anticipés en valeur via la capitalisation ou l’actualisation des flux de trésorerie.",
        alternateUseHeading: 'Usage alternatif et marché approprié',
        alternateUseBody: "Nous avons pris en compte le marché approprié et le niveau d’échange, la disponibilité de données fiables, les conditions du marché à la date de valeur, et une période de commercialisation cohérente avec l’usage visé.",
        reconciliationHeading: 'Rapprochement des approches de valeur',
        reconciliationBody: "Les approches du coût et du marché ont été utilisées et rapprochées. L’approche par le revenu a été prise en considération mais non appliquée pour les raisons exposées dans ce rapport.",
        hbuHeading: 'Usage optimal',
        hbuBody: "Nous avons considéré l’usage optimal des assets, y compris ce qui est légalement permis, physiquement possible, financièrement réalisable et maximisant la valeur.",
        valProcessHeading: 'Processus et méthodologie d’évaluation',
        dataCollectionHeading: 'Collecte des données',
        dataCollectionBody: (monthStr?: string) => `Des visites de site ont été effectuées ${monthStr ? `en ${monthStr}` : 'au besoin'}. Les échanges avec le personnel du client ont éclairé notre compréhension des opérations et des politiques d’entretien.`,
        valuationProcessHeading2: 'Processus de valorisation',
        valuationProcessBody: "Nous avons considéré les approches par le revenu, par comparaison et par le coût et retenu les méthodes appropriées selon les types d’actifs et les données disponibles.",
        researchMethodHeading: 'Méthodologie de recherche',
        researchMethodBody: "La recherche a inclus des résultats d’enchères et de concessionnaires, des données d’OEM, des places de marché d’équipements d’occasion et les conditions de marché/géographiques actuelles pour des assets similaires.",
        codeEthicsHeading: "Code d’éthique",
        competencyHeading: 'Compétence',
        competencyBody: "L’évaluateur possède les connaissances et l’expérience appropriées pour produire des résultats crédibles pour l’usage décrit dans ce rapport.",
        confidentialityHeading: 'Confidentialité',
        confidentialityBody: "Ce rapport et la documentation de travail sont confidentiels. Toute diffusion à des tiers nécessite un consentement écrit préalable.",
        experienceHeading: 'EXPÉRIENCE',
        experienceBody1: "McDougall Auctioneers Ltd. est l’une des principales sociétés de vente aux enchères et d’évaluation à service complet de l’Ouest canadien, avec plus de 40 ans d’expérience dans la commercialisation, la vente et l’évaluation d’actifs dans divers secteurs. Basée en Saskatchewan et opérant au Canada et aux États-Unis, McDougall s’est forgé une réputation d’évaluations impartiales et défendables, conformes aux normes de l’industrie et réglementaires.",
        experienceBody2: "Notre équipe regroupe des évaluateurs certifiés, des commissaires-priseurs expérimentés et des spécialistes sectoriels ayant inspecté et évalué des dizaines de milliers d’actifs chaque année. Nous réalisons des évaluations complètes d’équipements, de véhicules, de machines industrielles, d’actifs agricoles et d’inventaires, utilisant des méthodologies reconnues telles que l’approche par le marché, par le coût et, le cas échéant, par le revenu. Toutes les missions sont conformes au USPAP et aux lignes directrices canadiennes pertinentes.",
        experienceBody3: "La vaste plateforme d’enchères de McDougall nous fournit des données de marché actuelles et réelles sur les ventes comparables. Cette base de données propriétaire étaye nos évaluations avec des éléments probants à jour sur les tendances de prix, la demande et les valeurs de liquidation. Pour l’assurance, le financement, les litiges ou la gestion interne, nos évaluations offrent des valeurs justes, précises et défendables.",
        experienceBody4: "Notre expérience couvre la construction, le transport, l’agriculture, les équipements lourds, la fabrication et les inventaires de détail. Nous sommes régulièrement mandatés par des banques, professionnels de l’insolvabilité, avocats, organismes publics et propriétaires privés. Cette profondeur d’expérience garantit des évaluations professionnelles et objectives, et des rapports clairs et documentés acceptés par prêteurs, tribunaux, assureurs et auditeurs.",
      },
      es: {
        assetReport: 'Informe de activos',
        mixed: 'Mixto',
        reportSummary: 'Resumen del informe',
        groupingMode: 'Modo de agrupación',
        totalLots: 'Total de lotes',
        totalImages: 'Total de imágenes',
        summaryOfValue: 'Resumen de conclusiones de valor',
        reportDetails: 'Detalles del informe',
        contractNo: 'Número de contrato',
        perItem: 'Por artículo',
        perPhoto: 'Por foto',
        singleLot: 'Lote único',
        lotWord: 'Lote',
        lotsWord: 'Lotes',
        title: 'Título',
        serialNoOrLabel: 'Serie / Etiqueta',
        description: 'Descripción',
        details: 'Detalles',
        estimatedValue: 'Valor est.',
        image: 'Imagen',
        client: 'Cliente',
        inspector: 'Inspector',
        page: 'Página ',
        effectiveDate: 'Fecha de vigencia',
        appraisalPurpose: 'Propósito de la tasación',
        ownerName: 'Nombre del propietario',
        appraiser: 'Tasador',
        appraisalCompany: 'Empresa de tasación',
        industry: 'Industria',
        inspectionDate: 'Fecha de inspección',
        tableOfContents: 'Tabla de contenido',
        results: 'Resultados',
        marketOverview: 'Panorama del mercado',
        appendix: 'Apéndice',
        references: 'Referencias',
        canada: 'Canadá',
        northAmerica: 'Norteamérica',
        dateLabel: 'Fecha',
        transmittalHeading: 'Carta de presentación',
        transmittalReference: 'Referencia',
        transmittalDear: 'Estimado/a',
        transmittalPara1: (client?: string, owner?: string) => `A solicitud de ${client || 'el Cliente'}, hemos preparado una tasación de ciertos activos propiedad de ${owner || 'el Propietario'}, cuya copia se adjunta. Este informe es para uso exclusivo de ${client || 'el Cliente'} y solo para establecer el valor de los activos listados.`,
        transmittalPara2: 'Los activos fueron tasados bajo un supuesto de valor apropiado para uso interno. Se han considerado y aplicado las aproximaciones de costo y de mercado según corresponda para las conclusiones de valor aquí presentadas.',
        transmittalPara3: (eff?: string, created?: string) => `Tras un análisis exhaustivo de los activos y la información disponible, a nuestro juicio a la Fecha de Vigencia (${eff || created || ''}), estos activos tienen el valor indicado en el certificado adjunto.`,
        transmittalPara4: 'Si necesita información adicional, no dude en contactarnos.',
        certificateHeading: 'Certificado de tasación',
        totalAppraisedValueLabel: 'Valor total tasado',
        seeReportDetailsText: 'Vea Detalles del informe y estimaciones de los ítems para los valores.',
        noGroupResults: 'No hay resultados agrupados. Mostrando todos los lotes.',
        // Narrative (ES)
        valueBody: (v: string) => `Según nuestro análisis y metodología, estimamos que el valor de los activos reportados es de ${v}.`,
        noValueBody: 'Según nuestro análisis y metodología, consulte las secciones detalladas para la información de valor.',
        conditionsHeading: 'Condiciones de la tasación',
        conditionsBody: 'El valor indicado en este informe se basa en el mejor juicio del tasador, considerando los hechos y condiciones disponibles a la fecha de valoración. El uso de este informe se limita a determinar el valor de los activos. Debe utilizarse únicamente en su totalidad.',
        purposeHeading: 'Propósito de este informe',
        purposeBody: (client: string) => `El propósito de este informe es proporcionar una opinión de valor del sujeto para consideración interna y ayudar a ${client} y al personal designado dentro de su organización a establecer un Valor de Liquidación Ordenada (VLO) actual para fines financieros. No está destinado para ningún otro propósito. En función de ello, hemos valorado los activos bajo el supuesto de VLO.`,
        identHeading: 'Identificación de los activos tasados',
        identBody: 'Como se expone en las secciones adjuntas, los activos tasados en este encargo incluyen: equipos de construcción y transporte.',
        scopeHeading: 'Alcance del trabajo',
        scopeIntro: 'Proceso y metodología de valoración: el tasador empleó los siguientes procedimientos para determinar las conclusiones de valor:',
        scopeBullet1: 'Revisión y análisis de registros de activos y otros materiales informativos.',
        scopeBullet2: 'Inspección y análisis de los activos y equipos en las ubicaciones del cliente.',
        observationsHeading: 'Observaciones y comentarios',
        observationsBody: 'Los datos disponibles y los comparables de mercado utilizados tenían hasta 120 días. Se dio mayor peso a comparables recientes específicos de la región cuando estuvieron disponibles.',
        intendedHeading: 'Usuarios previstos',
        intendedBody: 'Esta tasación no debe reproducirse ni utilizarse para fines distintos a los aquí establecidos y es para uso interno del cliente.',
        valueTermHeading: 'Terminología del valor',
        valueOLVHeading: 'Valor de Liquidación Ordenada (VLO)',
        valueOLVBody: (ccy: string) => `El monto estimado, expresado en efectivo en ${ccy}, que típicamente podría realizarse en una venta de liquidación, con el vendedor obligado a vender en condición “tal como está, donde está”, en una fecha específica y durante un periodo de 120 días.`,
        valueOLVScenarioBody: 'Para esta tasación, consideramos un escenario de venta privada correctamente anunciada y profesionalmente gestionada, durante 120 días, en operación normal o en proceso de cierre, con el comprador responsable del desmontaje y retiro bajo su propio riesgo y costo.',
        definitionsHeading: 'Definiciones y obsolescencia',
        physicalDetHeading: 'Deterioro físico',
        physicalDetBody: 'Forma de depreciación en la que la pérdida de valor o utilidad se debe al desgaste, deterioro, exposición a elementos, tensiones físicas y factores similares.',
        functionalObsHeading: 'Obsolescencia funcional',
        functionalObsBody: 'Forma de depreciación en la que la pérdida de valor o utilidad es causada por ineficiencias o insuficiencias propias del activo frente a un reemplazo más eficiente o económico que ofrece la tecnología más reciente.',
        economicObsHeading: 'Obsolescencia económica',
        economicObsBody: 'Forma de depreciación o pérdida de valor causada por factores externos como la economía del sector, la disponibilidad de financiamiento, la legislación, el aumento de costos sin incrementos de precio compensatorios, la baja demanda, la mayor competencia, la inflación o tasas de interés altas.',
        depreciationHeading: 'Depreciación',
        depreciationBody: 'Pérdida real de valor o de utilidad de un bien por todas las causas, incluyendo deterioro físico, obsolescencia funcional y obsolescencia económica.',
        limitingHeading: 'Condiciones limitantes y supuestos críticos',
        assetCondHeading: 'Condición de los activos',
        assetCondBody: 'Se proporcionó cierta información al tasador sobre reparaciones, motores, trenes de rodaje y mejoras. Se consideró al tasar y comparar los activos con comparables de mercado. Algunos activos pueden tener garantías extendidas.',
        titleAssetsHeading: 'Título de los activos',
        titleAssetsBody: 'No se ha investigado ni se asume responsabilidad por asuntos legales, incluidos título o gravámenes. Se presume que el título es válido y negociable salvo indicación en contrario.',
        responsibleOwnHeading: 'Propiedad responsable',
        responsibleOwnBody: 'Se asume que los activos están bajo propiedad responsable y gestión competente.',
        statedPurposeHeading: 'Propósito declarado',
        statedPurposeBody: 'Esta tasación y el informe se han realizado únicamente para el propósito declarado y no pueden usarse para otro fin.',
        valuationDateHeading: 'Fecha de valoración',
        valuationDateBody: (dateStr: string, ccy: string) => `La fecha de valoración es ${dateStr || 'la fecha de vigencia'}; los valores están en ${ccy} a esa fecha.`,
        inspectionHeading: 'Inspección',
        inspectionBody: (monthStr?: string) => `Los activos fueron inspeccionados ${monthStr ? `en ${monthStr}` : 'según se indica en el informe'}. Cuando la fecha de inspección difiera de la fecha de valoración, se asume que no hubo cambios materiales salvo que se indique lo contrario.`,
        hazardousHeading: 'Sustancias peligrosas',
        hazardousBody: 'No se ha hecho ninguna provisión por posibles problemas ambientales. La estimación de valor supone cumplimiento pleno con la normativa y ausencia de materiales peligrosos salvo que se indique.',
        changeMarketHeading: 'Cambios en las condiciones del mercado',
        changeMarketBody: 'No somos responsables de cambios en las condiciones del mercado posteriores a la fecha de valoración ni estamos obligados a revisar el informe por eventos subsecuentes.',
        unexpectedHeading: 'Condiciones imprevistas',
        unexpectedBody: 'Se asume que no existen condiciones ocultas o no evidentes que afecten el valor. No se asume responsabilidad por tales condiciones.',
        companySubjectHeading: 'Empresa y descripción de los activos',
        companyDiscussionHeading: 'Descripción de la empresa',
        companyDiscussionBody: (client: string) => `${client} opera en múltiples divisiones y ubicaciones. El encargo se centra en las divisiones relacionadas con los activos objeto de esta tasación.`,
        subjectAssetsHeading: 'Descripción de los activos',
        subjectAssetsBody: 'Los principales activos incluyen equipos de construcción y transporte. En general, se encontraron en buen a excelente estado, sujeto a las condiciones y supuestos limitantes.',
        approachesHeading: 'Enfoques de valoración',
        costApproachHeading: 'Enfoque del costo',
        costApproachBody: 'Procedimientos mediante los cuales el tasador determina una indicación de valor estimando el costo actual de reproducir o reemplazar los activos, deduciendo toda depreciación, incluyendo deterioro físico, obsolescencia funcional y obsolescencia económica.',
        marketApproachHeading: 'Enfoque de comparación de ventas (mercado)',
        marketApproachBody: 'Procedimientos mediante los cuales el tasador determina una indicación de valor comparando los activos con otros similares vendidos recientemente y realizando los ajustes necesarios.',
        incomeApproachHeading: 'Enfoque de capitalización de ingresos',
        incomeApproachBody: 'Procedimientos mediante los cuales el tasador determina una indicación de valor para activos generadores de ingresos convirtiendo los beneficios anticipados en valor mediante capitalización o descuento de flujos.',
        alternateUseHeading: 'Uso alternativo y mercado apropiado',
        alternateUseBody: 'Se consideró el mercado adecuado y el nivel de intercambio, la disponibilidad de datos confiables, las condiciones del mercado a la fecha de valoración y un periodo de comercialización acorde con el uso previsto.',
        reconciliationHeading: 'Conciliación de enfoques de valoración',
        reconciliationBody: 'Se utilizaron y conciliaron los enfoques de Costo y de Mercado. El enfoque de Ingresos fue considerado pero no aplicado por las razones expuestas en este informe.',
        hbuHeading: 'Máximo y mejor uso',
        hbuBody: 'Se consideró el máximo y mejor uso de los activos, incluyendo lo legalmente permitido, físicamente posible, financieramente factible y que maximiza la productividad.',
        valProcessHeading: 'Proceso y metodología de valoración',
        dataCollectionHeading: 'Recopilación de datos',
        dataCollectionBody: (monthStr?: string) => `Se realizaron visitas a sitio ${monthStr ? `en ${monthStr}` : 'según fue necesario'}. Las conversaciones con el personal del cliente ayudaron a comprender operaciones y políticas de mantenimiento.`,
        valuationProcessHeading2: 'Proceso de valoración',
        valuationProcessBody: 'Se consideraron los enfoques de ingresos, comparación de ventas y costo, concluyendo los métodos apropiados según los tipos de activos y los datos disponibles.',
        researchMethodHeading: 'Metodología de investigación',
        researchMethodBody: 'La investigación incluyó resultados de subastas y concesionarios, datos de OEM, mercados de equipos usados y condiciones de mercado/geográficas actuales para activos similares.',
        codeEthicsHeading: 'Código de ética',
        competencyHeading: 'Competencia',
        competencyBody: 'El tasador posee el conocimiento y la experiencia adecuados para desarrollar resultados confiables para el propósito y uso descritos en este informe.',
        confidentialityHeading: 'Confidencialidad',
        confidentialityBody: 'Este informe y la documentación de respaldo son confidenciales. La distribución a terceros requiere consentimiento previo por escrito.',
        experienceHeading: 'EXPERIENCIA',
        experienceBody1: 'McDougall Auctioneers Ltd. es una de las principales firmas de subastas y valoración de servicio completo en el oeste de Canadá, con más de 40 años de experiencia en comercialización, venta y tasación de activos en diversos sectores. Con sede en Saskatchewan y operaciones en Canadá y Estados Unidos, McDougall se ha ganado una reputación por valoraciones imparciales y defendibles que cumplen o superan las normas de la industria y regulatorias.',
        experienceBody2: 'Nuestro equipo combina tasadores certificados de bienes muebles, subastadores experimentados y especialistas en la materia que inspeccionan y valoran decenas de miles de activos al año. Realizamos tasaciones integrales de equipos, vehículos, maquinaria industrial, activos agrícolas e inventarios, utilizando metodologías reconocidas como los enfoques de Mercado, Costo y, cuando corresponde, Ingresos. Todas las asignaciones se realizan conforme al USPAP y a las directrices canadienses pertinentes.',
        experienceBody3: 'La amplia plataforma de subastas de McDougall nos proporciona datos de mercado actuales y reales sobre ventas comparables. Esta base de datos propietaria respalda nuestras valoraciones con evidencia actualizada de tendencias de precios, fluctuaciones de demanda y valores de liquidación. Ya sea para seguros, financiamiento, litigios o gestión interna, nuestras tasaciones proporcionan valores justos, oportunos y defendibles.',
        experienceBody4: 'Nuestra experiencia cubre construcción, transporte, agricultura, equipo pesado, manufactura e inventarios minoristas. Con frecuencia trabajamos para bancos, profesionales de insolvencia, abogados, organismos gubernamentales y propietarios privados. Esta profundidad de experiencia garantiza profesionalismo y objetividad en cada tasación, con informes claros y bien documentados aceptados por prestamistas, tribunales, aseguradoras y auditores.',
      },
    } as const;
    const t = (translations as any)[lang] as typeof translations.en;

    // Group lots by mixed_group_index (for mixed mode rendering)
    let groups: Array<{
      id: number;
      sub_mode: string;
      label: string;
      items: any[];
    }> = [];
    try {
      const lots: any[] = Array.isArray(sanitizedData?.lots)
        ? sanitizedData.lots
        : [];
      const map = new Map<number, any[]>();
      for (const lot of lots) {
        const gid = Number(lot?.mixed_group_index) || 0;
        if (!map.has(gid)) map.set(gid, []);
        map.get(gid)!.push(lot);
      }
      const ids = Array.from(map.keys())
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      const useIds = ids.length ? ids : [0];
      groups = useIds.map((gid, idx) => {
        const items = map.get(gid) || lots;
        const subMode: string = String(
          items[0]?.sub_mode ||
            (items[0]?.tags || [])
              .find?.(
                (x: string) => typeof x === "string" && x.startsWith("mode:")
              )
              ?.split?.(":")?.[1] ||
            "single_lot"
        );
        const label = `${t.lotWord} ${gid || idx + 1} — ${subMode === "per_item" ? t.perItem : subMode === "per_photo" ? t.perPhoto : t.singleLot}`;
        return { id: gid || idx + 1, sub_mode: subMode, label, items };
      });
    } catch {
      groups = [];
    }

    // Dynamic narrative strings (using language-aware templates)
    const clientName: string = String(
      (sanitizedData as any)?.client_name || ""
    );
    const currency: string = String((sanitizedData as any)?.currency || "CAD");
    const effDate = (sanitizedData as any)?.effective_date
      ? new Date((sanitizedData as any).effective_date)
      : undefined;
    const effDateStr =
      effDate && !isNaN(effDate.getTime())
        ? effDate.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "";
    const inspDate = (sanitizedData as any)?.inspection_date
      ? new Date((sanitizedData as any).inspection_date)
      : undefined;
    const inspMonthStr =
      inspDate && !isNaN(inspDate.getTime())
        ? inspDate.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
          })
        : undefined;
    const narr = {
      purposeBody: t.purposeBody(clientName || "Client"),
      valuationDateBody: t.valuationDateBody(effDateStr, currency),
      inspectionBody: t.inspectionBody(inspMonthStr),
      dataCollectionBody: t.dataCollectionBody(inspMonthStr),
      valueOLVBody: t.valueOLVBody(currency),
      summaryValueBody:
        (sanitizedData as any)?.total_appraised_value ||
        (sanitizedData as any)?.total_value ||
        (sanitizedData as any)?.analysis?.total_value
          ? t.valueBody(
              String(
                (sanitizedData as any)?.total_appraised_value ||
                  (sanitizedData as any)?.total_value ||
                  (sanitizedData as any)?.analysis?.total_value
              )
            )
          : t.noValueBody,
    };

    // Prepare Market Overview data (bullets, sources, and chart images)
    let market: any = null;
    try {
      const { industry, primaryRegionIndicators, northAmerica } =
        await fetchCanadaAndNorthAmericaIndicators(reportData);

      const caChart = await generateTrendChartImage(
        primaryRegionIndicators.series.years,
        primaryRegionIndicators.series.values,
        `${industry} – Canada (5-Year Trend)`,
        1000,
        600
      );
      const naChart = await generateBarChartImage(
        northAmerica.series.years,
        northAmerica.series.values,
        `${industry} – North America (5-Year Trend)`,
        1000,
        600
      );

      const caChartUrl = `data:image/png;base64,${Buffer.from(caChart).toString(
        "base64"
      )}`;
      const naChartUrl = `data:image/png;base64,${Buffer.from(naChart).toString(
        "base64"
      )}`;

      // Unique sources by URL
      const combined = [
        ...(Array.isArray(primaryRegionIndicators?.sources) ? primaryRegionIndicators.sources : []),
        ...(Array.isArray(northAmerica?.sources) ? northAmerica.sources : []),
      ];
      const seen = new Set<string>();
      const uniqueRefs = combined.filter((s: any) => {
        const key = (s?.url || "").trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      market = {
        canada: { bullets: primaryRegionIndicators?.bullets || [], chart: caChartUrl },
        northAmerica: {
          bullets: northAmerica?.bullets || [],
          chart: naChartUrl,
        },
        sources: uniqueRefs,
      };
    } catch {
      market = null; // non-fatal
    }

    // Normalize detail fields for template compatibility
    const normalizedDetails = {
      owner_name:
        (sanitizedData as any)?.owner_name ||
        (sanitizedData as any)?.owner ||
        (sanitizedData as any)?.company_name,
      appraisal_purpose:
        (sanitizedData as any)?.appraisal_purpose ||
        (sanitizedData as any)?.purpose,
      appraiser:
        (sanitizedData as any)?.appraiser ||
        (sanitizedData as any)?.inspector_name,
      appraisal_company:
        (sanitizedData as any)?.appraisal_company ||
        (sanitizedData as any)?.company ||
        (sanitizedData as any)?.organisation,
      industry:
        (sanitizedData as any)?.industry ||
        (reportData as any)?.industry,
      inspection_date:
        (sanitizedData as any)?.inspection_date ||
        (sanitizedData as any)?.inspected_at,
      inspector_name:
        (sanitizedData as any)?.inspector_name ||
        (sanitizedData as any)?.inspector ||
        (reportData as any)?.user_name,
      createdAt:
        (sanitizedData as any)?.createdAt ||
        (sanitizedData as any)?.created_at ||
        (reportData as any)?.createdAt ||
        (reportData as any)?.created_at ||
        new Date().toISOString(),
    };

    const dataForPdf = {
      logo_url: logoUrl,
      market,
      t,
      groups,
      narr,
      ...normalizedDetails,
      ...sanitizedData,
    };

    const finalHtml = template(dataForPdf);

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 120000,
    });
    const page = await browser.newPage();
    configurePuppeteerPageTimeouts(page);
    await page.setContent(finalHtml, {
      waitUntil: "networkidle0",
      timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
    });

    // Header/Footer templates for consistent branding and page numbers
    const headerTemplate = `
      <style>
        .pdf-header { font-size:8px; color:#6B7280; width:100%; padding: 4px 20px; }
        .pdf-header .right { float:right; }
        .pdf-header img { vertical-align:middle; height:16px; margin-right:8px; }
      </style>
      <div class="pdf-header">
        <span><img src="${logoUrl}" /> P.O. Box 3081 Regina, SK S4P 3G7 · www.McDougallBay.com · (306)757-1747${
          reportData?.user_email ? ` · ${reportData.user_email}` : ""
        }</span>
      </div>`;

    const footerTemplate = `
      <style>
        .pdf-footer { font-size:8px; color:#6B7280; width:100%; padding: 4px 20px; }
        .pdf-footer .page { float:right; }
      </style>
      <div class="pdf-footer">
        <span class="page"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`;

    const pdfBuffer = await page.pdf({
      timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: "60px", right: "20px", bottom: "60px", left: "20px" },
    });

    await browser.close();

    return Buffer.from(pdfBuffer);
  } catch (error) {
    console.error("Error generating Asset PDF:", error);
    throw new Error("Failed to generate Asset PDF report.");
  }
}
