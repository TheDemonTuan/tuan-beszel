# Beszel Infrastructure Runbook

Runbook cho Beszel Hub/Agent của repository này.

## Trạng thái hiện tại

Beszel đã triển khai trên VPS hiện hữu tại `/opt/beszel`:

- Dashboard: `https://beszel.tuannguyenviet.site`
- Hub + Agent: healthy, image `0.21.2`
- System: `Main VPS`, Unix socket, status `up`
- Token từng lộ trong chat phải được thu hồi/rotate trước khi dùng lại.

Workspace chứa Compose và script deploy. Status page https://github.com/TheDemonTuan/tuan-uptimeflare kiểm tra trực tiếp `/api/health` của Hub qua Cloudflare Access; repo này không deploy status page.

## Kiến trúc đã duyệt

- Repository này (`tuan-beszel`) là private infrastructure repo.
- Không fork Beszel. Hub và Agent dùng image chính thức, ghim cùng release trong `compose.yml`.
- Beszel Hub và Agent chạy cùng VPS. Hub không publish cổng host; Traefik kết nối Hub trên `beszel-traefik`.
- Hub và Agent dùng Unix socket `/beszel_socket/beszel.sock`; không mở TCP `45876`.

## Prerequisites

- VPS Linux, kiến trúc `amd64` hoặc `arm64`, Docker Engine và Docker Compose plugin.
- User SSH có quyền triển khai; host key VPS đã xác minh. Không mở SSH mới cho GitHub Actions nếu đã có tuyến quản trị an toàn.
- GitHub private repository, protected `main`, Actions enabled, environment protection nếu cần.
- Xác nhận disk, backup destination ngoài VPS, cổng đang dùng và route SSH trước bootstrap.

## Cây local mục tiêu

```text
tuan-beszel/
  compose.yml
  .env.example
  .gitignore
  README.md
  scripts/deploy.sh
  .github/workflows/
    ci.yml
    deploy-vps.yml
```

`.env` chỉ tồn tại trên VPS hoặc máy quản trị đã bảo vệ, nằm trong `.gitignore`; không commit. Repo này chỉ sở hữu Beszel Hub/Agent.

## Beszel trên VPS

Đặt stack tại `/opt/beszel`, tách khỏi stack ứng dụng khác. Compose phải giữ các contract sau:

- Hub image `henrygd/beszel`, volume dữ liệu persistent, `restart: unless-stopped`, log có giới hạn.
- Agent image `henrygd/beszel-agent`, `network_mode: host`, volume dữ liệu cần thiết; system `Main VPS` hiện `up`.
- Shared socket mount vào cả hai container tại `/beszel_socket/beszel.sock`.
- Compose dùng healthcheck chính thức `/beszel health --url http://localhost:8090` và `/agent health`; deploy chờ cả hai healthy.
- Hub không publish host port; Traefik chuyển tiếp tới container port `8090` qua mạng riêng `beszel-traefik`. Hub dùng `beszel-egress` cho kết nối ra ngoài; không gắn Hub vào `edge-cf-ingress` cùng cloudflared.
- Chỉ mount Docker socket khi cần Docker metrics. `:ro` không biến Docker API thành read-only; Agent vẫn là component có quyền nhạy cảm. Không dùng `privileged` hoặc mount host thừa.

### Chuyển mạng Traefik/Beszel trên VPS

`beszel-traefik` là mạng Docker external: tạo một lần, không để Compose Beszel tự tạo mạng theo tên project. Cấu hình Traefik nằm ngoài repo này; **hoàn tất trên VPS trước khi merge/push thay đổi `compose.yml`** (push `main` sẽ tự deploy Beszel). Giữ nguyên `edge-cf-ingress` cho Traefik và cloudflared, không nối cloudflared vào mạng mới.

1. `docker network create beszel-traefik` (nếu mạng chưa tồn tại). Trong Compose quản lý Traefik, **thêm** `beszel-traefik` vào `networks` của service Traefik, giữ mọi mạng đang có; khai báo top-level:

   ```yaml
   networks:
     beszel-traefik:
       external: true
       name: beszel-traefik
   ```

   Áp dụng stack Traefik theo quy trình hiện có; `docker network inspect beszel-traefik` phải cho thấy container Traefik. `docker network connect` đơn lẻ không đủ: kết nối sẽ mất khi Traefik được recreate. Không gỡ Traefik khỏi `edge-cf-ingress` vì cloudflared vẫn cần tới Traefik.
2. Sau khi Traefik đã trên mạng mới, deploy Compose Beszel phiên bản này. `traefik.docker.network` chọn `beszel-traefik`; Compose sẽ gỡ Hub khỏi `edge-cf-ingress` khi recreate. Không gỡ thủ công mạng cũ khi các dịch vụ khác còn dùng.
3. Xác nhận bằng `docker inspect -f '{{json .NetworkSettings.Networks}}' "$(docker compose ps -q beszel)"` tại `/opt/beszel`: chỉ thấy `beszel-traefik` và mạng `beszel-egress`, không có `edge-cf-ingress`. Kiểm tra Traefik và Beszel cùng xuất hiện trong `docker network inspect beszel-traefik`, cloudflared không xuất hiện; kiểm tra dashboard qua route HTTPS đã xác thực và cả Hub/Agent healthy. Nếu route lỗi, khôi phục Compose Beszel bản cũ và deploy lại trước khi tháo mạng mới khỏi Traefik.

Khi bootstrap máy mới, thực hiện bước 1 trước `docker compose up -d beszel` bên dưới.

### Bootstrap lần đầu

Thực hiện đúng thứ tự:

1. Tạo `/opt/beszel`, copy `compose.yml` và `.env.example` thành `.env`; điền `BESZEL_HUB_USER_EMAIL`/`BESZEL_HUB_USER_PASSWORD` bằng credentials bootstrap một lần, đặt quyền `chmod 600 .env`. Có thể để trống `BESZEL_AGENT_TOKEN`/`BESZEL_AGENT_KEY` khi bootstrap Hub; Agent sẽ chưa chạy cho tới khi Hub cấp credentials.
2. Khởi động **chỉ Hub** bằng service name thực tế trong Compose, ví dụ:

   ```bash
   cd /opt/beszel
   docker compose up -d beszel
   ```

3. Truy cập dashboard qua route đã bảo vệ `https://beszel.tuannguyenviet.site`. Không mở hoặc publish port Hub trên host.

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

9. Xác nhận host metrics, Docker metrics (nếu bật), socket connection và system state trong Hub.

Bootstrap tự động đã dùng `/api/beszel/create-user`, PocketBase records cho system/fingerprint và xóa hai biến bootstrap khỏi `.env` sau khi đăng nhập thành công. Không xóa `/opt/beszel/beszel_data`; đó là dữ liệu Hub. Không dùng `latest`, Watchtower hoặc auto-pull ngoài quy trình review.

## GitHub Actions

Tên secret/variable dùng thống nhất:

| Tên | Loại | Dùng bởi |
|---|---|---|
| `VPS_HOST` | variable | `deploy-vps.yml` |
| `VPS_USER` | variable | `deploy-vps.yml` |
| `VPS_SSH_PRIVATE_KEY` | secret | `deploy-vps.yml` |
| `VPS_KNOWN_HOSTS` | secret | `deploy-vps.yml` |

`VPS_KNOWN_HOSTS` phải được thu thập từ host key đã xác minh; không tắt host-key checking. `deploy-vps.yml` yêu cầu GitHub Environment `production`; `VPS_DEPLOY_PATH` phải là absolute path an toàn, mặc định `/opt/beszel`.

### `ci.yml`

Chạy trên pull request và push; không nhận production secrets. Kiểm tra Compose và mạng riêng của Hub bằng giá trị giả. Pull request không được deploy production.

### `deploy-vps.yml`

- Trigger: push vào protected `main` với path filter liên quan Compose/scripts, hoặc `workflow_dispatch` từ `main`.
- Dùng GitHub Environment `production` + reviewers, concurrency theo environment; không chạy hai deployment VPS đồng thời.
- SSH bằng key riêng, host key đã xác minh.
- Chuyển file versioned; không ghi đè `.env`, Hub data hoặc volume.
- Kiểm tra Compose trên VPS, pull đúng image pin, tạo backup trước nâng version, rồi `docker compose up -d`.
- Kiểm tra Hub, Agent và socket sau deploy. Bất kỳ check nào fail đều làm workflow fail; không tự che lỗi.
- Không tự mở firewall, cài runner mới trên production hoặc restart stack không liên quan.

## Update, rollback và backup

- `compose.yml` là nguồn version production cho cả hai image; `BESZEL_VERSION` trong `.env` không còn ghi đè. Renovate đề xuất nâng cả hai image trong cùng PR, qua CI và review trước deploy. Không dùng `latest`.
- Trước update Beszel, workflow yêu cầu `.env` production hợp lệ và tạo backup Hub dưới `$BACKUP_DIR` (mặc định `/opt/beszel/backups`) bằng cách dừng Hub ngắn hạn; không tar database đang ghi. Backup local chỉ là rollback aid, vẫn cần copy ra đích ngoài VPS.
- Sao lưu tới đích ngoài VPS và thử restore trong môi trường tách biệt trước nghiệm thu production.
- Deploy lỗi: giữ volume và dữ liệu, đánh dấu workflow fail, không `docker compose down -v`, không prune volume.
- Rollback image về version trước chỉ khi schema tương thích. Nếu đã migration, restore image cùng backup/schema tương ứng; không downgrade schema mù.
- Sau rollback, chạy lại acceptance tests và xác nhận alert recovery.

## Acceptance tests

Chạy trong maintenance window đã được phê duyệt; không dừng dịch vụ production tùy ý.

1. Hub và Agent healthy; system `Main VPS` hiện `up` trong Hub.
2. Recreate container vẫn giữ dữ liệu; backup restore thành công trong môi trường tách biệt.
3. Secret không xuất hiện trong Git hoặc Actions log.
4. Kiểm tra HTTPS, DNS, SSH tunnel admin và persistence sau deploy.

## Tài liệu chính thức

- Beszel getting started: https://beszel.dev/guide/getting-started
- Beszel security: https://beszel.dev/guide/security
- Beszel Hub image: https://hub.docker.com/r/henrygd/beszel
- Beszel Agent image: https://hub.docker.com/r/henrygd/beszel-agent
