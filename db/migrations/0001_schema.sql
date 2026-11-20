-- =====================================================================
-- Altiora Pedidos — 0001: esquema base
-- Todas as tabelas vivem no esquema "altiora" (o executor de migrações
-- cria o esquema e define o search_path). Este esquema não é exposto
-- pela API de dados automática do Supabase (apenas o esquema "public").
--
-- Dinheiro: guardado em CÊNTIMOS (bigint). 1 Kz = 100 cêntimos.
-- Isto evita erros de arredondamento; nunca se usa vírgula flutuante.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Utilizadores e sessões (acedidos apenas pelo servidor, em contexto "sistema")
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL,
  name                 text NOT NULL,
  password_hash        text NOT NULL,
  is_platform_admin    boolean NOT NULL DEFAULT false,
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_ck CHECK (
    email = lower(email) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT users_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Restaurantes (inquilinos)
-- ---------------------------------------------------------------------
CREATE TABLE restaurants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text NOT NULL,
  description      text,
  logo_url         text,
  cover_url        text,
  accent_color     text,
  address          text,
  phone            text,
  status           text NOT NULL DEFAULT 'ativo',
  accepting_orders boolean NOT NULL DEFAULT true,
  timezone         text NOT NULL DEFAULT 'Africa/Luanda',
  currency         text NOT NULL DEFAULT 'AOA',
  service_fee_bps  integer NOT NULL DEFAULT 0,   -- taxa de serviço em pontos-base (1000 = 10 %)
  menu_base_url    text,                         -- domínio próprio dos menus (opcional)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurants_name_ck   CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT restaurants_slug_ck   CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 60),
  CONSTRAINT restaurants_desc_ck   CHECK (description IS NULL OR length(description) <= 500),
  CONSTRAINT restaurants_logo_ck   CHECK (logo_url  IS NULL OR (length(logo_url)  <= 500 AND logo_url  ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*)$')),
  CONSTRAINT restaurants_cover_ck  CHECK (cover_url IS NULL OR (length(cover_url) <= 500 AND cover_url ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*)$')),
  CONSTRAINT restaurants_accent_ck CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT restaurants_addr_ck   CHECK (address IS NULL OR length(address) <= 200),
  CONSTRAINT restaurants_phone_ck  CHECK (phone IS NULL OR length(phone) <= 40),
  CONSTRAINT restaurants_status_ck CHECK (status IN ('ativo', 'suspenso', 'desativado')),
  CONSTRAINT restaurants_currency_ck CHECK (currency = 'AOA'),
  CONSTRAINT restaurants_fee_ck    CHECK (service_fee_bps BETWEEN 0 AND 3000),
  CONSTRAINT restaurants_base_url_ck CHECK (menu_base_url IS NULL OR menu_base_url ~ '^https://[a-z0-9.-]+(:[0-9]{2,5})?$')
);
CREATE UNIQUE INDEX restaurants_slug_uq ON restaurants (slug);
CREATE TRIGGER restaurants_updated_at BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- O fuso horário tem de existir na base de dados (os relatórios dependem dele).
CREATE FUNCTION restaurants_check_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'INVALID_TIMEZONE' USING ERRCODE = 'AL005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurants_timezone_ck BEFORE INSERT OR UPDATE OF timezone ON restaurants
  FOR EACH ROW EXECUTE FUNCTION restaurants_check_timezone();

CREATE TABLE restaurant_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_members_role_ck CHECK (role IN ('manager', 'waiter', 'kitchen')),
  CONSTRAINT restaurant_members_uq UNIQUE (restaurant_id, user_id)
);
CREATE INDEX restaurant_members_user_idx ON restaurant_members (user_id);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  restaurant_id       uuid REFERENCES restaurants (id) ON DELETE CASCADE,
  token_hash          text NOT NULL,                -- SHA-256 do token; o token em claro nunca é guardado
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,         -- expira por inatividade (deslizante)
  absolute_expires_at timestamptz NOT NULL,         -- limite máximo de duração
  revoked_at          timestamptz,
  ip                  text,
  user_agent          text,
  CONSTRAINT sessions_token_uq UNIQUE (token_hash)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------
CREATE TABLE categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  name          text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT categories_id_rest_uq UNIQUE (id, restaurant_id)
);
CREATE UNIQUE INDEX categories_name_uq ON categories (restaurant_id, lower(name));
CREATE INDEX categories_order_idx ON categories (restaurant_id, display_order);
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  category_id   uuid NOT NULL,
  name          text NOT NULL,
  description   text,
  image_url     text,
  price_cents   bigint NOT NULL,
  available     boolean NOT NULL DEFAULT true,   -- false = esgotado (continua visível)
  active        boolean NOT NULL DEFAULT true,   -- false = desativado (não aparece no menu)
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT menu_items_name_ck  CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT menu_items_desc_ck  CHECK (description IS NULL OR length(description) <= 600),
  CONSTRAINT menu_items_image_ck CHECK (image_url IS NULL OR (length(image_url) <= 500 AND image_url ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*)$')),
  CONSTRAINT menu_items_price_ck CHECK (price_cents BETWEEN 0 AND 100000000000),
  CONSTRAINT menu_items_id_rest_uq UNIQUE (id, restaurant_id),
  CONSTRAINT menu_items_category_fk FOREIGN KEY (category_id, restaurant_id)
    REFERENCES categories (id, restaurant_id) ON DELETE RESTRICT
);
CREATE INDEX menu_items_category_idx ON menu_items (category_id);
CREATE INDEX menu_items_rest_idx ON menu_items (restaurant_id, active, display_order);
CREATE TRIGGER menu_items_updated_at BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE menu_item_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  menu_item_id      uuid NOT NULL,
  name              text NOT NULL,
  price_delta_cents bigint NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  display_order     integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT menu_item_options_name_ck  CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT menu_item_options_price_ck CHECK (price_delta_cents BETWEEN 0 AND 100000000000),
  CONSTRAINT menu_item_options_id_rest_uq UNIQUE (id, restaurant_id),
  CONSTRAINT menu_item_options_item_fk FOREIGN KEY (menu_item_id, restaurant_id)
    REFERENCES menu_items (id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX menu_item_options_item_idx ON menu_item_options (menu_item_id);
CREATE TRIGGER menu_item_options_updated_at BEFORE UPDATE ON menu_item_options FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Mesas e sessões de mesa
-- ---------------------------------------------------------------------
CREATE TABLE restaurant_tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  table_number  integer NOT NULL,
  label         text,
  qr_token      text NOT NULL,                       -- segredo aleatório (128 bits) que vai no QR Code
  qr_rotated_at timestamptz NOT NULL DEFAULT now(),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_tables_number_ck CHECK (table_number BETWEEN 1 AND 9999),
  CONSTRAINT restaurant_tables_label_ck  CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 60),
  CONSTRAINT restaurant_tables_token_ck  CHECK (length(qr_token) >= 22),
  CONSTRAINT restaurant_tables_id_rest_uq UNIQUE (id, restaurant_id),
  CONSTRAINT restaurant_tables_number_uq UNIQUE (restaurant_id, table_number)
);
CREATE UNIQUE INDEX restaurant_tables_token_uq ON restaurant_tables (qr_token);
CREATE TRIGGER restaurant_tables_updated_at BEFORE UPDATE ON restaurant_tables FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Uma "sessão de mesa" agrupa os pedidos de uma mesma ocupação da mesa.
CREATE TABLE table_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  table_id         uuid NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  closed_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  close_reason     text,
  CONSTRAINT table_sessions_id_rest_uq UNIQUE (id, restaurant_id),
  CONSTRAINT table_sessions_table_fk FOREIGN KEY (table_id, restaurant_id)
    REFERENCES restaurant_tables (id, restaurant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX table_sessions_open_uq ON table_sessions (table_id) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------
CREATE TABLE order_counters (
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  day           date NOT NULL,
  last_number   integer NOT NULL,
  PRIMARY KEY (restaurant_id, day)
);

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  table_id          uuid NOT NULL,
  table_session_id  uuid,
  table_number      integer NOT NULL,     -- cópia do número da mesa no momento do pedido (preenchido por trigger)
  table_label       text,                 -- idem para a designação da mesa
  order_day         date NOT NULL,        -- preenchido por trigger (fuso do restaurante)
  order_number      integer NOT NULL,     -- número curto do dia (#1, #2, ...), preenchido por trigger
  public_code       text NOT NULL,        -- código aleatório (128 bits) para a consulta pública do estado
  status            text NOT NULL DEFAULT 'novo',
  source            text NOT NULL DEFAULT 'qr',
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  subtotal_cents    bigint NOT NULL,
  service_fee_cents bigint NOT NULL,
  total_cents       bigint NOT NULL,
  notes             text,
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  preparing_at      timestamptz,
  ready_at          timestamptz,
  delivered_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  CONSTRAINT orders_status_ck CHECK (status IN ('novo', 'em_preparacao', 'pronto', 'entregue', 'cancelado')),
  CONSTRAINT orders_source_ck CHECK (source IN ('qr', 'staff')),
  CONSTRAINT orders_money_ck  CHECK (subtotal_cents >= 0 AND service_fee_cents >= 0 AND total_cents = subtotal_cents + service_fee_cents),
  CONSTRAINT orders_code_ck   CHECK (length(public_code) >= 22),
  CONSTRAINT orders_notes_ck  CHECK (notes IS NULL OR length(notes) <= 500),
  CONSTRAINT orders_idem_ck   CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 16 AND 100),
  CONSTRAINT orders_reason_ck CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 300),
  CONSTRAINT orders_id_rest_uq UNIQUE (id, restaurant_id),
  CONSTRAINT orders_public_code_uq UNIQUE (public_code),
  CONSTRAINT orders_number_uq UNIQUE (restaurant_id, order_day, order_number),
  CONSTRAINT orders_table_fk FOREIGN KEY (table_id, restaurant_id)
    REFERENCES restaurant_tables (id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT orders_session_fk FOREIGN KEY (table_session_id, restaurant_id)
    REFERENCES table_sessions (id, restaurant_id) ON DELETE SET NULL (table_session_id)
);
CREATE UNIQUE INDEX orders_idem_uq ON orders (restaurant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_board_idx   ON orders (restaurant_id, status, created_at);
CREATE INDEX orders_created_idx ON orders (restaurant_id, created_at DESC);
CREATE INDEX orders_table_idx   ON orders (table_id, created_at DESC);
CREATE INDEX orders_session_idx ON orders (table_session_id);

CREATE TABLE order_items (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id             uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  order_id                  uuid NOT NULL,
  menu_item_id              uuid,
  item_name_snapshot        text NOT NULL,
  unit_price_snapshot_cents bigint NOT NULL,
  quantity                  integer NOT NULL,
  notes                     text,
  line_total_cents          bigint NOT NULL,
  position                  integer NOT NULL DEFAULT 0,
  CONSTRAINT order_items_qty_ck   CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT order_items_money_ck CHECK (unit_price_snapshot_cents >= 0 AND line_total_cents >= 0),
  CONSTRAINT order_items_notes_ck CHECK (notes IS NULL OR length(notes) <= 300),
  CONSTRAINT order_items_id_rest_uq UNIQUE (id, restaurant_id),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id, restaurant_id)
    REFERENCES orders (id, restaurant_id) ON DELETE CASCADE,
  CONSTRAINT order_items_menu_fk FOREIGN KEY (menu_item_id, restaurant_id)
    REFERENCES menu_items (id, restaurant_id) ON DELETE SET NULL (menu_item_id)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_item_options (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id             uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  order_item_id             uuid NOT NULL,
  option_id                 uuid,
  option_name_snapshot      text NOT NULL,
  price_delta_snapshot_cents bigint NOT NULL,
  quantity                  integer NOT NULL DEFAULT 1,
  CONSTRAINT order_item_options_qty_ck   CHECK (quantity BETWEEN 1 AND 20),
  CONSTRAINT order_item_options_price_ck CHECK (price_delta_snapshot_cents >= 0),
  CONSTRAINT order_item_options_item_fk FOREIGN KEY (order_item_id, restaurant_id)
    REFERENCES order_items (id, restaurant_id) ON DELETE CASCADE,
  CONSTRAINT order_item_options_opt_fk FOREIGN KEY (option_id, restaurant_id)
    REFERENCES menu_item_options (id, restaurant_id) ON DELETE SET NULL (option_id)
);
CREATE INDEX order_item_options_item_idx ON order_item_options (order_item_id);

CREATE TABLE order_status_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  order_id        uuid NOT NULL,
  previous_status text,
  new_status      text NOT NULL,
  changed_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  changed_by_role text,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_status_history_order_fk FOREIGN KEY (order_id, restaurant_id)
    REFERENCES orders (id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

-- ---------------------------------------------------------------------
-- Pagamentos (regista-se o método e o estado; não se guardam dados de cartões)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  order_id      uuid NOT NULL,
  method        text NOT NULL,
  amount_cents  bigint NOT NULL,
  status        text NOT NULL DEFAULT 'pendente',
  reference     text,
  recorded_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_method_ck CHECK (method IN ('dinheiro', 'terminal', 'transferencia', 'outro')),
  CONSTRAINT payments_status_ck CHECK (status IN ('pendente', 'pago', 'isento', 'reembolsado', 'anulado')),
  CONSTRAINT payments_amount_ck CHECK (amount_cents >= 0),
  CONSTRAINT payments_ref_ck    CHECK (reference IS NULL OR length(reference) <= 100),
  CONSTRAINT payments_order_fk FOREIGN KEY (order_id, restaurant_id)
    REFERENCES orders (id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_rest_idx ON payments (restaurant_id, created_at DESC);
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Auditoria (só se acrescenta; ninguém altera nem apaga)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id uuid REFERENCES restaurants (id) ON DELETE SET NULL,
  actor_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role    text,
  action        text NOT NULL,
  entity_type   text,
  entity_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_action_ck CHECK (length(action) BETWEEN 1 AND 80)
);
CREATE INDEX audit_logs_rest_idx ON audit_logs (restaurant_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
