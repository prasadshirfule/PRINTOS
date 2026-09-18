-- ============================================================================
-- PRINTOS Database Schema Migration 00002: Development / Test Seed Data
-- ============================================================================
-- WARNING: DO NOT RUN THIS IN PRODUCTION!
-- This script contains default testing hardware and a known test agent secret token.

INSERT INTO print_settings (
    default_paper,
    bw_price_paisa,
    color_price_paisa,
    duplex_price_paisa,
    a5_bw_price_paisa,
    a5_color_price_paisa,
    max_copies,
    max_file_size_bytes
) VALUES (
    'A4',
    200,
    1000,
    200,
    100,
    500,
    50,
    52428800
) ON CONFLICT DO NOTHING;

INSERT INTO printers (
    id,
    name,
    location,
    status,
    is_active,
    supports_color,
    supports_duplex,
    supported_paper_sizes
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Mock Shop Laser Printer',
    'Front Counter',
    'ONLINE',
    true,
    true,
    true,
    '{"A4", "A5"}'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO print_agents (
    id,
    agent_name,
    api_key_hash,
    status,
    version,
    capabilities
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    'shop-pc-01',
    -- sha256 of 'mock-agent-secret-token'
    '9b66236b285b0d09a5b3a3c26b9a8cfefefb54cf21d2e1c4a035728a47401c10',
    'ONLINE',
    '1.0.0',
    '{"printer": "Mock Shop Laser Printer", "duplex": true, "color": true}'::jsonb
) ON CONFLICT (agent_name) DO NOTHING;