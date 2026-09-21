# Beszel Infrastructure Runbook

Runbook cho hạ tầng riêng tư gồm Beszel, heartbeat Cloudflare và UptimeFlare.

## Trạng thái hiện tại

Beszel đã triển khai trên VPS hiện hữu tại `/opt/beszel`:

- Dashboard: `https://beszel.tuannguyenviet.site`
- Hub + Agent: healthy, image `0.20.0`
- System: `Main VPS`, Unix socket, status `up`
- Heartbeat Worker/D1: source và workflow đã sẵn sàng nhưng chưa deploy vì Cloudflare token được cung cấp thiếu quyền ghi D1/Workers.
- UptimeFlare repo private đã tạo; config gồm app monitors + hai heartbeat monitor trên `beszel-heartbeat.nguyenviettuanbp.workers.dev`, chờ Worker tồn tại.
- Token đã lộ trong chat, cần revoke thủ công rồi tạo token mới.

Workspace chứa source/deployment template. UptimeFlare vẫn phải tạo ở repository riêng từ official template. Máy local không có Docker; Worker test và Wrangler dry-run đã chạy.

## Kiến trúc đã duyệt

- Repository này (`tuan-beszel`) là private infrastructure repo.
- Không fork Beszel. Dùng image chính thức, ghim cùng version `0.20.0`:
  - `henrygd/beszel:0.20.0`
  - `henrygd/beszel-agent:0.20.0`
- UptimeFlare nằm ở repository riêng (`tuan-uptimeflare`), tạo từ official template. Chỉ cấu hình monitor; không sửa core template.
- Heartbeat là Cloudflare Worker + D1 độc lập, không dùng UptimeFlare D1.
- Beszel Hub và Agent chạy cùng VPS. Hub chỉ bind `127.0.0.1:8090`.
- Hub và Agent dùng Unix socket `/beszel_socket/beszel.sock`; không mở TCP `45876`.
- Heartbeat gửi mỗi `60s`; Worker coi dữ liệu stale sau `150s`.
- Cloudflare cron của UptimeFlare chạy mỗi phút. GitHub Actions chỉ deploy, không làm lịch heartbeat.

```text
Private repo tuan-beszel
  VPS: Beszel Hub + Agent
       | POST mỗi 60s
       v
  Heartbeat Worker + Heartbeat D1
       ^ GET /status/beszel-main/live
       ^ GET /status/beszel-main/systems
       |
Private repo tuan-uptimeflare
  UptimeFlare Worker cron mỗi phút + UptimeFlare D1 + Pages
```

## Prerequisites

- VPS Linux, kiến trúc `amd64` hoặc `arm64`, Docker Engine và Docker Compose plugin.
- User SSH có quyền triển khai; host key VPS đã xác minh. Không mở SSH mới cho GitHub Actions nếu đã có tuyến quản trị an toàn.
- Domain HTTPS cho heartbeat/status và các ứng dụng cần monitor; DNS/Cloudflare zone đã xác định.
- Cloudflare account có quyền tạo Worker, D1, secret và deploy; xác định Account ID thật.
- GitHub private repositories, protected `main`, Actions enabled, environment protection nếu cần.
- Kênh nhận alert đã được chọn. Không đặt webhook/token thật trong source.
- Xác nhận disk, backup destination ngoài VPS, cổng đang dùng và route SSH trước bootstrap.

## Cây local mục tiêu

```text
tuan-beszel/
  compose.yml
  .env.example
  .gitignore
  README.md
  scripts/deploy.sh
  heartbeat/
    package.json
    package-lock.json
    wrangler.jsonc
    src/index.js
    migrations/0001.sql
    test/heartbeat.test.js
  .github/workflows/
    ci.yml
    deploy-vps.yml
    deploy-heartbeat.yml
```

`deploy-heartbeat.yml` chạy migration D1 remote rồi deploy Worker. Cần tạo D1 thật, thay `database_id` placeholder trong `heartbeat/wrangler.jsonc`, rồi set `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID` trong GitHub Environment `production`.

`.env` chỉ tồn tại trên VPS hoặc máy quản trị đã bảo vệ, nằm trong `.gitignore`; không commit. `tuan-uptimeflare` là repository khác, không tạo file UptimeFlare trong repo này.

## Beszel trên VPS

Đặt stack tại `/opt/beszel`, tách khỏi stack ứng dụng khác. Compose phải giữ các contract sau:

- Hub image `henrygd/beszel:0.20.0`, volume dữ liệu persistent, `restart: unless-stopped`, log có giới hạn. Đã triển khai tại `/opt/beszel` trên VPS hiện hữu.
- Agent image `henrygd/beszel-agent:0.20.0`, `network_mode: host` theo hướng dẫn chính thức, volume dữ liệu cần thiết, `restart: unless-stopped`; system `Main VPS` hiện `up`.
- Shared socket mount vào cả hai container tại `/beszel_socket/beszel.sock`.
- Compose dùng healthcheck chính thức `/beszel health --url http://localhost:8090` và `/agent health`; deploy chờ cả hai healthy.
- Hub publish `127.0.0.1:8090:8090`, không publish dashboard ra Internet.
- Chỉ mount Docker socket khi cần Docker metrics. `:ro` không biến Docker API thành read-only; Agent vẫn là component có quyền nhạy cảm. Không dùng `privileged` hoặc mount host thừa.

### Bootstrap lần đầu

Thực hiện đúng thứ tự:

1. Tạo `/opt/beszel`, copy `compose.yml` và `.env.example` thành `.env`; điền `BESZEL_HUB_USER_EMAIL`/`BESZEL_HUB_USER_PASSWORD` bằng credentials bootstrap một lần, đặt quyền `chmod 600 .env`. Có thể để trống `BESZEL_AGENT_TOKEN`/`BESZEL_AGENT_KEY` khi bootstrap Hub; Agent sẽ chưa chạy cho tới khi Hub cấp credentials.
2. Khởi động **chỉ Hub** bằng service name thực tế trong Compose, ví dụ:

   ```bash
   cd /opt/beszel
   docker compose up -d beszel
   ```

3. Mở SSH tunnel, không mở port dashboard:

   ```bash
   ssh -N -T -L 8090:127.0.0.1:8090 <SSH_USER>@<VPS_HOST>
   ```

   Truy cập `http://127.0.0.1:8090` trên máy quản trị.

4. Nếu đã set cả `BESZEL_HUB_USER_EMAIL` và `BESZEL_HUB_USER_PASSWORD`, Beszel tự tạo admin ở lần khởi động đầu; sau khi xác nhận đăng nhập, xóa hai biến khỏi `.env`. Nếu không set, tạo admin qua giao diện.
5. Thêm system `Main VPS`. Chọn địa chỉ Agent Unix socket chính xác:

   ```text
   /beszel_socket/beszel.sock
   ```

6. Với Unix-socket/SSH mode, lấy `KEY` public từ Hub; `TOKEN` WebSocket không cần dùng. Không ghi key vào chat, commit, log hoặc URL công khai.
7. Điền key vào `.env` theo tên biến Compose/Agent:

   ```dotenv
   BESZEL_AGENT_TOKEN=
   BESZEL_AGENT_KEY="<Hub-public-key>"
   ```

   `HUB_URL` để trống trong SSH-only mode. Chỉ dùng `TOKEN` + `HUB_URL` khi cố ý chuyển sang WebSocket mode.

8. Khởi động Agent:

   ```bash
   docker compose up -d beszel-agent
   ```

9. Xác nhận host metrics, Docker metrics (nếu bật), socket connection và system state trong Hub. Chỉ bật heartbeat sau khi Agent đã ổn định.

Bootstrap tự động đã dùng `/api/beszel/create-user`, PocketBase records cho system/fingerprint và xóa hai biến bootstrap khỏi `.env` sau khi đăng nhập thành công. Không xóa `/opt/beszel/beszel_data`; đó là dữ liệu Hub. Không dùng `latest`, Watchtower hoặc auto-pull ngoài quy trình review.

## Heartbeat Worker + D1

Worker độc lập có một row policy cho `beszel-main`:

- `POST /push/<secret>`: xác thực secret trước body; secret sai trả `404`.
- Chỉ nhận JSON hợp lệ, giới hạn body thực đọc `16 KiB`; request lỗi không cập nhật `last_seen`.
- Dùng thời điểm Worker nhận request để tính freshness, không tin timestamp từ VPS.
- Dùng prepared statement upsert; chỉ trả thành công sau khi D1 ghi thành công.
- Không log secret, full URL hoặc payload.
- Endpoint status trả `Cache-Control: no-store`, không trả payload hệ thống.

Điều kiện:

| Endpoint | Trả `200` khi |
|---|---|
| `/status/beszel-main/live` | Heartbeat hợp lệ và tuổi `<= 150s` |
| `/status/beszel-main/systems` | Heartbeat còn mới, `total=1`, `up=1`, `down=paused=pending=0` |

Chưa có dữ liệu, stale, D1 lỗi hoặc system zero/pending/paused đều trả `503`. Response khỏe là `healthy`; response lỗi là `down`. `warn` do CPU/RAM cao không tự biến một Agent đang up thành DOWN.

### Tạo secret và D1 một lần

Sinh secret 256-bit bằng:

```bash
openssl rand -hex 32
```

Lưu output vào secret store của Worker; không đưa giá trị output vào README, Git, log hoặc frontend. Heartbeat URL trên VPS có dạng placeholder:

```dotenv
HEARTBEAT_URL=https://<HEARTBEAT_DOMAIN>/push/<HEARTBEAT_SECRET>
```

Thực hiện trong thư mục `heartbeat/`, sau khi đã có Cloudflare account và placeholder Account ID:

```bash
npx wrangler d1 create beszel-heartbeat
# Ghi database_id được trả về vào heartbeat/wrangler.jsonc.
npx wrangler d1 migrations apply beszel-heartbeat --remote
npx wrangler secret put PUSH_SECRET
npx wrangler deploy
```

`wrangler.jsonc` phải chứa `database_name` và `database_id` thật sau khi tạo. Dùng đúng binding name trong Worker. Migration production phải là migration tương thích ngược; không chạy nhầm local D1 thay cho `--remote`. `PUSH_SECRET` phải đúng 64 ký tự hex; không dùng secret rỗng/ngắn.

Heartbeat URL chỉ được cấu hình trên VPS/Beszel theo implementation thực tế. Nhịp gửi mục tiêu là `60s`; không thêm `gracePeriod` ở bản đầu. TTL `150s` đã bao gồm khoảng trễ cần thiết, nên stale thường được phát hiện khoảng `150-210s` sau heartbeat cuối, tùy jitter.

## UptimeFlare repository riêng

1. Tạo `tuan-uptimeflare` từ official UptimeFlare template; không fork Beszel và không copy core sang repo này.
2. Giữ deployment chính thức gồm Cloudflare Pages, Worker cron mỗi phút và UptimeFlare D1.
3. Chỉ sửa cấu hình monitor (`uptime.config.ts` hoặc file config tương ứng của template). Không thêm heartbeat bridge vào core.
4. Sync upstream thủ công ở bản đầu, review diff rồi deploy. Không tự sync hằng ngày vì upstream sync có thể ghi đè file custom.

Snippet monitor cần điền vào config UptimeFlare, thay `<HEARTBEAT_DOMAIN>` bằng domain thật:

```ts
{
  id: "beszel-main-live",
  name: "Main VPS Heartbeat",
  target: "https://<HEARTBEAT_DOMAIN>/status/beszel-main/live",
  method: "GET",
  expectedCodes: [200],
  timeout: 5000, // milliseconds
  responseKeyword: "healthy",
  // Không khai báo gracePeriod ở bản đầu.
},
{
  id: "beszel-main-systems",
  name: "Beszel Systems",
  target: "https://<HEARTBEAT_DOMAIN>/status/beszel-main/systems",
  method: "GET",
  expectedCodes: [200],
  timeout: 5000, // milliseconds
  responseKeyword: "healthy",
  // Không khai báo gracePeriod ở bản đầu.
},
```

- Chỉ thêm monitor ứng dụng có URL thật và endpoint đã xác minh; không tạo placeholder luôn DOWN. Monitor dùng `target`; `url` chỉ dành cho webhook notification.
- Public group chỉ hiển thị ứng dụng cần công khai. Việc ẩn monitor infrastructure khỏi group không bảo vệ dữ liệu: API UptimeFlare vẫn có thể trả trạng thái/data của monitor.
- Nếu cần hạn chế truy cập status page/group, bật password protection theo cơ chế của template. Password protection không thay thế việc giữ secret ngoài source.
- Không đưa heartbeat secret, Cloudflare token, webhook token hoặc credentials vào `uptime.config.ts`, frontend bundle, Actions log hoặc Worker log. Trong UptimeFlare, `target` là field monitor; `url` chỉ dùng cho webhook notification. Dùng upstream đã vá advisory `GHSA-36q9-v7p3-vj6v`; nếu từng chạy bản lỗi, rotate mọi credential.
- Bật alert DOWN/recovery cho app, heartbeat và systems. Resource alert từ Beszel vẫn là cảnh báo riêng, không đồng nhất với DOWN.

## GitHub Actions

Tên secret/variable dùng thống nhất:

| Tên | Loại | Dùng bởi |
|---|---|---|
| `VPS_HOST` | variable | `deploy-vps.yml` |
| `VPS_USER` | variable | `deploy-vps.yml` |
| `VPS_SSH_PRIVATE_KEY` | secret | `deploy-vps.yml` |
| `VPS_KNOWN_HOSTS` | secret | `deploy-vps.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Worker/UptimeFlare deploy |
| `CLOUDFLARE_API_TOKEN` | secret | Worker/UptimeFlare deploy |
| `PUSH_SECRET` | Worker secret | Set một lần bằng `wrangler secret put PUSH_SECRET`; không commit hoặc in trong Actions log |

`CLOUDFLARE_API_TOKEN` chỉ có quyền tối thiểu trên account đích. `VPS_KNOWN_HOSTS` phải được thu thập từ host key đã xác minh; không tắt host-key checking. `deploy-vps.yml` yêu cầu GitHub Environment `production`; `VPS_DEPLOY_PATH` phải là absolute path an toàn, mặc định `/opt/beszel`. Tên secret của upstream UptimeFlare phải khớp workflow upstream nếu template dùng tên khác.

### `ci.yml`

Chạy trên pull request và push phù hợp; không nhận production secrets. Kiểm tra Compose bằng giá trị giả, chạy Node tests cho heartbeat và kiểm tra Worker build/config bằng Wrangler trong CI runner có toolchain. Pull request không được deploy production.

### `deploy-vps.yml`

- Trigger: push vào protected `main` với path filter liên quan Compose/scripts, hoặc `workflow_dispatch` từ `main`.
- Dùng GitHub Environment `production` + reviewers, concurrency theo environment; không chạy hai deployment VPS đồng thời.
- SSH bằng key riêng, host key đã xác minh.
- Chuyển file versioned; không ghi đè `.env`, Hub data hoặc volume.
- Kiểm tra Compose trên VPS, pull đúng image pin, tạo backup trước nâng version, rồi `docker compose up -d`.
- Kiểm tra Hub, Agent, socket và heartbeat sau deploy. Bất kỳ check nào fail đều làm workflow fail; không tự che lỗi.
- Không tự mở firewall, cài runner mới trên production hoặc restart stack không liên quan.

### `deploy-heartbeat.yml`

- Trigger: thay đổi dưới `heartbeat/**` hoặc `workflow_dispatch`; không restart Beszel khi chỉ sửa Worker.
- Chạy test, áp dụng migration D1 tương thích ngược bằng Wrangler với `--remote`, sau đó deploy Worker.
- Không thay secret Worker trong mỗi deploy trừ khi có bước rotation được review. Không in secret vào log.
- Dùng `CLOUDFLARE_ACCOUNT_ID` và `CLOUDFLARE_API_TOKEN`; kiểm tra status endpoint sau deploy.

### UptimeFlare Actions

Dùng workflow deployment của official template trong `tuan-uptimeflare`; không tạo pipeline thay thế khi upstream đã đáp ứng. Review thủ công khi sync upstream, sau đó deploy bằng credentials tối thiểu.

## Update, rollback và backup

- Version production ban đầu là `0.20.0`; mọi nâng version đi qua PR, test và merge. Không dùng `latest`.
- Trước update Beszel, workflow yêu cầu `.env` production hợp lệ và tạo backup Hub dưới `$BACKUP_DIR` (mặc định `/opt/beszel/backups`) bằng cách dừng Hub ngắn hạn; không tar database đang ghi. Backup local chỉ là rollback aid, vẫn cần copy ra đích ngoài VPS.
- Sao lưu tới đích ngoài VPS và thử restore trong môi trường tách biệt trước nghiệm thu production. D1 backup/export tuân theo khả năng và chính sách Cloudflare đã chọn.
- Deploy lỗi: giữ volume và dữ liệu, đánh dấu workflow fail, không `docker compose down -v`, không prune volume.
- Rollback image về version trước chỉ khi schema tương thích. Nếu đã migration, restore image cùng backup/schema tương ứng; không downgrade schema mù.
- Rollback Worker theo migration/application version đã kiểm tra; migration D1 là append-only về vận hành, không tự xóa hoặc đảo schema production.
- Sau rollback, chạy lại acceptance tests và xác nhận alert recovery.

## Acceptance tests

Chạy trong maintenance window đã được phê duyệt; không dừng dịch vụ production tùy ý.

1. Secret sai, JSON lỗi và body vượt `16 KiB` không làm thay đổi `last_seen`.
2. Kiểm tra đúng biên TTL `150s` và ngay sau `150s`; tuổi tính theo thời điểm Worker nhận request, không theo timestamp VPS.
3. Chưa có heartbeat, stale heartbeat hoặc D1 lỗi đều trả `503` ở cả hai endpoint.
4. `total=0`, `pending>0`, `paused>0` hoặc `down>0` làm `/systems` trả `503`.
5. Resource status `warn` khi Agent vẫn up không làm `/live` hoặc `/systems` báo DOWN.
6. Dừng Agent có kiểm soát: `/live` còn UP, `/systems` DOWN sau policy; dừng Hub: cả hai DOWN sau TTL.
7. UptimeFlare monitor dùng đúng `target`, `expectedCodes: [200]`, `timeout: 5000`, `responseKeyword: "healthy"`, không có `gracePeriod`.
8. Xác nhận notification DOWN và recovery thực sự tới kênh nhận, không chỉ nhìn status page.
9. Recreate container vẫn giữ dữ liệu; backup restore thành công trong môi trường tách biệt.
10. Secret không xuất hiện trong Git, Actions log, Worker log, API công khai hoặc frontend bundle.
11. Chỉ public hóa app monitors; kiểm tra password protection và xác nhận API exposure đã được chấp nhận có chủ đích.
12. Kiểm tra HTTPS, DNS, SSH tunnel admin và persistence sau deploy.
13. UptimeFlare dùng bản đã vá `GHSA-36q9-v7p3-vj6v` (commit `377a5963c66ba9a798abfe8d80378b053435e9`); rotate credentials nếu từng chạy bản lỗi.

## Tài liệu chính thức

- Beszel getting started: https://beszel.dev/guide/getting-started
- Beszel heartbeat: https://beszel.dev/guide/heartbeat
- Beszel security: https://beszel.dev/guide/security
- Beszel Hub image: https://hub.docker.com/r/henrygd/beszel
- Beszel Agent image: https://hub.docker.com/r/henrygd/beszel-agent
- UptimeFlare official template: https://github.com/lyc8503/UptimeFlare
- UptimeFlare quickstart: https://github.com/lyc8503/UptimeFlare/wiki/Quickstart
- UptimeFlare upstream sync: https://github.com/lyc8503/UptimeFlare/wiki/Synchronize-updates-from-upstream
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Wrangler D1 commands: https://developers.cloudflare.com/workers/wrangler/commands/#d1
- Cloudflare Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare GitHub Actions: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
