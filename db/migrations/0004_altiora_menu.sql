-- =====================================================================
-- ALTIORA MENU — 0004: planos, fotografias e modelos 3D, perfil do restaurante, alergénios, tamanhos,
-- chamar o garçom e pedidos de contacto da página comercial.
--
-- Sem pagamentos no site: não existe nenhuma tabela de pagamentos nova. A assinatura de cada restaurante tem só o plano,
-- o estado e a data até à qual está válida (a Altiora altera-os no painel da plataforma).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Restaurantes: contactos, horário, tema, moeda
-- ---------------------------------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN email         text,
  ADD COLUMN whatsapp      text,
  ADD COLUMN maps_url      text,
  ADD COLUMN opening_hours jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN theme         text    NOT NULL DEFAULT 'dark',
  ADD COLUMN font          text    NOT NULL DEFAULT 'serif',
  ADD COLUMN is_demo       boolean NOT NULL DEFAULT false;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_email_ck    CHECK (email IS NULL OR (length(email) <= 160 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')),
  ADD CONSTRAINT restaurants_whatsapp_ck CHECK (whatsapp IS NULL OR whatsapp ~ '^[0-9]{8,15}$'),
  ADD CONSTRAINT restaurants_maps_ck     CHECK (maps_url IS NULL OR (length(maps_url) <= 500 AND maps_url ~ '^https://[^[:space:]]+$')),
  ADD CONSTRAINT restaurants_hours_ck    CHECK (jsonb_typeof(opening_hours) = 'object' AND length(opening_hours::text) <= 2000),
  ADD CONSTRAINT restaurants_theme_ck    CHECK (theme IN ('dark', 'light')),
  ADD CONSTRAINT restaurants_font_ck     CHECK (font IN ('serif', 'sans'));

ALTER TABLE restaurants DROP CONSTRAINT restaurants_currency_ck;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_currency_ck
  CHECK (currency IN ('AOA', 'USD', 'EUR', 'BRL', 'MZN', 'CVE', 'ZAR', 'GBP'));

-- O cliente vê a página pública do restaurante: contactos, horário e tema (nunca dados de equipa nem de clientes).
GRANT SELECT (address, phone, email, whatsapp, maps_url, opening_hours, theme, font, is_demo, timezone)
  ON restaurants TO altiora_public;
-- O gerente edita o perfil. A moeda e o estado de demonstração só a plataforma altera (mudar a moeda com pedidos já feitos baralharia os valores).
GRANT UPDATE (email, whatsapp, maps_url, opening_hours, theme, font) ON restaurants TO altiora_manager;
-- Cozinha e empregados leem o perfil do seu restaurante (só leitura).
GRANT SELECT (email, whatsapp, maps_url, opening_hours, theme, font, is_demo) ON restaurants TO altiora_kitchen, altiora_waiter;

-- ---------------------------------------------------------------------
-- Pratos: miniatura, modelo 3D, ingredientes e alergénios. Opções: tamanho ou extra.
-- ---------------------------------------------------------------------
ALTER TABLE menu_items
  ADD COLUMN thumb_url   text,
  ADD COLUMN model_url   text,
  ADD COLUMN ingredients text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allergens   text[] NOT NULL DEFAULT '{}';

ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_thumb_ck CHECK (thumb_url IS NULL OR (length(thumb_url) <= 500 AND thumb_url ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*)$')),
  ADD CONSTRAINT menu_items_model_ck CHECK (model_url IS NULL OR model_url ~ '^/a/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD CONSTRAINT menu_items_ingredients_ck CHECK (cardinality(ingredients) <= 30),
  ADD CONSTRAINT menu_items_allergens_ck CHECK (allergens <@ ARRAY['gluten', 'crustaceos', 'ovos', 'peixe', 'amendoim', 'soja', 'leite', 'frutos_casca_rija',
                                                                    'aipo', 'mostarda', 'sesamo', 'sulfitos', 'tremoco', 'moluscos']::text[]);

ALTER TABLE menu_item_options
  ADD COLUMN kind text NOT NULL DEFAULT 'extra',
  ADD CONSTRAINT menu_item_options_kind_ck CHECK (kind IN ('extra', 'size'));

-- ---------------------------------------------------------------------
-- Planos, preços e assinaturas (a Altiora gere tudo no painel da plataforma)
-- ---------------------------------------------------------------------
CREATE TABLE plans (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  tagline       text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  highlighted   boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,     -- false = já não se mostra na página comercial nem se oferece a novos restaurantes
  features      text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_code_ck CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT plans_name_ck CHECK (length(btrim(name)) BETWEEN 2 AND 40),
  CONSTRAINT plans_tagline_ck CHECK (length(tagline) <= 160)
);

CREATE TABLE plan_prices (
  plan_code     text NOT NULL REFERENCES plans (code) ON DELETE CASCADE ON UPDATE CASCADE,
  currency      text NOT NULL,
  monthly_cents bigint NOT NULL,
  yearly_cents  bigint,
  PRIMARY KEY (plan_code, currency),
  CONSTRAINT plan_prices_currency_ck CHECK (currency IN ('AOA', 'USD', 'EUR', 'BRL', 'MZN', 'CVE', 'ZAR', 'GBP')),
  CONSTRAINT plan_prices_monthly_ck CHECK (monthly_cents BETWEEN 0 AND 100000000000),
  CONSTRAINT plan_prices_yearly_ck CHECK (yearly_cents IS NULL OR yearly_cents BETWEEN 0 AND 1000000000000)
);

CREATE TABLE subscriptions (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants (id) ON DELETE CASCADE,
  plan_code     text NOT NULL REFERENCES plans (code) ON UPDATE CASCADE,
  status        text NOT NULL DEFAULT 'ativa',
  valid_until   date,
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_status_ck CHECK (status IN ('ativa', 'em_atraso', 'cancelada')),
  CONSTRAINT subscriptions_notes_ck CHECK (notes IS NULL OR length(notes) <= 500)
);

INSERT INTO plans (code, name, tagline, display_order, highlighted, features) VALUES
  ('starter', 'Starter', 'O cardápio digital do seu restaurante, com QR Code.', 1, false,
     ARRAY['menu', 'qr_codes', 'basic_products']),
  ('pro', 'Pro', 'Pedidos digitais, mesas e estatísticas.', 2, true,
     ARRAY['menu', 'qr_codes', 'basic_products', 'orders', 'whatsapp_orders', 'tables', 'stats', 'advanced_branding']),
  ('premium', 'Premium', 'Pratos em 3D, realidade aumentada e personalização exclusiva.', 3, false,
     ARRAY['menu', 'qr_codes', 'basic_products', 'orders', 'whatsapp_orders', 'tables', 'stats', 'advanced_branding',
           'exclusive_branding', 'model_3d', 'ar', 'advanced_management']);

-- Quem já existia antes dos planos mantém todas as funcionalidades (plano Premium): nada deixa de funcionar na atualização.
INSERT INTO subscriptions (restaurant_id, plan_code, status) SELECT id, 'premium', 'ativa' FROM restaurants;

-- ---------------------------------------------------------------------
-- Ficheiros (fotografias e modelos 3D), guardados na própria base de dados
-- ---------------------------------------------------------------------
CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  content_type  text NOT NULL,
  byte_size     integer NOT NULL,
  sha256        text NOT NULL,
  width         integer,
  height        integer,
  data          bytea NOT NULL,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_kind_ck CHECK (kind IN ('image', 'model')),
  CONSTRAINT assets_type_ck CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'model/gltf-binary')),
  CONSTRAINT assets_size_ck CHECK (byte_size BETWEEN 1 AND 20971520)
);
CREATE INDEX assets_rest_idx ON assets (restaurant_id, created_at);

-- ---------------------------------------------------------------------
-- Chamar o garçom (a única ação do cliente ligada ao atendimento da conta: nada de pagamentos no site)
-- ---------------------------------------------------------------------
CREATE TABLE waiter_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  table_id      uuid NOT NULL,
  table_number  integer NOT NULL,
  table_label   text,
  status        text NOT NULL DEFAULT 'aberta',
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT waiter_calls_status_ck CHECK (status IN ('aberta', 'atendida', 'cancelada')),
  CONSTRAINT waiter_calls_table_fk FOREIGN KEY (table_id, restaurant_id)
    REFERENCES restaurant_tables (id, restaurant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX waiter_calls_open_uq ON waiter_calls (table_id) WHERE status = 'aberta';
CREATE INDEX waiter_calls_rest_idx ON waiter_calls (restaurant_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Pedidos de contacto da página comercial
-- ---------------------------------------------------------------------
CREATE TABLE leads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  business    text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  message     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'novo',
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz,
  CONSTRAINT leads_status_ck CHECK (status IN ('novo', 'contactado', 'arquivado')),
  CONSTRAINT leads_len_ck CHECK (length(name) <= 120 AND length(business) <= 160 AND length(phone) <= 40 AND length(email) <= 160 AND length(message) <= 1500)
);
CREATE INDEX leads_created_idx ON leads (created_at DESC);

-- ---------------------------------------------------------------------
-- Funções controladas
-- ---------------------------------------------------------------------
-- Resolve o endereço público de um restaurante (a página /r/<slug>).
CREATE FUNCTION resolve_restaurant_slug(p_slug text)
RETURNS TABLE (restaurant_id uuid, restaurant_status text, accepting_orders boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT r.id, r.status, r.accepting_orders FROM restaurants r WHERE r.slug = p_slug
$$;

-- Utilização da plataforma: SÓ números agregados por restaurante. Não expõe pedidos, clientes nem valores de vendas.
CREATE FUNCTION platform_usage()
RETURNS TABLE (restaurant_id uuid, tables_count integer, items_count integer, items_with_3d integer, orders_30d integer,
               assets_bytes bigint, last_order_at timestamptz, staff_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT r.id,
         (SELECT count(*)::integer FROM restaurant_tables t WHERE t.restaurant_id = r.id),
         (SELECT count(*)::integer FROM menu_items i WHERE i.restaurant_id = r.id),
         (SELECT count(*)::integer FROM menu_items i WHERE i.restaurant_id = r.id AND i.model_url IS NOT NULL),
         (SELECT count(*)::integer FROM orders o WHERE o.restaurant_id = r.id AND o.created_at > now() - interval '30 days'),
         (SELECT coalesce(sum(a.byte_size), 0)::bigint FROM assets a WHERE a.restaurant_id = r.id),
         (SELECT max(o.created_at) FROM orders o WHERE o.restaurant_id = r.id),
         (SELECT count(*)::integer FROM restaurant_members m WHERE m.restaurant_id = r.id)
  FROM restaurants r
$$;

-- O plano do restaurante atual (o do contexto da ligação) inclui esta funcionalidade? Sem assinatura: só o essencial.
CREATE FUNCTION restaurant_has_feature(p_feature text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT coalesce(
    (SELECT p_feature = ANY (p.features) FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.restaurant_id = app_rid()),
    p_feature IN ('menu', 'qr_codes', 'basic_products'))
$$;

REVOKE ALL ON FUNCTION resolve_restaurant_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION restaurant_has_feature(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restaurant_has_feature(text) TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager;
REVOKE ALL ON FUNCTION platform_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_restaurant_slug(text) TO altiora_public;
GRANT EXECUTE ON FUNCTION platform_usage() TO altiora_platform;

-- ---------------------------------------------------------------------
-- Segurança por linha (RLS) das tabelas novas
-- ---------------------------------------------------------------------
ALTER TABLE plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_prices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiter_calls  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads         ENABLE ROW LEVEL SECURITY;

-- plans e plan_prices: informação comercial, legível por todos; só a plataforma altera.
GRANT SELECT ON plans, plan_prices TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager;
GRANT SELECT, INSERT, UPDATE, DELETE ON plans, plan_prices TO altiora_platform;
CREATE POLICY plans_read ON plans FOR SELECT TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager USING (true);
CREATE POLICY plans_platform_all ON plans FOR ALL TO altiora_platform USING (true) WITH CHECK (true);
CREATE POLICY plan_prices_read ON plan_prices FOR SELECT TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager USING (true);
CREATE POLICY plan_prices_platform_all ON plan_prices FOR ALL TO altiora_platform USING (true) WITH CHECK (true);

-- subscriptions: o gerente vê a do seu restaurante; a plataforma gere todas.
GRANT SELECT ON subscriptions TO altiora_manager;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO altiora_platform;
CREATE POLICY subscriptions_manager_select ON subscriptions FOR SELECT TO altiora_manager USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY subscriptions_platform_all ON subscriptions FOR ALL TO altiora_platform USING (true) WITH CHECK (true);

-- assets: o gerente envia, vê (sem o conteúdo) e apaga os do seu restaurante. A entrega pública passa pelo servidor (/a/<id>).
GRANT SELECT (id, restaurant_id, kind, content_type, byte_size, width, height, created_at) ON assets TO altiora_manager;
GRANT INSERT, DELETE ON assets TO altiora_manager;
CREATE POLICY assets_manager_select ON assets FOR SELECT TO altiora_manager USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY assets_manager_insert ON assets FOR INSERT TO altiora_manager WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY assets_manager_delete ON assets FOR DELETE TO altiora_manager USING (restaurant_id = (SELECT app_rid()));

-- waiter_calls: o cliente só mexe na chamada da sua mesa; empregado e gerente atendem as do restaurante.
GRANT SELECT, INSERT ON waiter_calls TO altiora_public;
GRANT UPDATE (status, resolved_at) ON waiter_calls TO altiora_public;
GRANT SELECT ON waiter_calls TO altiora_waiter, altiora_manager;
GRANT UPDATE (status, resolved_at, resolved_by) ON waiter_calls TO altiora_waiter, altiora_manager;
CREATE POLICY waiter_calls_public_select ON waiter_calls FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()));
CREATE POLICY waiter_calls_public_insert ON waiter_calls FOR INSERT TO altiora_public
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()) AND status = 'aberta');
CREATE POLICY waiter_calls_public_update ON waiter_calls FOR UPDATE TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()) AND status = 'aberta')
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()) AND status = 'cancelada');
CREATE POLICY waiter_calls_staff_select ON waiter_calls FOR SELECT TO altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY waiter_calls_staff_update ON waiter_calls FOR UPDATE TO altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()) AND status = 'aberta')
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND status = 'atendida');

-- leads: só a plataforma lê e trata (os visitantes entram pelo servidor, que valida e limita o ritmo).
GRANT SELECT, DELETE ON leads TO altiora_platform;
GRANT UPDATE (status, handled_at) ON leads TO altiora_platform;
CREATE POLICY leads_platform_all ON leads FOR ALL TO altiora_platform USING (true) WITH CHECK (true);
