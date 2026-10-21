# 本地人像模型与运行时

本目录随网页、Windows 与 Android 构建一起分发。人像检测仅在设备上定位人脸、身体关键点与人体轮廓，不上传照片，不做人脸身份识别，不推断年龄或性别。首次点击人像精修时从当前应用地址加载模型。

## 来源与版本

- `face_landmarker.task`：Google MediaPipe Face Landmarker，float16，固定版本 `1`。[官方模型下载](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task)，[官方使用文档](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker)。输出每张脸的 478 个关键点。
- `pose_landmarker_lite.task`：Google MediaPipe Pose Landmarker Lite，float16，固定版本 `1`。[官方模型下载](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task)，[官方 Web 使用文档](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)。每个人输出 33 个身体关键点与独立的人体概率蒙版；以 CPU、IMAGE 模式运行，`numPoses: 10`、`outputSegmentationMasks: true`。
- `selfie_multiclass_256x256.tflite`：Google MediaPipe SelfieMulticlass，float32，固定版本 `1`。[官方模型下载](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite)，[官方分割任务文档](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)。六类分别是背景、头发、身体皮肤、面部皮肤、衣物、其他饰物；本应用只取有足够置信度与类别差距的面部皮肤，与关键点范围取交集，不扩大脸部修饰范围。代码及权重均按 Apache 2.0 分发，官方模型卡原件见 `Model-Card-Multiclass-Segmentation.pdf`，固定版本、散列与归属见 `NOTICE-selfie-multiclass.txt`。
- `vision_wasm_nosimd_internal.js` 与 `.wasm`：官方 npm 包 `@mediapipe/tasks-vision`，固定版本 `1.1.1`。使用无 SIMD 的 CPU 运行时，兼容更多移动设备；仅保留运行需要的两个文件。
- 模型及 MediaPipe 代码按 Apache License 2.0 分发。许可证原文见 `LICENSE-mediapipe.txt`；[Face Mesh V2 模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)与 [BlazePose GHUM 3D 模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf)列明模型许可。

本目录的模型和 JS/WASM 运行时文件保持上游原始字节，未修改。更换 npm 包版本时，应同步复制对应运行时并重新验证浏览器、Electron 与移动端。

## SDK JavaScript 的本地适配

npm 包 `@mediapipe/tasks-vision` 1.1.1 的 `vision_bundle.mjs/cjs` 默认会创建定时使用统计记录器，运行一段时间后可能请求 Google 日志接口。`native/local-vision.ts` 在 Vite 开发服务和生产构建中移除该版本唯一的记录器初始化调用，使人像识别保持本机处理；正常关键点推理、蒙版和资源释放流程仍沿用 SDK。它不修改 `node_modules` 文件、本目录的模型或 JS/WASM，也不拦截应用的全局网络请求。生产打包时未使用的日志实现可由构建器移除。

开发依赖预打包排除该 SDK，保证开发版同样经过适配。版本必须为 `1.1.1`，且两个原始入口各包含恰好一处已审查的初始化代码；版本、入口结构不符或生产变换未执行时直接报错，避免升级后静默重新启用。升级 SDK 时需要重新检查该适配并验证浏览器与 Electron 运行超过日志定时周期后仍无外部请求。针对性测试：`node --experimental-strip-types --test native/local-vision.test.ts`。

## SHA-256

| 文件 | SHA-256 |
| --- | --- |
| face_landmarker.task | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| pose_landmarker_lite.task | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| selfie_multiclass_256x256.tflite | `c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0` |
| vision_wasm_nosimd_internal.js | `942654dbdcebce08ea039af23d18e58bebf23c8607d74023d2df7071c8a7b638` |
| vision_wasm_nosimd_internal.wasm | `c9b1b69bb87baf9e529254d8559dcbcf4c5a9c0eda84f56a12f17d675335ec9c` |

## 范围与限制

人脸检测最多 10 张脸，按画面从左到右编号。每张脸从原片独立取带上下文的工作裁块，最长边 1600；小于此尺寸的裁块保留原像素，不随整张照片缩小。修饰差值再加回原尺寸基准，不能从模糊原片恢复真实毛孔。几何皮肤范围避开眼睛、眉毛与嘴唇，再与六类分割的高置信面部皮肤交集；头发、衣物、饰物及不确定部分保守排除。重叠脸部轮廓缺少可靠前后关系时，其重叠处不做皮肤修饰。归零时不做分割推理，从固定底图恢复已有修饰。

分割模型不是瑕疵、皱纹或毛孔修复模型，也不能保证识别所有眼镜、胡须、手部遮挡和浓妆；几何五官与人工红色保护区继续优先。官方模型卡的主要场景是人像／自拍，远距离小脸、极端角度与光线应人工复核。模型缺失或推理异常时保留当前照片并报错，不静默改成整脸修饰；低置信区域可能几乎不改变。解析后的测试用纯色、人工关键点合成图可显式关闭语义门控，以独立验证差值合成，产品默认不关闭。

身体检测最多 10 人；仅保留身体存在置信度达标、关键点和人体蒙版完整的结果。每项塑形另检查对应关节的可见度，出框、遮挡或低置信度的肢体不启用该项。人体蒙版是身体轮廓概率，不代表裸露皮肤，也不能判断衣物、年龄、性别或身份。远距离小人物、多人重叠、复杂姿态、宽松衣物可能漏检或定位不准，需要用户检查预览。旧版 BlazePose 模型卡主要评估单人场景；当前 Tasks API 可返回多个人物，仍不保证所有合照都能完整识别。人脸与身体只按鼻眼的画面位置匹配，不能可靠匹配时分别保留检测结果。同步检测结果复制出单通道蒙版后调用 `close()`，释放 MediaPipe 的蒙版资源。
