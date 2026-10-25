import { isSalvageAssessmentV2, safeSalvageSourceUrl } from "./salvageAssessment.js";
import { salvageSystemText } from "./salvagePresentation.js";
import { localizedSalvageMethod, localizedSalvageSystemMessage } from "./salvageReportLanguage.js";

export const SALVAGE_REPORT_CONTEXT_FIELDS = [
  "intended_use", "scope_of_work", "valuation_premise", "pre_loss_condition", "inspection_basis",
  "repair_estimate_status", "repair_estimate_date", "lead_time_notes", "market_context",
  "reconciliation_notes", "appraiser_conclusion", "client_comments",
] as const;
export type SalvageReportContext = Partial<Record<typeof SALVAGE_REPORT_CONTEXT_FIELDS[number], string | null>>;
export interface SalvageEnrichmentTable { headers: string[]; rows: string[][] }
export interface SalvageEnrichmentSection { id: string; title: string; paragraphs: string[]; tables: SalvageEnrichmentTable[] }
export interface SalvageReportEnrichment { schemaVersion: 1; sections: SalvageEnrichmentSection[] }
type Data = Record<string, any>;
const record = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown): string => typeof value === "string" ? value.replace(/\u0000/g, "").trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];

/** Explicit appraiser narrative; never a source of calculated or observed facts. */
export function normalizeSalvageReportContext(value: unknown): SalvageReportContext {
  const input = record(value);
  return Object.fromEntries(SALVAGE_REPORT_CONTEXT_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(input, key))
    .map(key => [key, text(input[key]).slice(0, 6000) || null]));
}
export function validateSalvageReportContext(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Report context must be an object.";
  for (const [key, item] of Object.entries(value)) {
    if (!(SALVAGE_REPORT_CONTEXT_FIELDS as readonly string[]).includes(key)) return `Unknown report context field: ${key}.`;
    if (item !== null && typeof item !== "string") return `Invalid report context ${key}.`;
    if (typeof item === "string" && item.length > 6000) return `Report context ${key} is too long.`;
    if (key === "repair_estimate_date" && item) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item) || !Number.isFinite(Date.parse(item)) || new Date(item).toISOString().slice(0, 10) !== item) return "Repair estimate date must be a valid YYYY-MM-DD date.";
    }
  }
  return null;
}

/** Pure display projection shared by preview, PDF, Word and Excel. No research or new valuations. */
export function buildSalvageReportEnrichment(data: Data): SalvageReportEnrichment {
  const lang = data.language === "fr" ? 1 : data.language === "es" ? 2 : 0;
  const l = (en: string, fr: string, es: string) => [en, fr, es][lang];
  const systemMessage = (message: string) => localizedSalvageSystemMessage(message, data.language);
  const quoteRows = (input: Record<string, { referenceId: string; quote: string }>): string[][] => {
    // A single excerpt may support several fields. Keep every field-to-source link
    // without printing the same passage once for every vehicle specification.
    const grouped = new Map<string, { fields: string[]; referenceId: string; quote: string }>();
    for (const [key, item] of Object.entries(input)) {
      const identity = JSON.stringify([item.referenceId, item.quote]);
      const previous = grouped.get(identity);
      if (previous) previous.fields.push(key);
      else grouped.set(identity, { fields: [key], referenceId: item.referenceId, quote: item.quote });
    }
    return [...grouped.values()].map(item => [`${l("Source excerpt", "Extrait de la source", "Extracto de fuente")} (${item.fields.join(", ")})`, `[${item.referenceId}] ${item.quote}`]);
  };
  const unknown = l("Not reported", "Non indiqué", "No informado");
  const unavailable = l("Unavailable", "Indisponible", "No disponible");
  const shown = (value: unknown) => text(value) || unknown;
  const amount = (value: unknown, currency = "CAD") => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? new Intl.NumberFormat(["en-CA", "fr-CA", "es-ES"][lang], { style: "currency", currency: /^[A-Z]{3}$/.test(currency) ? currency : "CAD" }).format(Number(value)) : unavailable;
  const status = (value: unknown) => ({
    supported: l("Supported", "Étayé", "Sustentado"), provisional: l("Provisional asking-market indication", "Indication provisoire du marché demandé", "Indicación provisional del mercado de oferta"),
    insufficient_evidence: l("Insufficient evidence", "Preuves insuffisantes", "Evidencia insuficiente"), appraiser_override: l("Appraiser override", "Valeur de l’évaluateur", "Valor del tasador"),
    complete: l("Complete", "Complet", "Completo"), incomplete: l("Incomplete", "Incomplet", "Incompleto"),
    verified: l("Source content checked", "Contenu de la source vérifié", "Contenido de la fuente comprobado"),
    unverified: l("Unverified", "Non vérifié", "Sin verificar"), appraiser_supplied: l("Appraiser supplied", "Fourni par l’évaluateur", "Aportado por el tasador"),
    sold: l("Sold price", "Prix de vente", "Precio de venta"), asking: l("Asking price", "Prix demandé", "Precio solicitado"),
    reserve: l("Reserve", "Réserve", "Reserva"), current_bid: l("Current bid", "Enchère actuelle", "Puja actual"),
    pre_loss: l("Pre-loss", "Avant sinistre", "Antes del siniestro"), as_is: l("As-is salvage", "Récupération en l’état", "Salvamento en su estado"),
    unknown,
  } as Record<string, string>)[text(value)] || shown(value);
  const sections: SalvageEnrichmentSection[] = [];
  const section = (id: string, title: string, paragraphs: string[] = [], tables: SalvageEnrichmentTable[] = []) => {
    sections.push({ id, title, paragraphs: paragraphs.filter(Boolean), tables: tables.filter(t => t.rows.length) });
  };
  const field = l("Field", "Champ", "Campo"), detail = l("Detail", "Détail", "Detalle"), value = l("Value", "Valeur", "Valor"), evidence = l("Evidence and rationale", "Preuves et justification", "Evidencia y justificación");
  const pairs = (rows: string[][]): SalvageEnrichmentTable => ({ headers: [field, detail], rows });
  const context = normalizeSalvageReportContext(data.report_context);
  const a = isSalvageAssessmentV2(data.assessment) ? data.assessment : null;
  const inputs = a?.inputs;
  const photos = array(data.imageUrls);
  const preLoss = l("Pre-loss market value", "Valeur marchande avant sinistre", "Valor de mercado anterior al siniestro");
  const asIs = l("As-is salvage value", "Valeur de récupération en l’état", "Valor de salvamento en su estado");
  const repair = l("Repair estimate", "Estimation des réparations", "Estimación de reparación");
  const net = l("Net auction recovery", "Produit net des enchères", "Recuperación neta de subasta");
  if (a) section("executive-summary", l("Executive Assessment Summary", "Sommaire de l’évaluation", "Resumen ejecutivo de la valoración"), [
    l("Market values, repair costs and net recovery are separate conclusions. Unknown costs remain unavailable. Repair costs are not automatically subtracted from the as-is value.", "Les valeurs marchandes, les coûts de réparation et le produit net sont des conclusions distinctes. Les coûts inconnus restent indisponibles. Les réparations ne sont pas automatiquement soustraites de la valeur en l’état.", "Los valores de mercado, los costos de reparación y la recuperación neta son conclusiones distintas. Los costos desconocidos no están disponibles. Las reparaciones no se restan automáticamente del valor en su estado."),
  ], [{ headers: [field, value, l("Basis and status", "Base et état", "Base y estado")], rows: [
    [preLoss, amount(a.valuations.preLoss.amount), status(a.valuations.preLoss.status)],
    [asIs, amount(a.valuations.asIs.amount), status(a.valuations.asIs.status)],
    [repair, amount(a.repairs.total), status(a.repairs.status)], [net, amount(a.netRecovery.total), status(a.netRecovery.status)],
  ] }]);
  section("assignment-scope", l("Assignment Scope and Valuation Premise", "Portée du mandat et principe d’évaluation", "Alcance del encargo y premisa de valoración"), [
    l("Submitted photographs and recorded information support this assessment. Photographs do not establish mechanical condition, legal title, structural safety or battery health. Claim and repair authorization remain separate professional decisions.", "Les photographies soumises et les renseignements consignés appuient cette évaluation. Les photographies n’établissent pas l’état mécanique, le titre légal, la sécurité structurelle ni l’état de la batterie. L’autorisation de réclamation et de réparation demeure une décision professionnelle distincte.", "Las fotografías aportadas y la información registrada respaldan esta valoración. Las fotografías no establecen el estado mecánico, la titularidad legal, la seguridad estructural ni el estado de la batería. La autorización de reclamaciones y reparaciones sigue siendo una decisión profesional independiente."),
  ], [pairs([
    [l("Effective valuation date", "Date effective d’évaluation", "Fecha efectiva de valoración"), shown(inputs?.effectiveDate)],
    [l("Currency", "Devise", "Moneda"), shown(data.currency)],
    [l("Intended use (appraiser)", "Utilisation prévue (évaluateur)", "Uso previsto (tasador)"), shown(context.intended_use)],
    [l("Scope of work (appraiser)", "Portée des travaux (évaluateur)", "Alcance del trabajo (tasador)"), shown(context.scope_of_work)],
    [l("Valuation premise (appraiser)", "Principe d’évaluation (évaluateur)", "Premisa de valoración (tasador)"), shown(context.valuation_premise)],
    [l("Inspection basis (appraiser)", "Base d’inspection (évaluateur)", "Base de inspección (tasador)"), shown(context.inspection_basis)],
  ])]);
  section("condition-analysis", l("Condition and Loss Analysis", "Analyse de l’état et du sinistre", "Análisis del estado y del siniestro"), [], [pairs([
    [l("Pre-loss condition (appraiser)", "État avant sinistre (évaluateur)", "Estado previo al siniestro (tasador)"), shown(context.pre_loss_condition)],
    [l("Reported post-loss condition", "État déclaré après sinistre", "Estado declarado tras el siniestro"), shown(inputs?.condition ?? data.item_condition)],
    [l("Damage description", "Description des dommages", "Descripción de daños"), shown(inputs?.damageDescription ?? data.damage_description)],
    [l("Reported loss type", "Type de sinistre déclaré", "Tipo de siniestro declarado"), shown(inputs?.lossType ?? data.reported_loss_type)],
    [l("Documented vehicle brand", "Statut du véhicule documenté", "Clasificación documentada del vehículo"), shown(inputs?.documentedBrand)],
    [l("Brand evidence", "Preuve du statut", "Evidencia de clasificación"), shown(inputs?.brandEvidenceRef)],
  ])]);
  if (a?.vehicleDetails) section("vehicle-specifications", l("Vehicle Specifications and Photo Evidence", "Caractéristiques du véhicule et preuves photographiques", "Especificaciones del vehículo y evidencia fotográfica"), [], [{
    headers: [field, value, l("Origin", "Origine", "Origen"), evidence], rows: a.vehicleDetails.fields.map(f => [f.label, shown(f.value),
      f.status === "manual" ? l("Appraiser supplied", "Fourni par l’évaluateur", "Aportado por el tasador") : f.status === "observed" ? l("Observed in photos", "Observé sur les photos", "Observado en fotos") : f.status === "conflict" ? l("Conflicting evidence", "Preuves contradictoires", "Evidencia contradictoria") : l("Cannot find from image", "Introuvable dans l’image", "No se encuentra en la imagen"),
      f.evidence.map(e => `${e.photoId}: ${e.evidence}${e.rejectionReason ? ` (${systemMessage(e.rejectionReason)})` : ""}`).join("\n") || unknown]),
  }]);
  const refs = a?.references || [];
  const knownRefs = new Map(refs.map(r => [r.id, r]));
  const support = (item: any) => [array(item.referenceIds).map(id => knownRefs.has(id) ? `[${id}]` : `${id} (${l("missing reference", "référence manquante", "referencia ausente")})`).join(", "), text(item.appraiserReason) ? `${l("Appraiser rationale", "Justification de l’évaluateur", "Justificación del tasador")}: ${item.appraiserReason}` : ""].filter(Boolean).join("\n") || unknown;
  const provenanceRows: string[][] = [
    [l("Estimate status (appraiser)", "État de l’estimation (évaluateur)", "Estado de estimación (tasador)"), shown(context.repair_estimate_status)],
    [l("Estimate date", "Date de l’estimation", "Fecha de estimación"), shown(context.repair_estimate_date)],
    [l("Lead times and availability (appraiser)", "Délais et disponibilité (évaluateur)", "Plazos y disponibilidad (tasador)"), shown(context.lead_time_notes)],
  ];
  const costTables: SalvageEnrichmentTable[] = [pairs(provenanceRows)];
  if (a) {
    costTables.push({ headers: [l("Item or task", "Article ou tâche", "Artículo o tarea"), l("Calculation", "Calcul", "Cálculo"), value, evidence], rows: [
      ...a.repairs.parts.map(p => [p.description, `${shown(p.quantity)} × ${amount(p.unitPrice)}`, amount(p.total), support(p)]),
      ...a.repairs.labour.map(p => [p.description, `${shown(p.hours)} h × ${amount(p.rate)}/h`, amount(p.total), support(p)]),
      ...a.repairs.charges.map(p => [p.description, l("Separate charge", "Frais distincts", "Cargo independiente"), amount(p.amount), support(p)]),
    ] });
    costTables.push(pairs([
      [l("Parts subtotal", "Sous-total des pièces", "Subtotal de piezas"), amount(a.repairs.partsTotal)],
      [l("Labour subtotal", "Sous-total de main-d’œuvre", "Subtotal de mano de obra"), amount(a.repairs.labourTotal)],
      [l("Charges subtotal", "Sous-total des frais", "Subtotal de cargos"), amount(a.repairs.chargesTotal)],
      [l("Known subtotal only", "Sous-total connu seulement", "Solo subtotal conocido"), amount(a.repairs.knownSubtotal)], [repair, amount(a.repairs.total)],
    ]));
  } else {
    for (const p of array(data.repair_items)) costTables.push(pairs([[shown(p.name), [text(p.vendor), safeSalvageSourceUrl(p.vendor_link), text(p.notes)].filter(Boolean).join("\n") || unknown]]));
  }
  section("repair-provenance", l("Repair Estimate Provenance", "Provenance de l’estimation des réparations", "Procedencia de la estimación de reparación"), [
    l("Confirm repair scope, supplier availability, labour rates and taxes before authorization. A known subtotal is not a complete repair estimate.", "Confirmez la portée des réparations, la disponibilité des fournisseurs, les taux de main-d’œuvre et les taxes avant autorisation. Un sous-total connu n’est pas une estimation complète.", "Confirme el alcance de reparación, la disponibilidad del proveedor, las tarifas laborales y los impuestos antes de autorizar. Un subtotal conocido no es una estimación completa."),
  ], costTables);
  if (a) {
    section("comparable-verification", l("Comparable Evidence and Verification", "Preuves comparables et vérification", "Evidencia comparable y verificación"), [l("Source verification does not turn an asking price, reserve or current bid into a completed sale. Excluded candidates are retained for review and do not contribute to the conclusion.", "La vérification d’une source ne transforme pas un prix demandé, une réserve ou une enchère actuelle en vente conclue. Les candidats exclus sont conservés pour examen et ne contribuent pas à la conclusion.", "Verificar una fuente no convierte un precio solicitado, reserva o puja actual en una venta realizada. Los candidatos excluidos se conservan para revisión y no contribuyen a la conclusión.")], a.candidates.map(c => pairs([
      [l("Comparable", "Comparable", "Comparable"), `${c.id}: ${c.title}`],
      [l("Valuation group and price basis", "Groupe et base du prix", "Grupo de valoración y base de precio"), `${status(c.basket)} / ${status(c.priceBasis)}`],
      [l("Original price", "Prix d’origine", "Precio original"), c.currency ? amount(c.price, c.currency) : `${shown(c.price)} (${unknown})`],
      [l("Adjusted CAD price", "Prix ajusté en CAD", "Precio ajustado en CAD"), amount(c.adjustedPrice)],
      [l("Currency conversion", "Conversion de devises", "Conversión de moneda"), c.currency === "CAD" ? "CAD" : c.fx ? `1 ${shown(c.currency)} = ${c.fx.cadPerUnit} CAD\n${c.fx.date}\n[${c.fx.referenceId}]` : unavailable],
      [l("Source and listing", "Source et annonce", "Fuente y anuncio"), [c.sourceName, c.listingId, safeSalvageSourceUrl(c.url)].filter(Boolean).join("\n") || unknown],
      [l("Vehicle and equipment", "Véhicule et équipement", "Vehículo y equipo"), [c.year, c.make, c.model, c.trim, c.powertrain].filter(v => v != null && v !== "").join(" / ") || unknown],
      [l("Mileage and condition", "Kilométrage et état", "Kilometraje y estado"), `${shown(c.odometer)} ${text(c.odometerUnit)} / ${shown(c.condition)} / ${shown(c.brand)}`],
      [l("Market and date", "Marché et date", "Mercado y fecha"), [c.location, c.province, c.country, c.eventDate].filter(Boolean).join(" / ") || unknown],
      [l("Verification and valuation treatment", "Vérification et traitement", "Verificación y tratamiento"), `${status(c.verification)}\n${c.selected ? l("Selected for the stated conclusion", "Sélectionné pour la conclusion indiquée", "Seleccionado para la conclusión indicada") : c.eligible ? l("Eligible; not selected", "Admissible; non sélectionné", "Elegible; no seleccionado") : l("Excluded", "Exclu", "Excluido")}\n${c.exclusionReasons.map(systemMessage).join("\n")}`],
      [evidence, support(c)],
      ...quoteRows(c.evidence || {}),
    ])));
    const adjustments = a.candidates.flatMap(c => c.adjustments.map(adj => [c.id, adj.description, amount(adj.amount), support(adj)]));
    section("adjustment-support", l("Adjustment Support Schedule", "Tableau justificatif des ajustements", "Detalle justificativo de ajustes"), adjustments.length ? [] : [l("No adjustments are recorded.", "Aucun ajustement n’est consigné.", "No se registran ajustes.")], [{ headers: [l("Comparable ID", "ID du comparable", "ID comparable"), l("Adjustment", "Ajustement", "Ajuste"), value, evidence], rows: adjustments }]);
    const calcRows: string[][] = [];
    for (const [key, label] of [["preLoss", preLoss], ["asIs", asIs]] as const) {
      const conclusion = a.valuations[key];
      calcRows.push([label, amount(conclusion.amount)], [l("Method and basis", "Méthode et base", "Método y base"), `${localizedSalvageMethod(conclusion, data.language)}\n${status(conclusion.priceBasis)}\n${conclusion.comparableIds.join(", ") || unknown}`],
        [l("Observed range (not a confidence interval)", "Étendue observée (pas un intervalle de confiance)", "Rango observado (no es un intervalo de confianza)"), `${amount(conclusion.low)} – ${amount(conclusion.high)}`],
        [l("Conclusion references", "Références de la conclusion", "Referencias de la conclusión"), conclusion.referenceIds.map(id => `[${id}]`).join(", ") || unknown]);
    }
    calcRows.push([l("Gross salvage proceeds", "Produit brut de récupération", "Ingresos brutos de salvamento"), amount(a.netRecovery.gross)]);
    const costLabels = { fees: l("Seller fees", "Frais du vendeur", "Comisiones del vendedor"), transport: l("Transport", "Transport", "Transporte"), storage: l("Storage", "Entreposage", "Almacenamiento"), disposal: l("Disposal", "Élimination", "Eliminación") };
    for (const key of ["fees", "transport", "storage", "disposal"] as const) {
      const cost = a.netRecovery.deductions[key];
      calcRows.push([costLabels[key], `${amount(cost?.amount)}\n${cost ? support(cost) : unknown}`]);
    }
    calcRows.push([l("Known deductions only", "Déductions connues seulement", "Solo deducciones conocidas"), amount(a.netRecovery.knownDeductions)], [net, amount(a.netRecovery.total)]);
    const ratio = a.repairs.total !== null && a.valuations.preLoss.amount !== null && a.valuations.preLoss.amount > 0 ? `${(100 * a.repairs.total / a.valuations.preLoss.amount).toFixed(1)}%` : unavailable;
    calcRows.push([l("Repair cost / pre-loss value", "Coût de réparation / valeur avant sinistre", "Costo de reparación / valor previo al siniestro"), ratio]);
    section("valuation-calculations", l("Valuation and Recovery Calculations", "Calculs de valeur et de récupération", "Cálculos de valoración y recuperación"), [
      l("Net recovery = gross salvage proceeds − seller fees − transport − storage − disposal. The repair ratio is descriptive only; no claim approval or write-off threshold is assumed.", "Produit net = produit brut de récupération − frais du vendeur − transport − entreposage − élimination. Le ratio de réparation est descriptif; aucun seuil d’approbation ou de perte totale n’est présumé.", "Recuperación neta = ingresos brutos de salvamento − comisiones del vendedor − transporte − almacenamiento − eliminación. La proporción de reparación es solo descriptiva; no se presume ningún umbral de aprobación o pérdida total."),
    ], [pairs(calcRows)]);
  }
  const narrativeRows = [
    [l("Market context (appraiser)", "Contexte du marché (évaluateur)", "Contexto del mercado (tasador)"), context.market_context],
    [l("Research reconciliation (appraiser)", "Rapprochement des recherches (évaluateur)", "Conciliación de investigación (tasador)"), context.reconciliation_notes],
    [l("Conclusion (appraiser)", "Conclusion (évaluateur)", "Conclusión (tasador)"), context.appraiser_conclusion],
    [l("Client comments", "Commentaires du client", "Comentarios del cliente"), context.client_comments],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  if (narrativeRows.length) section("appraiser-narrative", l("Appraiser Narrative and Client Comments", "Analyse de l’évaluateur et commentaires du client", "Análisis del tasador y comentarios del cliente"), [], [pairs(narrativeRows)]);
  if (a) {
    const research = record(a.research);
    const noteText = (raw: unknown): string => typeof raw === "string" ? salvageSystemText(raw) : salvageSystemText(record(raw).text);
    const notes: string[] = [];
    const plan = record(research.plan);
    for (const n of [plan.summary, ...array(plan.priorities), ...array(plan.missingFacts)]) if (noteText(n)) notes.push(noteText(n));
    for (const key of ["preLossSearch", "asIsSearch"]) for (const n of array(record(research[key]).expansionReasons)) if (noteText(n)) notes.push(noteText(n));
    const quality = record(research.qualityReview);
    if (noteText(quality.summary)) notes.push(noteText(quality.summary));
    for (const issue of array(quality.issues)) {
      const n = noteText(issue) || noteText(record(issue).message);
      const ids = [...array(record(issue).candidateIds), ...array(record(issue).photoIds)].map(text).filter(Boolean);
      if (n) notes.push([n, ids.join(", ")].filter(Boolean).join("\n"));
    }
    if (notes.length) section("research-notes", l("Research Plan and Review Notes", "Plan de recherche et notes d’examen", "Plan de investigación y notas de revisión"), [
      l("These research notes are unverified leads for appraiser review, not factual findings, verified citations or valuation evidence.", "Ces notes de recherche sont des pistes non vérifiées pour l’évaluateur, et non des constats, citations vérifiées ou preuves d’évaluation.", "Estas notas de investigación son pistas sin verificar para el tasador, no hallazgos, citas verificadas ni evidencia de valoración."), ...notes,
    ]);
    section("evidence-review", l("Evidence Completeness and Review Flags", "Exhaustivité des preuves et points à examiner", "Integridad de la evidencia y alertas de revisión"), [], [pairs([
      [l("Photo coverage", "Couverture photographique", "Cobertura fotográfica"), `${a.photoFindings.filter(f => f.status === "analyzed").length} / ${photos.length}`],
      [l("Selected pre-loss comparables", "Comparables avant sinistre sélectionnés", "Comparables previos al siniestro seleccionados"), String(a.valuations.preLoss.comparableIds.length)],
      [l("Selected salvage comparables", "Comparables de récupération sélectionnés", "Comparables de salvamento seleccionados"), String(a.valuations.asIs.comparableIds.length)],
      [l("Research freshness", "Actualité de la recherche", "Vigencia de investigación"), a.stale ? l("Subject details changed since research", "Détails du sujet modifiés depuis la recherche", "Los datos del sujeto cambiaron desde la investigación") : l("Compared with saved research inputs", "Comparé aux données de recherche enregistrées", "Comparado con datos de investigación guardados")],
    ]), { headers: [l("Review flag", "Point à examiner", "Alerta de revisión"), detail], rows: a.limitations.map(item => [item.code, salvageSystemText(systemMessage(item.message))]) }]);
  }
  const findingMap = new Map((a?.photoFindings || []).map(f => [f.photoId, f]));
  section("photo-findings", l("Photograph to Finding Index", "Index des photographies et constats", "Índice de fotografías y hallazgos"), photos.length ? [] : [l("No uploaded photographs.", "Aucune photographie téléversée.", "No hay fotografías cargadas.")], [{ headers: [l("Photo ID", "ID photo", "ID de foto"), l("Finding", "Constat", "Hallazgo"), l("Uncertainty", "Incertitude", "Incertidumbre")], rows: photos.map((_, i) => {
    const id = `photo-${String(i + 1).padStart(3, "0")}`, f = findingMap.get(id);
    return [id, f?.status === "analyzed" ? f.observations.join("\n") || l("No observation recorded", "Aucun constat consigné", "Sin observación registrada") : l("Not analyzed", "Non analysé", "No analizada"), f?.uncertainties.join("\n") || (f?.status === "analyzed" ? l("No uncertainty recorded", "Aucune incertitude consignée", "Sin incertidumbre registrada") : unknown)];
  }) }]);
  section("review-checklist", l("Professional Review Checklist", "Liste de contrôle de l’examen professionnel", "Lista de revisión profesional"), [], [{ headers: [l("Reviewer action", "Action de l’examinateur", "Acción del revisor"), l("Required review", "Examen requis", "Revisión requerida")], rows: [
    [l("Identity and claim", "Identité et réclamation", "Identidad y reclamación"), l("Confirm the vehicle, VIN, claim details and title against original records.", "Confirmez le véhicule, le NIV, la réclamation et le titre avec les documents originaux.", "Confirme vehículo, VIN, reclamación y título con los documentos originales.")],
    [repair, l("Confirm scope, source prices, labour and repair authorization.", "Confirmez la portée, les prix sources, la main-d’œuvre et l’autorisation de réparation.", "Confirme alcance, precios de origen, mano de obra y autorización de reparación.")],
    [l("Comparable evidence", "Preuves comparables", "Evidencia comparable"), l("Review price basis, dates, currency and adjustment support.", "Examinez la base du prix, les dates, la devise et les justifications.", "Revise base de precio, fechas, moneda y justificación de ajustes.")],
    [l("Decision and limitations", "Décision et limites", "Decisión y limitaciones"), l("Review unresolved limitations before approval. Workflow approval is recorded separately; this report does not assert a reviewer signature.", "Examinez les limites non résolues avant approbation. L’approbation est consignée séparément; ce rapport n’affirme aucune signature d’examinateur.", "Revise limitaciones pendientes antes de aprobar. La aprobación se registra aparte; este informe no afirma una firma de revisor.")],
  ] }]);
  const history = record(data.report_history);
  if (Number.isInteger(history.revision)) section("revision-history", l("Revision History", "Historique des révisions", "Historial de revisiones"), [
    `${l("Current saved revision", "Révision enregistrée actuelle", "Revisión guardada actual")}: ${history.revision}`,
    l("Recorded edits only. Earlier events may not have a retained audit entry.", "Modifications consignées seulement. Les événements antérieurs peuvent ne pas avoir d’entrée conservée.", "Solo cambios registrados. Los eventos anteriores pueden no tener una entrada conservada."),
  ], [{ headers: [l("Revision", "Révision", "Revisión"), l("Date", "Date", "Fecha"), l("Changed fields", "Champs modifiés", "Campos modificados")], rows: array(history.events).map(event => [shown(event.revision), shown(event.at), array(event.changedFields).map(f => salvageSystemText(text(f).replace(/_/g, " "))).join(", ") || unknown]) }]);
  const register: string[][] = refs.map(r => [r.id, r.title, r.kind === "web" ? l("Retrieved source", "Source consultée", "Fuente consultada") : r.kind === "photo" ? l("Photo record", "Dossier photo", "Registro de foto") : l("Appraiser supplied", "Fourni par l’évaluateur", "Aportado por el tasador"), [text(r.publisher), safeSalvageSourceUrl(r.url), text(r.accessedAt), r.photoIds.join(", "), r.excerpt].filter(Boolean).join("\n") || unknown]);
  if (!a) {
    array(data.comparableItems).forEach((c, i) => register.push([`CMP-${String(i + 1).padStart(3, "0")}`, shown(c.title), l("Legacy listing; transaction status unverified", "Annonce antérieure; transaction non vérifiée", "Anuncio anterior; transacción sin verificar"), safeSalvageSourceUrl(c.link) || unknown]));
    array(data.repair_items).forEach((p, i) => { if (p.vendor || p.vendor_link) register.push([`REP-${String(i + 1).padStart(3, "0")}`, shown(p.name), l("Repair source", "Source de réparation", "Fuente de reparación"), [text(p.vendor), safeSalvageSourceUrl(p.vendor_link)].filter(Boolean).join("\n")]); });
  }
  section("references", l("References and Evidence Register", "Références et registre des preuves", "Referencias y registro de evidencia"), register.length ? [] : [l("No external evidence references recorded.", "Aucune référence de preuve externe consignée.", "No se registran referencias de evidencia externa.")], [{ headers: ["ID", l("Source", "Source", "Fuente"), l("Evidence type", "Type de preuve", "Tipo de evidencia"), detail], rows: register }]);
  return { schemaVersion: 1, sections };
}
