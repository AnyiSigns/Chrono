@echo off
rem 端到端测试夹具：cargo 空操作替身。
rem 原生构建（如 context-window 的 tokenizer）由夹具预置的产物满足，e2e 不触发真实编译。
echo [chrono-e2e] cargo stub: skip cargo %* 1>&2
exit /b 0
