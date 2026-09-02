// Generated from express-policy.v1.json. Run tools/generate-contract.mjs after editing the JSON.
export const EXPRESS_POLICY = {
  "schema": 1,
  "androidBaseline": "1.2.11",
  "sources": {
    "default": "interface6",
    "alternate": "interface5",
    "maxBindingsPerSource": 5,
    "toggleTapCount": 3,
    "toggleWindowMs": 1500
  },
  "retention": {
    "signedMs": 604800000,
    "cancelledMs": 14400000,
    "signedRefreshMs": 86400000
  },
  "pendingQueries": {
    "ttlMs": 86400000,
    "retryMs": 1800000
  },
  "status": {
    "labels": {
      "CANCELLED": "已取消",
      "DANGER": "异常件",
      "ORDERED": "已下单",
      "SHIPPED": "已发货",
      "PICKED": "已揽件",
      "TRANSIT": "运输中",
      "DELIVERY": "派送中",
      "WAITING_PICKUP": "待取件",
      "COMPLETED": "已签收",
      "UNKNOWN": "暂无状态"
    },
    "listPriority": [
      "WAITING_PICKUP",
      "DELIVERY",
      "TRANSIT",
      "PICKED",
      "SHIPPED",
      "ORDERED",
      "DANGER",
      "UNKNOWN",
      "CANCELLED",
      "COMPLETED"
    ],
    "widgetPriority": [
      "WAITING_PICKUP",
      "DELIVERY",
      "TRANSIT",
      "PICKED",
      "SHIPPED",
      "ORDERED",
      "COMPLETED"
    ]
  },
  "manualAuthority": {
    "requiresTimedTrack": true,
    "completedOutranksNonTerminal": true,
    "terminalCompleteMinTimedTracksByProvider": {
      "kdniao": 2
    },
    "tieBreakOrder": [
      "jingdong_h5",
      "cainiao_h5",
      "kuaidi100_h5",
      "moto",
      "meizu",
      "oppo",
      "kdniao",
      "kuaidi100"
    ]
  },
  "orders": {
    "unprojectedSemantic": "ORDERED",
    "preferTimedSource": true
  },
  "widgets": {
    "mediumRowLimit": 3,
    "compactIconLimit": 4
  },
  "carrierQuery": {
    "records": [
      {
        "standardCode": "SF",
        "displayName": "顺丰速运",
        "kuaidi100Code": "shunfeng",
        "hotline": "95338",
        "iconKey": "sf",
        "requiresPhoneTail": true,
        "aliases": [
          "SFEXPRESS",
          "SHUNFENG"
        ],
        "nameAliases": [
          "顺丰",
          "顺丰快递"
        ]
      },
      {
        "standardCode": "ZTO",
        "displayName": "中通快递",
        "kuaidi100Code": "zhongtong",
        "hotline": "95311",
        "iconKey": "zto",
        "requiresPhoneTail": true,
        "aliases": [
          "ZHONGTONG"
        ],
        "nameAliases": [
          "中通"
        ]
      },
      {
        "standardCode": "ZTOKY",
        "displayName": "中通快运",
        "kuaidi100Code": "zhongtongkuaiyun",
        "hotline": "",
        "iconKey": "zto",
        "requiresPhoneTail": false,
        "aliases": [],
        "nameAliases": []
      },
      {
        "standardCode": "YTO",
        "displayName": "圆通速递",
        "kuaidi100Code": "yuantong",
        "hotline": "95554",
        "iconKey": "yto",
        "requiresPhoneTail": false,
        "aliases": [
          "YUANTONG"
        ],
        "nameAliases": [
          "圆通",
          "圆通快递"
        ]
      },
      {
        "standardCode": "STO",
        "displayName": "申通快递",
        "kuaidi100Code": "shentong",
        "hotline": "95543",
        "iconKey": "sto",
        "requiresPhoneTail": false,
        "aliases": [
          "SHENTONG"
        ],
        "nameAliases": [
          "申通"
        ]
      },
      {
        "standardCode": "YD",
        "displayName": "韵达快递",
        "kuaidi100Code": "yunda",
        "hotline": "95546",
        "iconKey": "yd",
        "requiresPhoneTail": false,
        "aliases": [
          "YUNDA"
        ],
        "nameAliases": [
          "韵达",
          "韵达速递"
        ]
      },
      {
        "standardCode": "JD",
        "displayName": "京东快递",
        "kuaidi100Code": "jd",
        "hotline": "950616",
        "iconKey": "jd",
        "requiresPhoneTail": true,
        "aliases": [
          "JDKD",
          "JINGDONG",
          "JDLEX"
        ],
        "codePrefixAliases": [
          "JD"
        ],
        "nameAliases": [
          "京东",
          "京东物流",
          "京东快递"
        ]
      },
      {
        "standardCode": "JDKY",
        "displayName": "京东快运",
        "kuaidi100Code": "jingdongkuaiyun",
        "hotline": "950616",
        "iconKey": "jd",
        "requiresPhoneTail": false,
        "aliases": [],
        "nameAliases": []
      },
      {
        "standardCode": "EMS",
        "displayName": "EMS",
        "kuaidi100Code": "ems",
        "hotline": "11183",
        "iconKey": "ems",
        "requiresPhoneTail": false,
        "aliases": [
          "EYB"
        ],
        "nameAliases": [
          "邮政EMS",
          "邮政特快"
        ]
      },
      {
        "standardCode": "YZPY",
        "displayName": "邮政快递",
        "kuaidi100Code": "youzhengguonei",
        "hotline": "11183",
        "iconKey": "yzpy",
        "requiresPhoneTail": false,
        "aliases": [
          "POST",
          "POSTB",
          "CHINAPOST",
          "YOUZHENGGUONEI",
          "YOUZHENGBK"
        ],
        "nameAliases": [
          "邮政",
          "邮政快递包裹",
          "中国邮政",
          "邮政国内标准",
          "邮政包裹",
          "包裹信件"
        ]
      },
      {
        "standardCode": "JTSD",
        "displayName": "极兔速递",
        "kuaidi100Code": "jtexpress",
        "hotline": "956025",
        "iconKey": "jtsd",
        "requiresPhoneTail": false,
        "aliases": [
          "JT",
          "J&T",
          "JTEXPRESS",
          "JITU"
        ],
        "nameAliases": [
          "极兔"
        ]
      },
      {
        "standardCode": "HTKY",
        "displayName": "极兔速递",
        "kuaidi100Code": "huitongkuaidi",
        "hotline": "",
        "iconKey": "jtsd",
        "requiresPhoneTail": false,
        "aliases": [
          "BEST",
          "BESTQJT",
          "HUITONGKUAIDI"
        ],
        "nameAliases": [
          "百世",
          "百世快递",
          "汇通"
        ]
      },
      {
        "standardCode": "DBL",
        "displayName": "德邦快递",
        "kuaidi100Code": "debangkuaidi",
        "kuaidi100CodeAliases": [
          "debangwuliu"
        ],
        "hotline": "95353",
        "iconKey": "dbl",
        "requiresPhoneTail": false,
        "aliases": [
          "DBKD",
          "DEBANGKUAIDI",
          "DEBANGWULIU"
        ],
        "nameAliases": [
          "德邦",
          "德邦物流"
        ]
      },
      {
        "standardCode": "KYSY",
        "displayName": "跨越速运",
        "kuaidi100Code": "kuayue",
        "hotline": "95324",
        "iconKey": "kysy",
        "requiresPhoneTail": true,
        "aliases": [
          "KY",
          "KUAYUE",
          "KYE"
        ],
        "nameAliases": [
          "跨越"
        ]
      },
      {
        "standardCode": "ZJS",
        "displayName": "宅急送",
        "kuaidi100Code": "zhaijisong",
        "hotline": "4006789000",
        "iconKey": "zjs",
        "requiresPhoneTail": false,
        "aliases": [
          "ZHAIJISONG"
        ],
        "nameAliases": []
      },
      {
        "standardCode": "UC",
        "displayName": "优速快递",
        "kuaidi100Code": "youshuwuliu",
        "hotline": "",
        "iconKey": "uc",
        "requiresPhoneTail": false,
        "aliases": [
          "YOUSHUWULIU"
        ],
        "nameAliases": [
          "优速"
        ]
      },
      {
        "standardCode": "DANNIAO",
        "displayName": "丹鸟速递",
        "kuaidi100Code": "danniao",
        "hotline": "",
        "iconKey": "danniao",
        "requiresPhoneTail": false,
        "aliases": [
          "ZMKM",
          "ZMKMKD"
        ],
        "nameAliases": [
          "丹鸟",
          "丹鸟快递",
          "菜鸟速递",
          "菜鸟直送",
          "菜鸟直送(丹鸟)",
          "菜鸟直送（丹鸟）"
        ]
      }
    ]
  },
  "carrierIcons": {
    "accountOrder": "jdshopping",
    "aliases": {
      "SF": "sf",
      "SFEXPRESS": "sf",
      "SHUNFENG": "sf",
      "ZTO": "zto",
      "ZHONGTONG": "zto",
      "ZTOKY": "zto",
      "ZHONGTONGKUAIYUN": "zto",
      "YTO": "yto",
      "YUANTONG": "yto",
      "STO": "sto",
      "SHENTONG": "sto",
      "YD": "yd",
      "YUNDA": "yd",
      "JD": "jd",
      "JDKD": "jd",
      "JINGDONG": "jd",
      "JDKY": "jd",
      "JINGDONGKUAIYUN": "jd",
      "EMS": "ems",
      "YZPY": "yzpy",
      "POST": "yzpy",
      "POSTB": "yzpy",
      "CHINAPOST": "yzpy",
      "YOUZHENGGUONEI": "yzpy",
      "YOUZHENGBK": "yzpy",
      "JTSD": "jtsd",
      "JT": "jtsd",
      "JITU": "jtsd",
      "JTEXPRESS": "jtsd",
      "DBL": "dbl",
      "DBKD": "dbl",
      "DEBANGKUAIDI": "dbl",
      "DEBANGWULIU": "dbl",
      "KYSY": "kysy",
      "KY": "kysy",
      "KYE": "kysy",
      "KUAYUE": "kysy",
      "ZJS": "zjs",
      "ZHAIJISONG": "zjs",
      "UC": "uc",
      "YOUSHUWULIU": "uc",
      "DANNIAO": "danniao",
      "ZMKM": "danniao",
      "ZMKMKD": "danniao"
    },
    "names": {
      "顺丰": "sf",
      "顺丰快递": "sf",
      "顺丰速运": "sf",
      "中通": "zto",
      "中通快递": "zto",
      "中通快运": "zto",
      "圆通": "yto",
      "圆通快递": "yto",
      "圆通速递": "yto",
      "申通": "sto",
      "申通快递": "sto",
      "韵达": "yd",
      "韵达快递": "yd",
      "韵达速递": "yd",
      "京东": "jd",
      "京东物流": "jd",
      "京东快递": "jd",
      "京东快运": "jd",
      "京东购物": "jdshopping",
      "EMS": "ems",
      "邮政": "yzpy",
      "邮政快递": "yzpy",
      "邮政包裹": "yzpy",
      "邮政快递包裹": "yzpy",
      "邮政国内标准": "yzpy",
      "中国邮政": "yzpy",
      "包裹信件": "yzpy",
      "极兔": "jtsd",
      "极兔速递": "jtsd",
      "德邦": "dbl",
      "德邦快递": "dbl",
      "德邦物流": "dbl",
      "跨越速运": "kysy",
      "宅急送": "zjs",
      "优速快递": "uc",
      "丹鸟": "danniao",
      "丹鸟快递": "danniao",
      "丹鸟速递": "danniao",
      "菜鸟速递": "danniao",
      "菜鸟直送": "danniao",
      "菜鸟直送(丹鸟)": "danniao",
      "菜鸟直送（丹鸟）": "danniao"
    }
  }
} as const;

export type ExpressPolicy = typeof EXPRESS_POLICY;
