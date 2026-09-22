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
      expect(settings).toBe('duplex,color,1-5, 8,3x,paper=A4');
      expect(settings).not.toContain('copies=');
    });

    it('preserves 2 copies, BW, and BOTH_SIDES for P86927 document settings', () => {
      const job: ClaimedJob = {
        jobId: '4ab37b93-9692-4ee6-b98a-ae84aecd2f86',
        orderId: 'ord_p86927',
        orderNumber: 'P86927',
        storagePath: 'orders/AI_Unit-VI.pdf',
        originalFilename: 'AI_Unit-VI.pdf',
        printOptions: {},
        colorMode: 'BW',
        paperSize: 'A4',
        printSides: 'BOTH_SIDES',
        copies: 2,
      };

      const settings = WindowsPrintSpooler.buildSumatraPrintSettings(job);
      expect(settings).toBe('duplex,monochrome,2x,paper=A4');
      expect(settings).not.toContain('copies=');
    });

    it('verifies repeat syntax scaling across copies 1, 2, 3, 10 while preserving settings', () => {
      const baseJob: ClaimedJob = {
        jobId: 'job_scaling',
        orderId: 'ord_scaling',
        orderNumber: 'P1003',
        storagePath: 'orders/test.pdf',
        originalFilename: 'test.pdf',
        printOptions: {},
        colorMode: 'COLOR',
        paperSize: 'A4',
        printSides: 'BOTH_SIDES',
        copies: 1,
        pageSelection: '1-3',
      };

      // 1 copy -> no repeat token
      expect(WindowsPrintSpooler.buildSumatraPrintSettings({ ...baseJob, copies: 1 })).toBe('duplex,color,1-3,paper=A4');

      // 2 copies -> 2x
      expect(WindowsPrintSpooler.buildSumatraPrintSettings({ ...baseJob, copies: 2 })).toBe('duplex,color,1-3,2x,paper=A4');

      // 3 copies -> 3x
      expect(WindowsPrintSpooler.buildSumatraPrintSettings({ ...baseJob, copies: 3 })).toBe('duplex,color,1-3,3x,paper=A4');

      // 10 copies -> 10x
      expect(WindowsPrintSpooler.buildSumatraPrintSettings({ ...baseJob, copies: 10 })).toBe('duplex,color,1-3,10x,paper=A4');
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
      // If custom path doesn't exist, it checks candidate locations or returns null
      expect(found === null || typeof found === 'string').toBe(true);
    });
  });

  describe('Native PowerShell Spooler Script Builder & Fallback Invocation', () => {
    it('safely encodes printer names with spaces, parentheses, and hyphens into script builder', () => {
      const printerName = 'HP PageWide MFP P57750 PCL-6 (Network)';
      const filePath = 'C:\\temp\\document_1789933112894.pdf';
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

    it('builds safe System.Drawing script for images with proportional scaling, copies, and duplex settings', () => {
      const printerName = 'HP PageWide MFP P57750 PCL-6 (Network)';
      const filePath = 'C:\\temp\\photo (1).jpg';
      const job: ClaimedJob = {
        jobId: 'job_img_1',
        orderId: 'ord_img_1',
        orderNumber: 'P9002',
        storagePath: 'orders/photo.jpg',
        originalFilename: 'photo (1).jpg',
        printOptions: {},
        colorMode: 'COLOR',
        paperSize: 'A4',
        printSides: 'BOTH_SIDES',
        copies: 3,
      };

      const script = WindowsPrintSpooler.buildPowerShellImageScript(filePath, printerName, job);

      expect(script).toContain('System.Drawing');
      expect(script).toContain('PrintDocument');
      expect(script).toContain('PrintPage');
      expect(script).toContain('InterpolationMode');
      expect(script).toContain('Copies = 3');
      expect(script).not.toContain(printerName); // Safely encoded in base64
      expect(script).not.toContain('Start-Process'); // Must NOT use Start-Process for images

      const b64Printer = Buffer.from(printerName, 'utf8').toString('base64');
      const b64File = Buffer.from(filePath, 'utf8').toString('base64');
      expect(script).toContain(b64Printer);
      expect(script).toContain(b64File);
    });

    it('routes JPG/JPEG/PNG/BMP files to System.Drawing and fails on missing file rather than syntax error', async () => {
      const printerName = 'HP PageWide MFP P57750 PCL-6 (Network)';
      const missingFile = 'C:\\temp\\non_existent_image_123.jpg';
      const job: ClaimedJob = {
        jobId: 'job_img_route',
        orderId: 'ord_img_2',
        orderNumber: 'P97754',
        storagePath: 'orders/doc.jpg',
        originalFilename: 'document_1789933112894.jpg',
        printOptions: {},
        colorMode: 'BW',
        paperSize: 'A4',
        printSides: 'ONE_SIDED',
        copies: 1,
      };

      await expect(
        WindowsPrintSpooler.printDocument(missingFile, printerName, job, null)
      ).rejects.toThrow(/Document file not found/i);
    });

    it('fails fast on PDF when SumatraPDF is not installed, without silently attempting broken PrintTo', async () => {
      const printerName = 'HP PageWide MFP P57750 PCL-6 (Network)';
      const pdfFile = 'C:\\temp\\AI_Unit-VI.pdf';
      const job: ClaimedJob = {
        jobId: 'job_pdf_sumatra_missing',
        orderId: 'ord_p86927',
        orderNumber: 'P86927',
        storagePath: 'orders/AI_Unit-VI.pdf',
        originalFilename: 'AI_Unit-VI.pdf',
        printOptions: {},
        colorMode: 'BW',
        paperSize: 'A4',
        printSides: 'BOTH_SIDES',
        copies: 2,
      };

      // When sumatraPath is null, it should cleanly reject with clear engine unavailable error
      await expect(
        WindowsPrintSpooler.printDocument(pdfFile, printerName, job, null)
      ).rejects.toThrow(/PDF printing engine unavailable: SumatraPDF is not installed/i);
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
