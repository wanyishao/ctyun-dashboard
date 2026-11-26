# 🖥️ 云电脑多账号管理与保活面板

> 本项目源自 [muyicn/ctyun-dashboard](https://github.com/muyicn/ctyun-dashboard)。版本变更记录请参阅 [CHANGELOG.md](./CHANGELOG.md)。

一款基于原生协议的多平台云电脑管理与保活控制台，无需无头浏览器，资源占用低，支持统一管理以下平台：

- **天翼云电脑（CtYun）**
- **天翼星辰云电脑（TeleAgent）**
- **中国移动云电脑 · 移动爱家（YDPc）**
- **中国移动云电脑 · 移动公众（ECloud）**

> 依赖说明：天翼云、天翼星辰与移动爱家均为纯 Node.js 实现；移动公众侧车依赖 Python 3（Docker 镜像已内置全部运行环境）。

---

## 🌟 主要功能

- **多平台统一纳管**：单账号多主机独立控制，支持按主机配置保活开关、任务开关与独立保活周期。
- **多种登录方式**：支持天翼云、天翼星辰官方扫码登录与账密登录，支持 30 天免登录；账号凭据与会话使用 AES-256-GCM 加密本地持久化。
- **自动保活与开机守护**：
  - 天翼云采用 WebSocket 脉冲保活，支持休眠唤醒、关机自动拉起及自愈统计；
  - 天翼星辰支持多实例并发心跳保活与自动拉起；
  - 移动爱家与移动公众支持原生协议保活及远程电源管理。
- **任务自动化与定时调度**：支持天翼云每日签到、AI 对话、挂机 1 小时与积分兑换，支持天翼星辰每日登录积分签到；提供全局定时、分项 Cron 及单机/单账号自定义 Cron 规则。
- **网页直达与电源管理**：支持在面板直接打开云电脑网页桌面，集中提供开机、唤醒、重启、关机等电源操作。
- **多渠道消息通知**：支持 Discord Webhook、企业微信、钉钉（含加签）、飞书、Bark、Server酱、PushPlus、Telegram 与自定义 Webhook，支持自定义消息模板与多用户独立推送配置。
- **实时日志与多用户隔离**：支持按平台与类型筛选日志、关键字搜索、清屏与磁盘容量控制；支持管理员与普通用户权限及配额隔离。

---

## 🚀 部署方式

默认服务端口为 **`8571`**，公开镜像位于 **`ghcr.io/wanyishao/ctyun-dashboard:latest`**，兼容 **`linux/amd64`** 与 **`linux/arm64`** 架构。

### 方式一：Docker Compose（推荐）

创建 `docker-compose.yml`（或直接使用仓库根目录的 `docker-compose.yml`）：

```yaml
services:
  ctyun-dashboard:
    image: ghcr.io/wanyishao/ctyun-dashboard:latest
    container_name: ctyun-dashboard
    restart: unless-stopped
    network_mode: "bridge"
    ports:
      - "127.0.0.1:8571:8571"
    environment:
      - TZ=Asia/Shanghai
      - PORT=8571
      - CTYUN_DATA_DIR=/app/data
      - CTYUN_INSTANCE_NAME=ctyun-dashboard
    volumes:
      - ./data:/app/data
```

启动服务：

```bash
docker compose up -d
```

默认仅监听 `127.0.0.1:8571`（适合配合反向代理访问）；如需局域网或公网直连，将 `ports` 改为 `"8571:8571"` 即可。部署多实例时，修改 `container_name`、`ports`、`CTYUN_INSTANCE_NAME` 与挂载目录即可隔离运行。

### 方式二：Docker CLI

```bash
docker run -d \
  --name ctyun-dashboard \
  --network bridge \
  -p 127.0.0.1:8571:8571 \
  -e TZ=Asia/Shanghai \
  -e PORT=8571 \
  -e CTYUN_DATA_DIR=/app/data \
  -e CTYUN_INSTANCE_NAME=ctyun-dashboard \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ghcr.io/wanyishao/ctyun-dashboard:latest
```

### 方式三：源码运行或本地构建（Node.js >= 18，推荐 22）

```bash
git clone https://github.com/wanyishao/ctyun-dashboard.git
cd ctyun-dashboard

# 直接使用 Node.js 运行
npm install --omit=dev
node server.js

# 或本地构建 Docker 镜像
docker build -t ctyun-dashboard:latest .
```

Windows 环境可直接运行 `start_dashboard.bat`。

### 移动公众可选配置覆盖

移动公众已内置公开签名常量（`app/ecloud_engine/public_credentials.json`），默认开箱即用。如需覆盖，按优先级 `环境变量 > 覆盖文件 > 内置常量` 配置：

- **覆盖文件**：挂载至 `/app/data/ecloud_credentials.json`（源码直跑为 `app/ecloud_engine/credentials.json`），结构参见 `app/ecloud_engine/credentials.example.json`；
- **环境变量**：`ECLOUD_ACCESS_KEY`、`ECLOUD_SECRET_KEY`、`ECLOUD_RSA_PUBLIC_PEM`、`ECLOUD_RSA_PRIVATE_PEM`。

---

## 🔑 初始登录信息

- **访问地址**：`http://127.0.0.1:8571`
- **默认管理员账号**：`admin`
- **默认初始密码**：`admin123`

*(首次登录后请及时修改密码)*

---

## 📁 项目结构

```text
ctyun-dashboard/
├── server.js                  # HTTP/SSE 服务、天翼云原生驱动、API 路由与认证通知
├── app/
│   ├── auth_manager.js        # 多用户会话、密码哈希与个人通知设置
│   ├── ctyun_encryption.js    # 天翼云 REDQ 加解密模块
│   ├── persist_log.js         # JSONL 持久化日志
│   ├── teleagent/             # 天翼星辰协议与保活/签到模块
│   ├── ydpc/                  # 移动爱家原生驱动 (SOHO / CAG / SCG / MQTT)
│   ├── ecloud/                # 移动公众驱动与侧车管理
│   ├── ecloud_engine/         # 移动公众 Python 侧车
│   ├── tasks/                 # 任务自动化与定时调度器
│   └── static/                # 前端静态页面资源
├── tests/                     # 语法检查与回归测试
├── CHANGELOG.md               # 更新日志
├── Dockerfile
└── docker-compose.yml
```

---

## 📜 致谢与免责声明

- 本项目源自 [muyicn/ctyun-dashboard](https://github.com/muyicn/ctyun-dashboard)，并参考借鉴了 `ecloud-cmsszte-alive`、`leleji/CtYun` 等开源项目。
- 本项目仅供技术研究、学习交流与个人自动化运维使用，请遵守各云电脑平台的服务条款与使用规范。
