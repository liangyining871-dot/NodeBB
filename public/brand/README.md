# AIXSILICON 广场站点标识

当前顶部使用 `huawei-emblem-transparent.png`，仅保留红色图案，透明背景。
`huawei-logo-transparent.png` 保留红色图案和下方 HUAWEI 英文，供其他位置使用。
两者均经内置 image_gen 编辑得到，去除白色背景及外围留白。

NodeBB 站点配置：

- `brand:logo=/assets/brand/huawei-emblem-transparent.png`
- `brand:logo:alt=HUAWEI`
- `showSiteTitle=1`
- `title=AIXSILICON广场`

Harmony 原生品牌栏将 Logo 放在站点标题左侧，图片最大高度为 48px。
素材位于项目 `public/brand`，可提交并随镜像发布。新数据库部署时需应用上述品牌配置；
现有数据库会保留这些配置。无需改动主题模板或 OAuth 插件。

最终编辑提示词（内置 image_gen 模式）：

> Edit target: existing transparent Huawei logo PNG. Remove ONLY the entire black HUAWEI wordmark below the red emblem. Preserve the existing eight-petal red flower emblem exactly, including geometry, red/orange gradients and white/transparent gaps. No text whatsoever. Crop tightly around the red emblem with 3% transparent padding on all sides. Genuine transparent alpha background, no white rectangle, no shadow or added objects. This is a header icon next to the text AIXSILICON广场; do not render that site text into the image.

带英文版本的编辑提示词：

> Use case: background-extraction. Edit target: the user's last attached Huawei logo image. Extract ONLY the exact existing red Huawei flower emblem and the black HUAWEI wordmark underneath. Preserve original petal geometry, red/orange gradients, black letter shapes, proportions, spelling and emblem-above-wordmark arrangement. Remove the entire white background to genuine transparent alpha, including spaces between petals and around letters. Crop canvas tightly to the emblem and wordmark together, with only 3% transparent padding. No white rectangle, no shadow, no invented design, no extra text. Output a clean transparent PNG asset for a small website header logo; keep edges crisp and avoid excessive empty canvas.
