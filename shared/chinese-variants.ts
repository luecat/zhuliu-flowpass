/**
 * Traditional → simplified character folding, so nothing in this system has to
 * care which script a document happens to be written in. A Taiwanese applicant
 * uploads a receipt printed in traditional characters while vendor and denylist
 * names are usually written down in simplified, and matching either one
 * literally means the other silently misses.
 *
 * Folding runs in the traditional → simplified direction because it is the
 * side that is close to one-to-one; the reverse is ambiguous (乾/幹/干 all
 * fold to 干). It is a character substitution, so the folded string keeps the
 * same length and index positions as its input, and a match found in the
 * folded text can be sliced straight out of the original.
 *
 * This is deliberately not a complete conversion table. It covers the
 * characters that turn up in company names, product names and commercial
 * receipt vocabulary — extend it when a real document needs a character that
 * is missing, rather than pulling in a full dictionary.
 */
const VARIANT_PAIRS =
  '騰腾 訊讯 飛飞 華华 為为 盤盘 網网 曠旷 視视 圖图 萬万 興兴 靈灵 動动 書书 實实 驗验 問问 門门 ' +
  '瀾澜 螞蚂 蟻蚁 團团 東东 納纳 雲云 從从 紀纪 業业 幫帮 學学 來来 數数 愛爱 詩诗 無无 應应 釘钉 ' +
  '崑昆 崙仑 維维 寶宝 譜谱 階阶 躍跃 湯汤 義义 節节 夢梦 聽听 見见 藍蓝 榮荣 矽硅 國国 轉转 鏡镜 ' +
  '購购 開开 車车 隊队 號号 帳帐 賬账 額额 點点 億亿 產产 關关 語语 訓训 練练 譯译 認认 識识 習习 ' +
  '機机 聯联 電电 腦脑 軟软 體体 資资 頁页 聲声 頻频 創创 藝艺 術术 設设 計计 寫写 檢检 尋寻 對对 ' +
  '話话 務务 時时 間间 錢钱 價价 買买 賣卖 廠厂 誌志 總总 單单 據据 發发 財财 經经 營营 銷销 費费 ' +
  '戶户 專专 標标 記记 錄录 報报 級级 類类 種种 個个 們们 這这 樣样 稱称 讚赞 絡络 線线 統统 係系 ' +
  '響响 圓圆 齊齐 豐丰 豬猪 鳥鸟 馬马 魚鱼 龍龙 鳳凤 陽阳 陰阴 園园 圍围 壓压 礎础 礙碍 嚴严 靜静 ' +
  '簡简 復复 複复 導导 隨随 險险 檔档 處处 條条';

const VARIANT_MAP: ReadonlyMap<string, string> = new Map(
  VARIANT_PAIRS.trim().split(/\s+/).map((pair) => [pair[0], pair[1]] as const),
);

/** Character-for-character fold; the result has the same length as `value`. */
export function foldChineseVariants(value: string): string {
  let folded = '';
  for (const character of value) {
    folded += VARIANT_MAP.get(character) ?? character;
  }
  return folded;
}

/** Exposed for the table's own test; not meant for matching. */
export const CHINESE_VARIANT_PAIRS = VARIANT_PAIRS;
