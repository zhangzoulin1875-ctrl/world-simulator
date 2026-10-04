import test from "node:test";
import assert from "node:assert/strict";
import { pg, stripSslModeParam } from "@workspace/db";

const sslOf = (c: unknown) => (c as { connectionParameters: { ssl?: { rejectUnauthorized?: boolean } | boolean } }).connectionParameters.ssl as { rejectUnauthorized?: boolean } | undefined;

test("stripSslModeParam 移除 sslmode/uselibpqcompat,保留帳密、主機、埠、資料庫", () => {
  const out = stripSslModeParam("postgres://avnadmin:p%40ss%2Fw%3Ard@h.example:23307/defaultdb?sslmode=require&uselibpqcompat=true&application_name=x");
  const u = new URL(out);
  assert.equal(u.searchParams.get("sslmode"), null);
  assert.equal(u.searchParams.get("uselibpqcompat"), null);
  assert.equal(u.searchParams.get("application_name"), "x");
  assert.equal(decodeURIComponent(u.password), "p@ss/w:rd");
  assert.equal(u.username, "avnadmin");
  assert.equal(u.host, "h.example:23307");
  assert.equal(u.pathname, "/defaultdb");
});

test("無法解析的字串原樣返回,不丟例外", () => {
  assert.equal(stripSslModeParam("not a url"), "not a url");
});

test("回歸:連線字串帶 sslmode=require 會蓋掉 ssl 物件;移除後 Client 真正使用 rejectUnauthorized:false", () => {
  const url = "postgres://u:p@h.example:23307/d?sslmode=require";
  const bad = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  assert.notEqual(sslOf(bad)?.rejectUnauthorized, false, "若此處失敗代表 pg 行為改變,修正可能不再必要");
  const good = new pg.Client({ connectionString: stripSslModeParam(url), ssl: { rejectUnauthorized: false } });
  assert.equal(sslOf(good)?.rejectUnauthorized, false);
});
