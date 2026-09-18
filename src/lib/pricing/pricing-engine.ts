import { ColorMode, PaperSize, PricingConfig, PrintSides } from '@/types/printos';
import { parsePageRange } from './page-range';

export interface PriceCalculationInput {
  paperSize: PaperSize;
  colorMode: ColorMode;
  printSides: PrintSides;
  copies: number;
  totalDocumentPages: number;
  pageSelection?: string | null;
  discountPaisa?: number;
}

export interface PriceBreakdown {
  printablePages: number;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  printSides: PrintSides;
  ratePerPagePaisa: number;
  ratePerPageFormatted: string;
  subtotalPaisa: number;
  discountPaisa: number;
  totalAmountPaisa: number;
  totalAmountFormatted: string;
  currency: string;
  normalizedPageSelection: string;
}

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingValidationError';
  }
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  defaultPaper: 'A4',
  bwPricePaisa: 200,          // ₹2.00
  colorPricePaisa: 1000,      // ₹10.00
  duplexPricePaisa: 200,      // ₹2.00
  a5BwPricePaisa: 100,       // ₹1.00
  a5ColorPricePaisa: 500,    // ₹5.00
  maxCopies: 50,
  maxFileSizeBytes: 52428800, // 50MB
  allowedFileTypes: ['pdf', 'jpg', 'jpeg', 'png'],
  retentionHours: 24,
};

export function formatPaisa(paisa: number, currency = '₹'): string {
  const rupees = (paisa / 100).toFixed(2);
  return `${currency}${rupees}`;
}

/**
 * Pure domain service for calculating print job prices deterministically.
 * All monetary calculations are performed in integer minor currency units (paisa).
 */
export function calculatePrintOrderPrice(
  input: PriceCalculationInput,
  config: PricingConfig = DEFAULT_PRICING_CONFIG
): PriceBreakdown {
  const { paperSize, colorMode, printSides, copies, totalDocumentPages, pageSelection, discountPaisa = 0 } = input;

  if (!Number.isInteger(copies) || copies <= 0) {
    throw new PricingValidationError(`Copies must be a positive integer greater than 0, received ${copies}.`);
  }

  if (copies > config.maxCopies) {
    throw new PricingValidationError(
      `Requested ${copies} copies exceeds the shop maximum allowed limit of ${config.maxCopies}.`
    );
  }

  if (discountPaisa < 0 || !Number.isInteger(discountPaisa)) {
    throw new PricingValidationError('Discount must be a non-negative integer in paisa.');
  }

  // Parse and validate the page selection
  const parsedRange = parsePageRange(pageSelection, totalDocumentPages);
  const printablePages = parsedRange.count;

  // Determine rate per page based on paper size and color mode
  let ratePerPagePaisa: number;
  if (paperSize === 'A4') {
    if (colorMode === 'COLOR') {
      ratePerPagePaisa = config.colorPricePaisa;
    } else {
      ratePerPagePaisa = printSides === 'BOTH_SIDES' ? config.duplexPricePaisa : config.bwPricePaisa;
    }
  } else if (paperSize === 'A5') {
    if (colorMode === 'COLOR') {
      ratePerPagePaisa = config.a5ColorPricePaisa;
    } else {
      ratePerPagePaisa = config.a5BwPricePaisa;
    }
  } else {
    throw new PricingValidationError(`Unsupported paper size: "${paperSize}".`);
  }

  const subtotalPaisa = printablePages * copies * ratePerPagePaisa;
  const totalAmountPaisa = Math.max(0, subtotalPaisa - discountPaisa);

  return {
    printablePages,
    copies,
    paperSize,
    colorMode,
    printSides,
    ratePerPagePaisa,
    ratePerPageFormatted: formatPaisa(ratePerPagePaisa),
    subtotalPaisa,
    discountPaisa,
    totalAmountPaisa,
    totalAmountFormatted: formatPaisa(totalAmountPaisa),
    currency: 'INR',
    normalizedPageSelection: parsedRange.normalizedString,
  };
}
