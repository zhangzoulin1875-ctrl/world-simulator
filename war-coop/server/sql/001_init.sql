-- war-coop 初始 schema(冪等:可重複執行)
-- 席位規則:每隊 3 個核心職位,之後加入者全為一般軍官。無 AI 代打。

CREATE TABLE IF NOT EXISTS games (
  id            serial PRIMARY KEY,
  scenario      text        NOT NULL,                 -- 例 'ww1-west-1914'
  status        text        NOT NULL DEFAULT 'lobby', -- lobby | running | finished
  turn          integer     NOT NULL DEFAULT 0,
  turn_hours    integer     NOT NULL DEFAULT 4,
  next_turn_at  timestamptz,
  winner_side   text,                                 -- 'DE' | 'FR'
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id          serial PRIMARY KEY,
  discord_id  text UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 席位:一人在一場遊戲只佔一席。role = 3 個核心之一 或 officer
CREATE TABLE IF NOT EXISTS seats (
  id         serial PRIMARY KEY,
  game_id    integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  side       text    NOT NULL CHECK (side IN ('DE','FR')),
  role       text    NOT NULL CHECK (role IN ('commander','chief_of_staff','quartermaster','officer')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, player_id)
);
-- 每隊每個核心職位最多一人;officer 不限
CREATE UNIQUE INDEX IF NOT EXISTS seats_core_unique
  ON seats (game_id, side, role) WHERE role <> 'officer';

-- 區域狀態(地圖 79 區,id 對應 map/regions.json)
CREATE TABLE IF NOT EXISTS region_state (
  game_id    integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  region_id  integer NOT NULL,
  owner      text    NOT NULL,                        -- 目前控制方 'DE'|'FR'|'BE'
  PRIMARY KEY (game_id, region_id)
);

-- 部隊(軍團),位於某區,屬某方
CREATE TABLE IF NOT EXISTS armies (
  id         serial PRIMARY KEY,
  game_id    integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  side       text    NOT NULL,
  name       text    NOT NULL,
  region_id  integer NOT NULL,
  strength   integer NOT NULL DEFAULT 100,
  supply     integer NOT NULL DEFAULT 100
);

-- 命令:玩家每回合下達,回合結算時一併執行
CREATE TABLE IF NOT EXISTS orders (
  id          serial PRIMARY KEY,
  game_id     integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn        integer NOT NULL,
  seat_id     integer NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  army_id     integer NOT NULL REFERENCES armies(id) ON DELETE CASCADE,
  kind        text    NOT NULL CHECK (kind IN ('move','attack','hold')),
  target_region integer,
  status      text    NOT NULL DEFAULT 'pending',     -- pending | approved | rejected | executed
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 戰場訊息(隊內頻道)
CREATE TABLE IF NOT EXISTS messages (
  id         serial PRIMARY KEY,
  game_id    integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  side       text    NOT NULL,
  seat_id    integer REFERENCES seats(id) ON DELETE SET NULL,
  body       text    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 回合日誌
CREATE TABLE IF NOT EXISTS turn_log (
  id         serial PRIMARY KEY,
  game_id    integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn       integer NOT NULL,
  summary    text    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
