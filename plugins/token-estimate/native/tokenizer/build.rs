// napi 原生扩展的构建脚本：`napi-build` 负责按平台补链接参数（macOS 动态符号查找等）。
fn main() {
    napi_build::setup();
}
