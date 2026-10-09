-- 命令與結算所需欄位(冪等)
ALTER TABLE armies ADD COLUMN IF NOT EXISTS assigned_seat integer REFERENCES seats(id) ON DELETE SET NULL;
ALTER TABLE armies ADD COLUMN IF NOT EXISTS pinned integer NOT NULL DEFAULT 0;
-- 常駐守備與比利時旗標:存在 games 上,讓結算可以從資料庫完整還原狀態
ALTER TABLE games ADD COLUMN IF NOT EXISTS garrisons jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE games ADD COLUMN IF NOT EXISTS belgium_invaded boolean NOT NULL DEFAULT false;
-- 命令:每回合每軍團只留一條(後下覆蓋前下)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('move','attack','hold'));
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_per_army_turn ON orders (game_id, turn, army_id);
CREATE INDEX IF NOT EXISTS armies_game_idx ON armies (game_id);
