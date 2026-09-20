-- ============================================================================
-- PRINTOS Database Schema Migration 00006: Dedicated WhatsApp Chat ID for JID/LID/Group Transports
-- ============================================================================

-- Add whatsapp_chat_id to whatsapp_conversations to preserve explicit JID/LID/Group chat transport identities separately from customer phone numbers
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS whatsapp_chat_id TEXT NULL;

-- Index for fast lookup by chat ID per tenant shop
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_chat_id ON whatsapp_conversations(shop_id, whatsapp_chat_id);
