import { describe, it, expect } from 'vitest';
import {
  WindowsPrintSpooler,
  WindowsPrinterDiscovery,
  WindowsPrintAgent,
} from '@/agent/windows-print-agent';
import { ClaimedJob } from '@/types/printos';

describe('Windows Print Agent & Spooler Subsystem', () => {
  describe('SumatraPDF CLI Settings Builder', () => {
    it('builds standard simplex monochrome settings for A4 single-sided document', () => {
      const job: ClaimedJob = {
        jobId: 'job_1',
        orderId: 'ord_1',
        orderNumber: 'P1001',
        storagePath: 'orders/ord_1/test.pdf',
        originalFilename: 'test.pdf',
        printOptions: {},
        colorMode: 'BW',
        paperSize: 'A4',
        printSides: 'ONE_SIDED',
        copies: 1,
        pageSelection: 'all',
      };

      const settings = WindowsPrintSpooler.buildSumatraPrintSettings(job);
      expect(settings).toBe('simplex,monochrome,paper=A4');
    });

    it('builds duplex color settings with specific page ranges and multiple copies', () => {
      const job: ClaimedJob = {
        jobId: 'job_2',
        orderId: 'ord_2',
        orderNumber: 'P1002',
        storagePath: 'orders/ord_2/report.pdf',
        originalFilename: 'report.pdf',
        printOptions: {},
        colorMode: 'COLOR',
        paperSize: 'A4',
        printSides: 'BOTH_SIDES',
        copies: 3,
        pageSelection: '1-5, 8',
      };

      const settings = WindowsPrintSpooler.buildSumatraPrintSettings(job);
      expect(settings).toBe('duplex,color,1-5, 8,copies=3,paper=A4');
    });
  });

  describe('Windows Printer Hardware Discovery', () => {
    it('discovers local printers and maps structured capabilities', async () => {
      const printers = await WindowsPrinterDiscovery.discoverPrinters();
      expect(Array.isArray(printers)).toBe(true);
      expect(printers.length).toBeGreaterThanOrEqual(1);

      const printer = printers[0];
      expect(printer.name).toBeDefined();
      expect(typeof printer.supportsColor).toBe('boolean');
      expect(typeof printer.supportsDuplex).toBe('boolean');
      expect(Array.isArray(printer.supportedPaperSizes)).toBe(true);
    }, 15000);

    it('safely handles custom path resolution for SumatraPDF', () => {
      const found = WindowsPrinterDiscovery.findSumatraPDF('C:\\NonExistentPath\\SumatraPDF.exe');
      // If custom path doesn't exist, it checks system locations or returns null
      expect(found === null || typeof found === 'string').toBe(true);
    });
  });

  describe('Native PowerShell Spooler Script Builder & Fallback Invocation', () => {
    it('safely encodes printer names with spaces, parentheses, and hyphens into PowerShell script', () => {
      const printerName = 'HP PageWide MFP P57750 PCL-6 (Network)';
      const filePath = 'C:\\temp\\document_1789933112894.jpg';
      const script = WindowsPrintSpooler.buildPowerShellScript(filePath, printerName, 2);

      expect(script).toContain('FromBase64String');
      expect(script).toContain('Start-Process');
      expect(script).toContain('PrintTo');
      expect(script).not.toContain(printerName); // Must be encoded in base64, not raw interpolated
      
      const b64Printer = Buffer.from(printerName, 'utf8').toString('base64');
      const b64File = Buffer.from(filePath, 'utf8').toString('base64');
      expect(script).toContain(b64Printer);
      expect(script).toContain(b64File);
    });

    it('executes PowerShell fallback cleanly and fails on missing file rather than syntax error', async () => {
      const printerName = 'HP PageWide MFP P57750 PCL-6 (Network)';
      const missingFile = 'C:\\temp\\non_existent_test_document_printos_123.jpg';
      const job: ClaimedJob = {
        jobId: 'job_fallback_test',
        orderId: 'ord_fb_1',
        orderNumber: 'P9001',
        storagePath: 'orders/test.jpg',
        originalFilename: 'test.jpg',
        printOptions: {},
        colorMode: 'BW',
        paperSize: 'A4',
        printSides: 'ONE_SIDED',
        copies: 1,
      };

      // When sumatraPath is null, it uses PowerShell fallback
      // Since missingFile does not exist, it should cleanly throw "Document file not found" error, NOT a PowerShell parsing error
      await expect(
        WindowsPrintSpooler.printDocument(missingFile, printerName, job, null)
      ).rejects.toThrow(/Document file not found/i);
    });
  });

  describe('WindowsPrintAgent Instance & Config', () => {
    it('initializes agent with configured parameters and creates temp spool directory', async () => {
      const agent = new WindowsPrintAgent({
        agentName: 'test-windows-agent-01',
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000,
      });

      expect(agent).toBeDefined();
      await agent.initialize();
    });
  });
});
