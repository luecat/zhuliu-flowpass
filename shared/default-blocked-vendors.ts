/**
 * The disqualifying-vendor list as data, not as code.
 *
 * Every term here is an ordinary denylist entry: the same kind of string an
 * admin types into the program settings screen, matched the same way. Nothing
 * about screening is decided by logic hidden in a module — a receipt is
 * rejected because a term on a readable list appears in it, and a reviewer can
 * point at the entry that did it.
 *
 * This is the shipped starting point for a program cycle. Once seeded into a
 * cycle's softwareBlacklist it is the stored list that governs, so editing the
 * list in the admin screen changes the decision without a release.
 *
 * Matching folds traditional characters to simplified (shared/chinese-variants.ts),
 * so simplified spellings cover both scripts and only one needs listing.
 * Compiled from vendor rankings published through 2026; it dates, which is the
 * reason it lives in editable data.
 */

/** PRC / Hong Kong / Macau AI vendors, products and aliases. */
export const DEFAULT_BLOCKED_REGION_VENDORS: readonly string[] = [
  // 百度
  '百度', 'baidu', '文心', 'ernie',
  // 阿里巴巴
  '阿里巴巴', '阿里云', 'alibaba', 'aliyun', '通义', 'tongyi', '千问', 'qwen',
  // 字节跳动
  '字节', 'bytedance', '豆包', 'doubao', '火山引擎', '剪映', 'capcut', '即梦', 'dreamina', '飞书', 'feishu',
  // 腾讯
  '腾讯', 'tencent', '混元', 'hunyuan', '元宝', 'yuanbao',
  // 科大讯飞
  '讯飞', 'iflytek', '星火', 'sparkdesk', '听见',
  // 智谱
  '智谱', 'zhipu', 'chatglm', 'bigmodel', '清言',
  // 月之暗面
  '月之暗面', 'moonshot', 'kimi',
  // 其他大模型厂商
  '百川', 'baichuan',
  'minimax', '海螺', 'hailuo',
  '商汤', '商量', 'sensetime', 'sensechat',
  'deepseek', '深度求索',
  '阶跃', 'stepfun',
  '零一万物', '01.ai',
  '紫东太初', '天工', 'tiangong', '昆仑万维', 'kunlun', 'skywork',
  '华为', 'huawei', '盘古', 'pangu',
  // 手机厂商
  '小米', 'xiaomi', 'mimo', 'milm', '蓝心', 'bluelm', 'andesgpt', '安第斯', '荣耀',
  // 互联网平台
  '网易', 'netease', '有道', 'youdao', '伏羲',
  '搜狗', 'sogou', '快手', 'kuaishou', '可灵', 'kling',
  '美图', 'meitu', '万兴', 'wondershare', 'filmora', '稿定',
  '硅基流动', 'siliconflow', '面壁', 'modelbest', 'minicpm', '七牛', 'qiniu',
  '书生', 'internlm', '上海人工智能实验室', '智源', '悟道',
  '秘塔', 'metaso', '出门问问', 'mobvoi', '澜舟', 'langboat',
  '蚂蚁集团', '百灵', '灵光', '京东', '言犀', '美团', 'meituan', 'longcat',
  '三六零', '360智脑', '纳米ai',
  '云从', 'cloudwalk', '旷视', 'megvii', '依图', 'yitu', '寒武纪', 'cambricon',
  '作业帮', '学而思', '好未来',
  '生数', 'vidu', 'pixverse', '爱诗', 'liblib', '无界ai', 'tiamat',
  'manus', '蝴蝶效应',
  '金山', 'kingsoft', 'wps', '钉钉', 'dingtalk',
  // 地區
  '香港', 'hong kong', '澳门', 'macau', 'macao', '中国', 'mainland china',
];

/**
 * API relay shops, shared-quota resale and the token-package product names
 * they bill under. Individual relay sites are short-lived and number in the
 * hundreds, so the trade vocabulary carries the list and only the best-known
 * names are spelled out.
 */
export const DEFAULT_BLOCKED_RESELLER_TERMS: readonly string[] = [
  '中转', '中转站', '镜像站',
  '代充', '代付', '代购', '代开', '转售',
  '拼车', '车队', '号池', '共享账号',
  'token plan', 'token套餐', 'token方案', 'token额度', 'token点数',
  'api中转', 'api代理', 'api池',
  'api2d', 'openai-sb', 'openai-hk', 'chatanywhere', 'aiproxy', 'one-api', 'new-api',
  'gptgod', 'closeai', 'oaipro', 'burn.hair',
];

/** The shipped seed for a program cycle's softwareBlacklist. */
export const DEFAULT_BLOCKED_VENDORS: readonly string[] = [
  ...DEFAULT_BLOCKED_REGION_VENDORS,
  ...DEFAULT_BLOCKED_RESELLER_TERMS,
];
