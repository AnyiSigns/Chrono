// `rerank`（候选重排原语 · L3 召回后置）库面：纯计算模块 + 服务协议模块。
// 候选向量化 + MMR（多样性）与可选 listwise 语义重排（eff model.chat，默认关），回 key 顺序。
// 不读投影、无写通道、不取时间；一切输入随 args 传入，跨插件调用只走反向调用（embedding / model）。

pub mod error;
pub mod order;
pub mod port;
pub mod protocol;
pub mod vector;
