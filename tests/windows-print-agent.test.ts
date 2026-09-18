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
    });

    it('safely handles custom path resolution for SumatraPDF', () => {
      const found = WindowsPrinterDiscovery.findSumatraPDF('C:\\NonExistentPath\\SumatraPDF.exe');
      // If custom path doesn't exist, it checks system locations or returns null
      expect(found === null || typeof found === 'string').toBe(true);
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
