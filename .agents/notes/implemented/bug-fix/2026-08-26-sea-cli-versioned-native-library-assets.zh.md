# Agent Note: SEA CLI 可执行文件冻结带版本号的本地共享库

Status: implemented

[English](2026-08-26-sea-cli-versioned-native-library-assets.md) | 中文

## 问题

由 `scripts/build-exe-cli.ts` 构建的打包 CLI 可执行文件在插件导入阶段启动 web profile 时失败：

```text
failed to import loader entry attachment-local (@deepseek-ai/dsh-attachment-local): Could not load the "sharp" module using the linux-x64 runtime
ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file: No such file or directory
```

资产 glob 列表把 `node_modules/**/*.so` 冻结进 SEA 快照，但 sharp 自带的 libvips 以带版本号的 soname（`libvips-cpp.so.8.18.3`）发布，不匹配 `*.so`，因此这 18 MB 的库没有进入冻结 blob。

该故障之所以在首次使用时才暴露而不是构建期，源于 pkg 加载原生 addon 的方式：其 dlopen patch 会把 `.node` 文件所属 scope 目录从快照虚拟文件系统复制到 `~/.cache/pkg/<sha256(.node)>/`，而这次复制只能物化冻结 blob 中已存在的文件。缺失的依赖于是表现为 addon 首次加载时的普通 dlopen 错误，构建期没有任何指向它的诊断信息。

## 决策

`scripts/build-exe-cli.ts` 以三种 glob 形式冻结原生共享库：`node_modules/**/*.so`、用于 `libvips-cpp.so.8.18.3` 这类带版本号 soname 的 `node_modules/**/*.so.*`，以及用于 macOS 的 `node_modules/**/*.dylib`。`.node` 文件自带的 RPATH（`$ORIGIN/../../sharp-libvips-linux-x64/lib`）在解出的 scope 目录内即可解析，运行时不需要任何加载器环境变量。

## 验证

对 `dist-exe/cli-staging/node_modules` 做 staging glob 干跑：`node_modules/**/*.so.*` 恰好匹配一个文件——`@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3`；`node_modules/**/*.so` 无匹配。重建后的可执行文件（208 MB，此前为 191 MB）启动时零 dlopen 错误：web profile 在全新 `DSH_HOME` 下通过 HTTP 提供 index 页与带哈希的 CSS 资产，headless 启动到达凭据解析阶段。LLM 路径复测需要 `DEEPSEEK_API_KEY`，不在无密钥冒烟测试范围内。

## 备选方案

**只保留 `node_modules/**/*.so`。** 否决：带版本号的 soname 不以 `.so` 结尾；该模式在 staging 树中匹配零个文件，而 sharp 的 libvips——它依赖的唯一原生共享库——未被冻结，这正是本缺陷的成因。

**为 `@img/sharp-libvips-*` 枚举按包的 glob。** 否决：这会把构建脚本钉死在一个包的布局上；之后任何以带版本号 soname 发布的新原生依赖都会再次被静默漏掉。三种平台通用形式覆盖 Linux 与 macOS 约定，无需每加一个依赖就改一次脚本。

## 后果

可执行文件因 libvips 库从 191 MB 增至 208 MB；今后任何带版本号 soname 的原生依赖都会被自动冻结。新的共享库文件名形式（例如静态归档或平台特定名称）仍会在首次使用时而非构建期失败；届时扩展 `scripts/build-exe-cli.ts` 中的 glob 列表并重跑 staging 干跑即可。macOS 的 `.dylib` 模式仅按约定验证：linux-x64 staging 树中没有 dylib 可供检验，首个 macOS 构建必须在 darwin 主机上确认。
