// 讓依賴 import.meta.env 的前端模組能在 tsx --test 下載入(Vite 之外沒有 import.meta.env)。
// tsx 把 ESM 轉成可被 loader 攔截的形式,這裡用 module hook 在載入時注入。
import { register } from "node:module";
register("./test-vite-env-hooks.mjs", import.meta.url);
