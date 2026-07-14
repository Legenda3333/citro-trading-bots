--  СХЕМА БАЗЫ ДАННЫХ (Supabase / PostgreSQL) — ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ.
--  Схема под контролем версий (а не только в живом проде Supabase).
--
--  БЕЗОПАСНО ЗАПУСКАТЬ НА ЛЮБОЙ БАЗЕ (в т.ч. на живом проде):
--  всё создаётся через «IF NOT EXISTS» — существующие таблицы, данные и индексы
--  НЕ трогаются, до-создаётся только то, чего не хватает. В частности, если
--  критический уникальный индекс bot_orders_active_level (защита от дублей
--  ордеров) когда-нибудь пропадёт — этот файл его вернёт.
--
--  ПОРЯДОК ВАЖЕН при пересоздании с нуля: таблицы идут по зависимостям внешних
--  ключей (users → api_keys → bots → bot_orders / bot_trades). auth_attempts
--  ни от кого не зависит. На уже существующей базе порядок роли не играет.
--
--  Как применить: Supabase → SQL Editor → вставить весь файл → Run.


-- users: пользователи (логин + bcrypt-хэш пароля)
create table if not exists public.users (
  id uuid not null default gen_random_uuid (),
  username character varying(30) not null,
  password_hash text not null,
  created_at timestamp with time zone null default now(),
  user_number serial not null,
  constraint users_pkey primary key (id),
  constraint users_username_key unique (username)
) TABLESPACE pg_default;


-- api_keys: биржевые ключи пользователя (секрет — AES-256-GCM)
create table if not exists public.api_keys (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  name character varying(32) not null,
  api_key text not null,
  api_secret_encrypted text not null,
  exchange character varying(32) not null default 'citronus'::character varying,
  created_at timestamp with time zone not null default now(),
  constraint api_keys_pkey primary key (id),
  constraint api_keys_user_key_uniq unique (user_id, api_key),
  constraint api_keys_user_name_uniq unique (user_id, name),
  constraint api_keys_user_id_fkey foreign KEY (user_id) references users (id) on delete CASCADE
) TABLESPACE pg_default;


-- bots: боты пользователя (config — параметры сетки в jsonb)
-- api_key_id → RESTRICT: нельзя удалить ключ, пока его держит бот
-- (при мягком удалении бота api_key_id обнуляется, см. api/bots/delete.js).
create table if not exists public.bots (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  api_key_id uuid null,
  name character varying not null,
  strategy character varying not null default 'spot_grid'::character varying,
  status character varying not null default 'inactive'::character varying,
  status_message text null,
  config jsonb not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  deleted_at timestamp with time zone null,
  base_qty numeric null,
  constraint bots_pkey primary key (id),
  constraint bots_api_key_id_fkey foreign KEY (api_key_id) references api_keys (id) on delete RESTRICT,
  constraint bots_user_id_fkey foreign KEY (user_id) references users (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists bots_user_id_idx
  on public.bots using btree (user_id) TABLESPACE pg_default;

-- Имя бота уникально среди НЕ удалённых ботов пользователя
-- (имена удалённых ботов можно переиспользовать).
create unique INDEX IF not exists bots_user_name_active_uniq
  on public.bots using btree (user_id, name) TABLESPACE pg_default
  where (deleted_at is null);

-- Стартовый объём ордера сетки (в CITRO). От него воркер «докомпенсирует» объём
-- встречных ордеров, чтобы позиция не уменьшалась из-за комиссий. Для уже
-- существующей базы добавляем столбец отдельно (идемпотентно).
alter table public.bots add column if not exists base_qty numeric;


-- bot_orders: желаемое/фактическое состояние ордеров сетки
-- Статусы: 'placing' (намерение) → 'open' (стоит на бирже) → 'filled' | 'cancelled'.
create table if not exists public.bot_orders (
  id uuid not null default gen_random_uuid (),
  bot_id uuid not null,
  level_index integer not null,
  side character varying not null,
  price numeric not null,
  amount numeric not null,
  exchange_order_id character varying null,
  status character varying not null default 'placing'::character varying,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint bot_orders_pkey primary key (id),
  constraint bot_orders_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists bot_orders_bot_idx
  on public.bot_orders using btree (bot_id) TABLESPACE pg_default;

-- ★ КРИТИЧЕСКИЙ ИНДЕКС — «главный предохранитель» от дублей ордеров.
-- Запрещает две АКТИВНЫЕ (placing/open) записи на одном уровне сетки одного бота.
-- На нём держится идемпотентность воркера: повторный create_order упирается в
-- нарушение уникальности (код 23505), и воркер понимает — ордер уже есть.
-- НЕ УДАЛЯТЬ. Без него возможны двойные ордера на реальные деньги.
create unique INDEX IF not exists bot_orders_active_level
  on public.bot_orders using btree (bot_id, level_index) TABLESPACE pg_default
  where (
    (status)::text = any (
      (array['placing'::character varying, 'open'::character varying])::text[]
    )
  );


-- bot_trades: журнал фактических сделок и обменов (для статистики)
-- kind: 'fill' (исполнение ордера сетки) | 'rebalance' (стартовый обмен валюты).
create table if not exists public.bot_trades (
  id uuid not null default gen_random_uuid (),
  bot_id uuid not null,
  exchange_order_id character varying null,
  side character varying not null,
  kind character varying not null default 'fill'::character varying,
  level_index integer null,
  price numeric null,
  amount numeric null,
  total numeric null,
  fee numeric null,
  raw jsonb null,
  filled_at timestamp with time zone null,
  created_at timestamp with time zone not null default now(),
  constraint bot_trades_pkey primary key (id),
  constraint bot_trades_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists bot_trades_bot_idx
  on public.bot_trades using btree (bot_id) TABLESPACE pg_default;

-- Идемпотентность сделок: одна и та же сделка (тот же бот + тот же биржевой ордер
-- + тот же тип) не запишется дважды и не задвоит прибыль в статистике. Служит
-- целью ON CONFLICT в воркере (upsert «вставить, при конфликте ничего не делать»).
-- Записи без биржевого id (exchange_order_id = NULL) сюда не попадают как «равные»
-- (в Postgres NULL ≠ NULL), поэтому редкие такие строки правилом не блокируются.
--
-- ⚠ Если эта команда упадёт с ошибкой уникальности — значит в базе УЖЕ есть
-- задвоенные сделки. Тогда сначала один раз удалите лишние копии (оставив самую
-- раннюю), затем повторите создание индекса:
--
-- delete from public.bot_trades t
--  using public.bot_trades d
--  where t.exchange_order_id is not null
--    and t.bot_id            = d.bot_id
--    and t.exchange_order_id = d.exchange_order_id
--    and t.kind              = d.kind
--    and (t.created_at > d.created_at
--         or (t.created_at = d.created_at and t.ctid > d.ctid));
create unique INDEX IF not exists bot_trades_dedup_uniq
  on public.bot_trades using btree (bot_id, exchange_order_id, kind) TABLESPACE pg_default;


-- auth_attempts: счётчик неудачных попыток входа/регистрации (rate limit по IP)
create table if not exists public.auth_attempts (
  id uuid not null default gen_random_uuid (),
  ip text not null,
  kind text not null,
  created_at timestamp with time zone not null default now(),
  constraint auth_attempts_pkey primary key (id)
) TABLESPACE pg_default;

create index IF not exists auth_attempts_ip_kind_time_idx
  on public.auth_attempts using btree (ip, kind, created_at) TABLESPACE pg_default;


--  worker_lease: «ключ» единственного воркера (leader lease).
--  Торгует только тот воркер, который держит этот ключ. Защищает от двойных
--  ордеров, когда на секунды пересекаются два процесса (например при деплое).
--  Всегда ровно одна строка (id = 1).
create table if not exists public.worker_lease (
  id integer not null default 1,
  holder text null,
  expires_at timestamp with time zone null,
  updated_at timestamp with time zone not null default now(),
  constraint worker_lease_pkey primary key (id),
  constraint worker_lease_single_row check (id = 1)
) TABLESPACE pg_default;

-- Единственная строка ключа (создаётся один раз; повторный запуск её не трогает).
insert into public.worker_lease (id, holder, expires_at)
values (1, null, null)
on conflict (id) do nothing;

-- Взять или продлить ключ. Возвращает true, если ключ теперь у p_holder.
-- Один UPDATE → два воркера не смогут взять ключ одновременно: условие пропустит,
-- только если ключ свободен, уже наш, или протух (expires_at < now()).
create or replace function public.acquire_worker_lease(p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql
as $$
declare
  v_ok boolean;
begin
  update public.worker_lease
     set holder     = p_holder,
         expires_at = now() + make_interval(secs => p_ttl_seconds),
         updated_at = now()
   where id = 1
     and (holder is null or holder = p_holder or expires_at < now())
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- Отдать ключ (сработает, только если он наш) — для аккуратной остановки воркера.
create or replace function public.release_worker_lease(p_holder text)
returns void
language plpgsql
as $$
begin
  update public.worker_lease
     set holder = null, expires_at = null, updated_at = now()
   where id = 1 and holder = p_holder;
end;
$$;


--  apply_fills: АТОМАРНАЯ реакция на исполнение ордеров сетки (вызывает воркер).
--  Одной транзакцией: (1) помечает исполнившиеся ордера 'filled' — освобождая их
--  уровни в уникальном индексе bot_orders_active_level; (2) вставляет встречные
--  ордера ('placing') — уровни к этому моменту уже свободны, поэтому НИ цепочка
--  соседних исполнений, НИ «кольцевой» случай (покупка и соседняя продажа в один
--  тик) не упрутся в индекс и не «потеряют» встречный ордер; (3) идемпотентно
--  пишет сделки в bot_trades. Всё применяется ЦЕЛИКОМ либо никак: при сбое ордера
--  остаются 'open' и распознаются как исполнения снова на следующем тике.
--
--  ВАЖНО: применять схему ДО деплоя воркера — воркер вызывает эту функцию, и без
--  неё реакция на исполнение будет откладываться (безопасно: без потери ордеров).
--
--  p_source_ids — id строк bot_orders исполнившихся ордеров → 'filled';
--  p_counters   — [{level_index, side, price, amount}] встречные к постановке;
--  p_trades     — [{exchange_order_id, side, kind, level_index, price, amount,
--                   total, fee, raw, filled_at}] сделки для статистики.
--  Возвращает jsonb-массив реально вставленных встречных [{id, level_index, side,
--  price, amount}] — их воркер и выставляет на бирже.
create or replace function public.apply_fills(
  p_bot_id     uuid,
  p_source_ids uuid[],
  p_counters   jsonb,
  p_trades     jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_counter jsonb;
  v_trade   jsonb;
  v_id      uuid;
  v_out     jsonb := '[]'::jsonb;
begin
  -- 1) Освобождаем уровни исполнившихся ордеров (снимается уникальный индекс уровня).
  if p_source_ids is not null and array_length(p_source_ids, 1) is not null then
    update public.bot_orders
       set status = 'filled', updated_at = now()
     where bot_id = p_bot_id
       and id = any (p_source_ids)
       and status in ('open', 'placing');
  end if;

  -- 2) Встречные ордера. Уровни уже свободны В ЭТОЙ транзакции. Если уровень всё же
  --    занят ЖИВЫМ (не исполнившимся) ордером — тихо пропускаем (правило «только
  --    если пусто»); вложенный BEGIN..EXCEPTION не даёт такому конфликту оборвать
  --    всю транзакцию.
  for v_counter in select * from jsonb_array_elements(coalesce(p_counters, '[]'::jsonb))
  loop
    begin
      insert into public.bot_orders (bot_id, level_index, side, price, amount, status)
      values (
        p_bot_id,
        (v_counter->>'level_index')::int,
        (v_counter->>'side'),
        (v_counter->>'price')::numeric,
        (v_counter->>'amount')::numeric,
        'placing'
      )
      returning id into v_id;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id',          v_id,
        'level_index', (v_counter->>'level_index')::int,
        'side',        (v_counter->>'side'),
        'price',       (v_counter->>'price')::numeric,
        'amount',      (v_counter->>'amount')::numeric
      ));
    exception when unique_violation then
      null;   -- уровень занят живым ордером — встречный не нужен
    end;
  end loop;

  -- 3) Идемпотентно фиксируем сделки для статистики (дубль по (bot_id,
  --    exchange_order_id, kind) не задвоит прибыль).
  for v_trade in select * from jsonb_array_elements(coalesce(p_trades, '[]'::jsonb))
  loop
    insert into public.bot_trades
      (bot_id, exchange_order_id, side, kind, level_index, price, amount, total, fee, raw, filled_at)
    values (
      p_bot_id,
      nullif(v_trade->>'exchange_order_id', ''),
      (v_trade->>'side'),
      coalesce(nullif(v_trade->>'kind', ''), 'fill'),
      nullif(v_trade->>'level_index', '')::int,
      nullif(v_trade->>'price', '')::numeric,
      nullif(v_trade->>'amount', '')::numeric,
      nullif(v_trade->>'total', '')::numeric,
      nullif(v_trade->>'fee', '')::numeric,
      v_trade->'raw',
      nullif(v_trade->>'filled_at', '')::timestamptz
    )
    on conflict (bot_id, exchange_order_id, kind) do nothing;
  end loop;

  return v_out;
end;
$$;


--  RLS (Row Level Security)
--  В проде RLS включён на всех таблицах, публичных политик нет: публичный REST
--  (anon-ключ) не отдаёт ни строки, а приложение ходит только через service-role,
--  который RLS обходит. Здесь — чтобы при пересоздании базы защита включилась
--  сама. Повторный запуск безопасен: включение уже включённого RLS — no-op.
alter table public.users         enable row level security;
alter table public.api_keys      enable row level security;
alter table public.bots          enable row level security;
alter table public.bot_orders    enable row level security;
alter table public.bot_trades    enable row level security;
alter table public.auth_attempts enable row level security;
alter table public.worker_lease  enable row level security;
