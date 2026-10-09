-- Discord 登入 + 遊戲暱稱綁定(冪等)
-- players.discord_id 已存在且 UNIQUE。新增:Discord 顯示資料、遊戲暱稱(唯一,不分大小寫)。
ALTER TABLE players ADD COLUMN IF NOT EXISTS discord_username text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS nickname_changed_at timestamptz;
-- 預覽期的 'preview:xxx' 身分保留可用,但與 Discord 帳號分開,不會被誤綁
CREATE UNIQUE INDEX IF NOT EXISTS players_name_ci_unique ON players (lower(name));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,                 -- sha256(token),資料庫外洩也無法直接盜用
  player_id   integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_player_idx ON sessions(player_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

-- 新 Discord 玩家登入後、取名前,暱稱為空
ALTER TABLE players ALTER COLUMN name DROP NOT NULL;
