# router

第一方判定插件：`router.select` 由 term 承载（无服务进程）。优先选中候选清单里第一个被声明为别名的
候选；否则回落到主名（缺省 `model`）；两者皆无 → `{ ok:false, error:{ code:'no_candidate' } }`。
