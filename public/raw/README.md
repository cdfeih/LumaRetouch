# 本地 RAW 解码器与许可

本应用使用 `@colorhythm/libraw-wasm` **1.1.1** 包中的 LibRaw **0.22.1-Release**，在单独的 Web Worker 中解码传感器数据、去马赛克、应用相机拍摄白平衡并转为 **8bit sRGB PNG**。不上传 RAW，不用内嵌 JPEG 预览冒充完整解码，不代表 16bit／RAW 域全流程调色。LibRaw 转档色彩可能与相机 JPEG、相机 LUT 或厂商软件不同。

RAW 单张限制 80 MiB，解码后的图像仍限制为 4000 万像素。高像素合成 RAW、未支持的压缩模式和部分新机型可能不能导入；错误时保留其他照片，不自动降级为预览。取消或完成后终止 Worker，释放该次解码的完整 WASM 内存。手机大图仍需要真机验收。

## 来源与对应源码

- 包与源码：<https://github.com/colorhythm/libraw-wasm/tree/9b0f59a5e0f6d3d12a8f6fa594015ef4f30a6e95/packages/libraw.wasm>。
- 该版本固定的 LibRaw 子模块：<https://github.com/LibRaw/LibRaw/tree/b860248a89d9082b8e0a1e202e516f46af9adb29>。
- 完整对应 LibRaw 源码随应用提供：[LibRaw-b860248a-source.tar.gz](LibRaw-b860248a-source.tar.gz)，SHA-256：`f5da1e522ea195b54b30f3ff105ef2193daa04ea165dea825b4d6fe9d886395b`。未经修改；Wrapper 的构建脚本及绑定源码见上述固定提交。
- WASM 通过 Vite 资源管线从依赖包原样复制；不通过 CDN 加载、不使用 SharedArrayBuffer／跨源隔离。

## 许可证

- TypeScript／WASM 绑定：MIT，[许可证原文](LICENSE-wrapper-MIT.txt)。
- 绑定依赖 `typed-cstruct`：MIT，[许可证原文](LICENSE-typed-cstruct.txt)。
- LibRaw：提供 LGPL 2.1 / CDDL 1.0 双许可，本应用选择按 **CDDL 1.0** 分发独立的解码器。保留 [CDDL 原文](LICENSE-LibRaw-CDDL.txt)、[上游版权与第三方声明](COPYRIGHT-LibRaw.txt)，并一并保留 [LGPL 原文](LICENSE-LibRaw-LGPL.txt)。主应用的许可证不由这些独立组件替代。

## 公开验收样片

测试使用 raw.pixls.us 发布的 CC0 Panasonic DC-S9 24MP RW2（2025-04-27，编号 7702），不包含用户私照，也不把测试 RAW 放进安装包。来源：<https://raw.pixls.us/>；文件：<https://raw.pixls.us/getfile.php/7702/nice/Panasonic%20-%20DC-S9%20-%203:2.RW2>，SHA-256：`290ad5b4e396cb241a59459b2613d2b0659a03ff654e5d5368b3376d35812e50`。

支持列表包含 DC-S9 不等于该机所有固件、拍摄模式和像素合成模式都已通过验收。
