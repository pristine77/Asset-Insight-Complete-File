/**
 * The failure an Auctioneer delivery is allowed to show the operator.
 *
 * A delivery reports one of two things. Either it knows what went wrong and the
 * person retrying it can act on the answer — a photo on an untrusted host, an
 * attachment that is not an image, a lot the contract does not have — or it hit
 * something nobody anticipated, in which case the message is deliberately vague
 * because it would otherwise leak internals into a screen.
 *
 * THE DIFFERENCE IS THE TYPE, NOT THE WORDING. safeDeliveryError used to decide
 * it by matching the start of the message against a list of known phrases, which
 * meant a new message — or an edited one — silently became "Auctioneer delivery
 * failed while preparing or uploading the approved report data" and stopped
 * being actionable. Two of the photo service's own messages were in exactly that
 * state: they named the problem precisely and the operator never saw either.
 *
 * So anything thrown as this is meant to be read by the person retrying, and
 * anything else is a bug worth logging.
 */
export class AuctioneerDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuctioneerDeliveryError";
  }
}

/** Keep stack locations, never raw provider messages, URLs, payloads or credentials. */
export function deliveryErrorDiagnostic(error: unknown) {
  const name = error instanceof Error && ["Error", "TypeError", "RangeError", "SyntaxError", "DocumentNotFoundError", "VersionError", "AuctioneerDeliveryError", "Auctioneer2ClientError"].includes(error.name) ? error.name : "Error";
  const frames = error instanceof Error ? (error.stack || "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 12) : [];
  return { name, stack: frames.map(line => line.replace(/(?:https?|mongodb(?:\+srv)?):\/\/[^\s)]+/gi, "[redacted-url]").slice(0, 400)).join("\n") };
}
