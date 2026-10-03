import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #126 曾在此建立社會科技「3 選 1」抽牌系統的四張表：
 * social_techs／player_researched_social_techs／player_tech_domains／
 * player_tech_hand。Task #469 全面改為全球統一線性科技樹
 * （見 techTreeMigrations.ts），舊表於原建立處 supersede DROP——
 * 不得移到其他模組（部分執行的測試遷移會讓舊 DDL 復活造成 dev 漂移）。
 * 研發進度全面重置：舊資料不遷移。
 */
export async function runSocialTechMigrations(): Promise<void> {
  await withTestMigrationStamp("social-tech", runSocialTechMigrationsInner);
}

async function runSocialTechMigrationsInner(): Promise<void> {
  // 子表先刪（player_tech_hand.tech_id 無跨表 FK；其餘 FK 指向 social_techs）。
  await db.execute(sql`DROP TABLE IF EXISTS player_tech_hand`);
  await db.execute(sql`DROP TABLE IF EXISTS player_tech_domains`);
  await db.execute(sql`DROP TABLE IF EXISTS player_researched_social_techs`);
  await db.execute(sql`DROP TABLE IF EXISTS social_techs`);
}
