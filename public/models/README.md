# 本地人像模型与运行时

本目录随网页、Windows 与 Android 构建一起分发。人像检测仅在设备上定位人脸与面部关键点，不上传照片，不做人脸身份识别，不推断年龄或性别。首次点击人像精修时从当前应用地址加载模型。

## 来源与版本

- `face_landmarker.task`：Google MediaPipe Face Landmarker，float16，固定版本 `1`。[官方模型下载](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task)，[官方使用文档](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker)。输出每张脸的 478 个关键点。
- `vision_wasm_nosimd_internal.js` 与 `.wasm`：官方 npm 包 `@mediapipe/tasks-vision`，固定版本 `1.1.1`。使用无 SIMD 的 CPU 运行时，兼容更多移动设备；仅保留运行需要的两个文件。
- 模型及 MediaPipe 代码按 Apache License 2.0 分发。许可证原文见 `LICENSE-mediapipe.txt`；[Face Mesh V2 模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)列明模型许可。

这些文件保持上游原始内容，未修改。更换 npm 包版本时，应同步复制对应运行时并重新验证浏览器、Electron 与移动端。

## SHA-256

| 文件 | SHA-256 |
| --- | --- |
| face_landmarker.task | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| vision_wasm_nosimd_internal.js | `942654dbdcebce08ea039af23d18e58bebf23c8607d74023d2df7071c8a7b638` |
| vision_wasm_nosimd_internal.wasm | `c9b1b69bb87baf9e529254d8559dcbcf4c5a9c0eda84f56a12f17d675335ec9c` |

## 范围与限制

检测最多 10 张脸，按画面从左到右编号。皮肤蒙版由面部轮廓关键点构造，并避开眼睛、眉毛与嘴唇；它不是完整人体或语义皮肤分割。小脸、侧脸、遮挡、极端光线可能漏检；找不到人脸时返回空列表，不回退成全图修饰。人物手臂、腰部和身体塑形不属于这个模型的功能。
