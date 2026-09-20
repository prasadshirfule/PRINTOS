-- ============================================================================
-- PRINTOS Database Schema Migration 00006: Dedicated WhatsApp Chat ID for JID/LID/Group Transports
-- ============================================================================

-- 1. Add whatsapp_chat_id to whatsapp_conversations to preserve explicit JID/LID/Group chat transport identities separately from customer phone numbers
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS whatsapp_chat_id TEXT NULL;

-- 2. Backfill whatsapp_chat_id for legacy conversations where customer_phone already contains an explicit WhatsApp JID domain (@c.us, @lid, @g.us)
UPDATE whatsapp_conversations
SET whatsapp_chat_id = customer_phone
WHERE whatsapp_chat_id IS NULL AND customer_phone LIKE '%@%';

-- 3. If duplicate conversations exist in the same shop for the same whatsapp_chat_id, keep the most recently active one and nullify older duplicates
WITH ranked_duplicates AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY shop_id, whatsapp_chat_id 
               ORDER BY last_interaction_at DESC, created_at DESC
           ) as rn
    FROM whatsapp_conversations
    WHERE whatsapp_chat_id IS NOT NULL
)
UPDATE whatsapp_conversations
SET whatsapp_chat_id = NULL
WHERE id IN (
    SELECT id FROM ranked_duplicates WHERE rn > 1
);

-- 4. Unique partial index on (shop_id, whatsapp_chat_id) ensuring non-null chat IDs are unique per tenant shop
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_conversations_shop_chat_id 
ON whatsapp_conversations(shop_id, whatsapp_chat_id) 
WHERE whatsapp_chat_id IS NOT NULL;
