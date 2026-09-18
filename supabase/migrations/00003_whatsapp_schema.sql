-- ============================================================================
-- PRINTOS Database Schema Migration 00003: WhatsApp Ingestion, Inbox & Outbox
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTEND PRINT ORDERS WITH EXPLICIT EXPIRATION TIMESTAMP & EXTENDED STATUSES
-- ----------------------------------------------------------------------------
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

ALTER TABLE print_orders DROP CONSTRAINT IF EXISTS print_orders_status_check;
ALTER TABLE print_orders ADD CONSTRAINT print_orders_status_check CHECK (
    status IN (
        'RECEIVED',
        'CONFIGURING',
        'AWAITING_PAYMENT',
        'PAID',
        'QUEUED',
        'WAITING_FOR_PRINTER',
        'PRINTING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'EXPIRED',
        'REFUND_PENDING'
    )
);

-- ----------------------------------------------------------------------------
-- 2. TRIGGER FUNCTION FOR UPDATED_AT
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. WHATSAPP INBOX TABLE (DURABLE INGESTION WITH LEASE LOCKS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_inbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id TEXT UNIQUE NOT NULL, -- Meta wamid
    sender_phone TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (
        status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'RETRYABLE', 'DEAD_LETTER')
    ),
    worker_id TEXT NULL,
    locked_until TIMESTAMPTZ NULL,
    processing_started_at TIMESTAMPTZ NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_claim ON whatsapp_inbox(status, received_at ASC)
WHERE status IN ('RECEIVED', 'RETRYABLE', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_sender ON whatsapp_inbox(sender_phone);

-- ----------------------------------------------------------------------------
-- 4. WHATSAPP CONVERSATIONS TABLE (SESSION STATE & ROW-LEVEL LOCKING)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_phone TEXT UNIQUE NOT NULL, -- Single-shop scope
    customer_name TEXT NULL,
    current_state TEXT NOT NULL DEFAULT 'IDLE' CHECK (
        current_state IN (
            'IDLE',
            'AWAITING_DOCUMENT',
            'DOCUMENT_RECEIVED',
            'COLLECTING_COLOR',
            'COLLECTING_SIDES',
            'COLLECTING_COPIES',
            'COLLECTING_PAGES',
            'CONFIRMING_ORDER',
            'AWAITING_PAYMENT',
            'ORDER_QUEUED',
            'ORDER_PRINTING',
            'ORDER_COMPLETED',
            'ORDER_FAILED',
            'EXPIRED',
            'CANCELLED'
        )
    ),
    active_order_id UUID REFERENCES print_orders(id) ON DELETE SET NULL,
    session_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INT NOT NULL DEFAULT 1,
    last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_state ON whatsapp_conversations(current_state);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_interaction ON whatsapp_conversations(last_interaction_at);

DROP TRIGGER IF EXISTS trg_whatsapp_conversations_updated_at ON whatsapp_conversations;
CREATE TRIGGER trg_whatsapp_conversations_updated_at
BEFORE UPDATE ON whatsapp_conversations
FOR EACH ROW EXECUTE FUNCTION set_updated_at_column();

-- ----------------------------------------------------------------------------
-- 5. WHATSAPP TRANSACTIONAL OUTBOX TABLE (WITH LEASE LOCKS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
    order_id UUID REFERENCES print_orders(id) ON DELETE SET NULL,
    recipient_phone TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'interactive', 'template', 'document', 'image')),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTER')
    ),
    worker_id TEXT NULL,
    locked_until TIMESTAMPTZ NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provider_message_id TEXT NULL,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_dispatch ON whatsapp_outbox(status, next_attempt_at ASC)
WHERE status IN ('PENDING', 'FAILED', 'SENDING');

-- ----------------------------------------------------------------------------
-- 6. WHATSAPP MESSAGE AUDIT LOG TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    message_type TEXT NOT NULL,
    body TEXT NULL,
    media_url TEXT NULL,
    media_mime_type TEXT NULL,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conv ON whatsapp_messages(conversation_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 7. SECURITY & SERVICE ROLE PERMISSIONS
-- ----------------------------------------------------------------------------
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, service_role;
