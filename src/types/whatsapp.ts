import { OrderStatus } from './printos';

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface IWhatsAppService {
  sendText(to: string, message: string): Promise<void>;
  sendInteractiveButtons(to: string, message: string, buttons: WhatsAppButton[]): Promise<void>;
  sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<void>;
  sendStatusMessage(to: string, status: OrderStatus, orderNumber: string): Promise<void>;
}
