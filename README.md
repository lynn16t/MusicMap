# MusicMap · 世界音乐地图

> 一张由数十万张真实专辑封面拼成的世界，一条贯穿创作者一生的时间轴。
> **剥离算法推荐，回到"专辑"这个单位，看世界到底在创作什么。**

按国家与时间维度可视化全球专辑发行的交互式数据故事（scrollytelling）。
灵感来源：MIT Rui《世界动画地图》× Radiooo 复古电台播放器。

---

## 一、题目

**MusicMap —— 基于全球专辑发行数据的世界音乐地图与创作时间轴可视化**

以 2011–2025 年全球专辑发行数据为对象，用真实专辑封面作为可视化的最小视觉单元，构建一个从"空间分布"到"时间积累"再到"创作者生命周期"的多尺度交互可视化作品。

---

## 二、选题背景

这十几年的音乐产业，是一场"拥有"与"享用"的此消彼长。

过去我们"拥有"音乐——买一张唱片、一张黑胶，把一整张专辑捧在手里听完；如今我们更多是"享用"音乐——一个订阅、一份歌单，随取随放。这场从"拥有"到"享用"的转变，同时改写了两端的人：

- 对**听众**，是从收藏一张专辑，变成在流媒体里滑过一首首单曲；
- 对**创作者**，是从认真做完一整张专辑，变成刻意打磨出彩的 30 秒片段去迎合算法。

而"专辑"正好站在这场转变的正中央——它是"拥有"时代的产物，也是创作者愿意一次说完一整段话、完整表达自己的那个单位。正因如此，在这个奖励单曲、奖励碎片的时代，一张专辑反而成了"还有人在认真创作"的信号。

所以本作品**不看播放量、不看热单榜，而是回到"专辑"这个单位**，提出三个递进的问题：

1. **广度**：在全球范围内，到底是谁在大量创作？欧美榜单之外，世界在做什么？
2. **积累**：在流媒体时代，这十几年里专辑是如何一年年积累、又为何先涨后跌？
3. **生命周期**：对一个创作者而言，什么年龄最想、也最能做出一张专辑？

我们想表达的核心是：**对创作者而言，年龄不是被消耗的时间，而是越积越厚的财富——广度让创作贯穿一生，深度让每个年龄都不可替代。**

---

## 三、作品功能

作品是一条由滚动驱动的可视化叙事主线，共五个场景：

| 场景 | 名称 | 功能 |
|---|---|---|
| Scene 1 | **Hero / 开篇** | 封面流入动画引入主题，建立"专辑封面=最小视觉单元"的视觉语言 |
| Scene 2 | **MAP · 全球流行专辑动态地图** | three.js 三维地球。每个国家由成千上万张真实专辑封面拼贴而成；拉远看到各国"色彩气质"，放大看清每一张封面；封面随发行年份动态更新，更新速率即创作速率。点击任意封面弹出专辑信息（Spotify 风格弹窗） |
| Scene 3 | **ALBUMS / YEAR · 创作总量** | 把 2011–2025 划分为五个三年区块，封面在区块内纵向堆叠，堆得越高代表该阶段发行规模越大，一眼比出体量与"先涨后跌"的趋势 |
| Scene 4 | **YEAR SWITCH · 创作者与时代的拉扯** | 横向滚动沿时间轴漫游，每个时间段浮现属于那个时期的注脚，呈现产量起伏背后的时代背景 |
| Scene 5 | **ALBUMS / AGE · 创作年龄** | 把横轴从"公历年"换成"艺人发行该专辑时的年龄"。上层按年龄区间排布封面，下层是对应艺人头像点位，上下联动高亮，揭示创作的黄金年龄带与终生创作现象 |

**核心交互特性：**

- 🌍 **几十万张封面满帧渲染** —— 全球 223 国、约 48.9 万张真实封面在三维地球上带动画呈现，实测可达 90+ FPS。
- 🎬 **时间轴动画引擎** —— "封面出现年份 ≈ 专辑发行年份"，按各国累计发行曲线驱动封面点亮与替换。
- 🖱️ **点击探索** —— 点击地球上任意封面，识别最近的已点亮专辑并弹出标题/艺人信息。
- 🎚️ **拖拽/点击分离** —— 位移 > 6px 判为旋转地球，避免误触发搜索。
- ⚡ **关机后秒开** —— 预烤图集方案让前端只需下载约 190MB 成品而非逐张拉取 ~24GB 原图。

---

## 四、技术路线

### 0. 数据流总览

```
MusicBrainz（专辑元数据）            Cover Art Archive（CAA，封面图源）
        │                                       │
        ▼  ETL                                   ▼  ETL 按 mbid 下载 640² JPEG
  PostGIS app.albums  ◄──────────────────►  MinIO  musicmap-covers/{mbid[:2]}/{mbid}.jpg
  (mbid/标题/艺人/年份/国家/cover_status)
        │
        │  app.countries（矢量国界） / app.country_grids（每国网格坑位）
        ▼
  FastAPI 后端  ──JSON/JPEG──►  前端 three.js 地球
        ▲                              │
        └─── bake_atlas.py 预烤 8 张图集 ┘（一次性，全局共用）
```

### 1. 数据来源

- **专辑身份 = MusicBrainz mbid**。`app.albums` 存元数据：`mbid / title / primary_artist_name / release_year / artist_country_iso / cover_status`。只取 **2011–2025**、有国家、`cover_status='downloaded'` 的记录；港澳台并入 `CN`。
- **封面图源 = Cover Art Archive（CAA）**。ETL 阶段按 mbid 从 CAA 下载 640×640 JPEG 封面，存入 **MinIO** 对象存储，key = `{mbid[:2]}/{mbid}.jpg`。当前已下载约 **48.9 万张 / 223 国**。
- **地理底图 = PostGIS**：`app.countries`（真实国界 MultiPolygon + 质心/大洲/面积）、`app.country_grids`（每国铺设的网格格子，即"封面能冒出来的坑位"，约 5–6 万个）。

### 2. 后端接口（FastAPI，`backend/app/main.py`）

| 接口 | 作用 |
|---|---|
| `/api/countries/geojson` | 矢量国界（简化压体积）+ 质心/大洲/面积 + 各国封面数 |
| `/api/grids/centroids` | 每个网格格子的中心点（封面坑位），按 iso 分组 |
| `/api/timeline/albums?per=N` | 动画数据：`counts`（每年每国发行数，定节奏）+ `pool`（候选专辑）。`per=0` 为全量 |
| `/api/album/{mbid}` | 单条专辑标题/艺人（点击封面时取） |
| `/api/covers/{mbid}` | 从 MinIO 流式返回封面 JPEG（immutable 长缓存） |
| `/api/atlas/manifest.json`、`/api/atlas/{g}.jpg` | 预烤图集清单 + 图集图 |

### 3. 前端渲染管线（three.js，`frontend/src/components/MapGlobe3D.tsx`）

- **底图**（全 GPU）：海洋为青绿色球体；**陆地/国界**把 `app.countries` 多边形画进 8192×4096 的 equirectangular canvas（粉白填充 + 浅粉辉光描边），贴到与经纬严格对齐的 UV 球；外加边缘 fresnel 白辉光、星空、CSS2D 大洲/国家标注（背面半球自动隐藏）。
- **封面 = InstancedMesh + 自定义 billboard ShaderMaterial**：每个网格坑位一个 instance，实例属性 `iPos/iUV/iBorn/iAtlas` + uniform `uTime` → 出现/缩放/替换动画**全在 GPU 顶点着色器里算**，运行期 CPU 只改少量属性、零重排。
- **点击 = raycaster** 打到地球 → 找最近的已点亮封面 → 取元数据 → Spotify 弹窗。

### 4. 怎么撑住"同时几十万张封面"（核心难点）

单纯把每张封面当一个贴图节点（maplibre 的 `addImage` 路线）会因每加一张就触发图层重排，直接掉到 14fps。这里靠四层叠起来：

1. **GPU 实例化 + 纹理图集**：所有封面共用**一个 mesh、一次 draw call**；封面像素预先拼进大图集，运行期只改 instance 的 UV/出现时间。原型实测 10 万张带动画 **92fps**。
2. **多图集突破单纹理上限**：WebGL 单纹理最大 16384²。封面 32px、一张 8192² 图集装 256×256 = **65536 张**，挂 **8 张图集** = 52.4 万容量，装下全部 48.9 万；着色器按 `iAtlas` 选 `uA0..uA7` 采样。
3. **预烤图集（关机后秒开）**：把"拼图"从浏览器搬到后端跑一次（`bake_atlas.py`），前端只下 **8 张图 + manifest ≈ 190MB**，而非逐张拉 48.9 万原图（~24GB）。首屏快、且重启后浏览器缓存命中即秒开。
4. **增量上传防黑屏**：8 张共 2GB 纹理若一帧内全灌显存，单次 GPU 上传超 2s 会触发 Windows TDR 丢上下文导致永久黑屏。改为**每张加载完立刻 `initTexture` 单独上传 + 帧间让出**。

> 显存：8 × 8192²×4B ≈ **2GB**（+ 陆地纹理 ~0.18GB），与是否预烤无关（JPEG 只省下载/磁盘，上 GPU 都解成未压缩 RGBA）。

### 5. 时间轴动画引擎（`step()`）

- 按 `counts` 算每国**累计发行曲线（prefix 前缀和）**，进度 `t`（0→1 映射 2011→2025）决定每国此刻该点亮多少封面 → "出现年份 ≈ 专辑年份"。
- 坑位环形复用：`cells[app % cap]`，新封面替换最老的；封面从对应国家/年份的 pool 里 `pop` 出来。
- **限速**：每国每帧翻面数 ≤ `cap·dt/0.65s` → 每个坑位约 0.65s 才翻一次，专辑多的国家（GB/JP）稳定 churn 而非"没冒出来就被覆盖"。
- **加密**：专辑越多的国家，在每个原始格子周围补抖动坑位，让密集国家铺更多封面。

### 6. 技术选型理由

- **maplibre**：符号渲染动态 `addImage` 触发重排 → 14fps，且 globe 投影下符号层有限制 → 弃用。
- **deck.gl**：`IconLayer` 在 globe 投影下不渲染（只有 Scatterplot 能用）→ 不满足封面需求。
- **three.js**：对 GPU billboard / 着色器 / 纹理完全可控，才能做到"几十万张带动画满帧 + 自定义出现/替换"。底图精度无所谓，自绘矢量球即可。

---

## 五、技术栈

| 层 | 技术 |
|---|---|
| 前端 | React + TypeScript + Vite、three.js、CSS2DRenderer、scrollytelling |
| 后端 | Python + FastAPI + Uvicorn |
| 数据库 | PostgreSQL / PostGIS |
| 对象存储 | MinIO（S3 兼容） |
| 数据源 | MusicBrainz、Cover Art Archive、Spotify Web API |
| 部署 | Docker / docker-compose |

---

## 六、项目结构

```
MusicMap/
├── frontend/                # React + three.js 前端
│   └── src/
│       ├── App.tsx                       # 应用入口与场景编排
│       ├── ScrollStory.tsx               # 滚动叙事主线
│       ├── components/
│       │   ├── MapGlobe3D.tsx            # three.js 三维封面地球（核心）
│       │   ├── MapScene.tsx              # 地图场景容器
│       │   ├── EsriTimeline.tsx          # 时间轴
│       │   ├── PlayerBar.tsx             # Radiooo 风格播放器
│       │   └── SpotifyPopup.tsx          # 点击专辑弹窗
│       ├── hooks/useTimeline.ts          # 时间轴动画 hook
│       └── spotifyApi.ts                 # Spotify 接口封装
├── backend/                 # FastAPI 后端
│   └── app/
│       ├── main.py                       # API 路由
│       └── bake_atlas.py                 # 预烤图集脚本
├── etl/                     # 数据采集与入库（MusicBrainz / CAA）
├── docker/                  # Docker 相关配置
├── docker-compose.yml       # 一键编排 PostGIS / MinIO / 后端
└── .env.example             # 环境变量模板
```

> 注：原始数据（`data/`，约 32GB）、预烤图集（`backend/app/_atlas/`，约 190MB）、`node_modules`、演示视频/PPT 等大文件已在 `.gitignore` 中排除，不随仓库分发；图集可由 `bake_atlas.py` 重新生成。

---

## 七、本地运行

### 1. 准备环境变量

```bash
cp .env.example .env
# 按需填写数据库 / MinIO / Spotify 等配置
```

### 2. 启动后端依赖（Docker）

```bash
docker compose up -d        # PostGIS、MinIO、FastAPI 后端
```

### 3. 预烤图集（首次或封面库更新后）

```bash
docker exec musicmap-backend python -m app.bake_atlas
# 冒烟测试可加 BAKE_LIMIT=N 小样
```

### 4. 启动前端

```bash
cd frontend
npm install
npm run dev
# 打开 http://localhost:5173/
```

---

## 八、小结

MusicMap 用"专辑"这一最小单位，把"全球创作的广度"与"创作者一生的深度"放进同一条可交互的可视化叙事里：

- 用 **GPU 实例化 + 多纹理图集 + 预烤** 解决了"几十万张封面带动画满帧渲染"的工程难题；
- 用 **MusicBrainz × Cover Art Archive × PostGIS × MinIO** 的数据管线，把真实发行数据变成可探索的视觉对象；
- 用 **MAP → YEAR → AGE** 的递进叙事，回答了"谁在创作、如何积累、何时创作"三个问题。

> 灵感与致谢：MIT Rui《世界动画地图》、Radiooo 复古电台。数据来源 MusicBrainz / Cover Art Archive，遵循其各自的开放数据许可。
