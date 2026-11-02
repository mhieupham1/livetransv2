# Relay — Phiên dịch hội thoại realtime

Ứng dụng web phiên dịch trực tiếp giữa **tiếng Việt, Anh, Nhật, Trung, Hàn và Thái**.
Nói vào micro, câu nói được nhận dạng, chia lượt theo khoảng lặng, dịch và hiển thị trong
khung ngôn ngữ tương ứng — kèm đọc bản dịch bằng giọng nói và tạo biên bản AI sau cuộc họp.

Có tài khoản người dùng (Google), hạn mức dùng thử theo tháng, nâng cấp Pro bằng chuyển khoản
VietQR và trang quản trị riêng để theo dõi người dùng, doanh thu, gói cước.

---

## Mục lục

- [Tính năng](#tính-năng)
- [Kiến trúc](#kiến-trúc)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt và chạy trên máy](#cài-đặt-và-chạy-trên-máy)
- [Biến môi trường](#biến-môi-trường)
- [Chạy production](#chạy-production)
- [Hạn mức và gói cước](#hạn-mức-và-gói-cước)
- [Trang quản trị](#trang-quản-trị)
- [Thanh toán VietQR](#thanh-toán-vietqr)
- [API](#api)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Dữ liệu và sao lưu](#dữ-liệu-và-sao-lưu)
- [Lưu ý về trình duyệt và micro](#lưu-ý-về-trình-duyệt-và-micro)
- [Kiểm tra mã nguồn](#kiểm-tra-mã-nguồn)
- [Khắc phục sự cố](#khắc-phục-sự-cố)

---

## Tính năng

**Phiên dịch**

- Nhận dạng giọng nói realtime qua WebSocket; hiển thị transcript tạm thời trong lúc người dùng nói.
- Tự chia lượt nói theo khoảng lặng (~1,2 giây), nhận diện ngôn ngữ và đưa câu vào đúng khung.
- Chế độ một chiều hoặc hai chiều, đổi chiều bằng một nút.
- Tự chuyển sang endpoint HTTP `/api/transcribe` khi WebSocket lỗi hoặc timeout.
- Dịch theo từng lượt nói qua API tương thích OpenAI, có hàng đợi và tự thử lại khi bị giới hạn.
- Nhập tay khi trình duyệt không hỗ trợ ghi âm, hoặc khi cần sửa câu.
- Từ khóa và ngữ cảnh hội thoại để dịch đúng tên riêng, thuật ngữ.

**Hội thoại**

- Điều khiển phiên: bắt đầu, tạm dừng, kết thúc; đếm thời lượng.
- Đọc bản dịch bằng giọng nói của trình duyệt (bật/tắt).
- Xuất transcript ra file, tạo biên bản AI (Tổng quan / Điểm chính / Quyết định / Việc cần làm).
- Lưu tối đa 100 lượt gần nhất trong `localStorage` — refresh không mất hội thoại.

**Tài khoản và thanh toán**

- Đăng nhập Google; phiên 30 ngày, token bị thu hồi ngay khi đăng xuất.
- Hạn mức tháng tự làm mới đầu mỗi tháng, không cần job nền.
- Mua thêm thời gian bằng VietQR, cộng dồn, không hết hạn theo tháng.
- Banner cảnh báo khi còn dưới 5 phút; rung (nếu máy hỗ trợ) và cảnh báo mạnh khi còn dưới 1 phút.
- Mua thêm ngay giữa phiên mà không phải thoát ra.

**Giao diện**

- Sáng / Tối / Tự động theo hệ điều hành, có bộ chọn trong Cài đặt.
- Bố cục riêng cho điện thoại và máy tính; 4 cỡ chữ transcript (tới 200% cho phòng họp).
- Giữ màn hình sáng trong lúc ghi âm (Screen Wake Lock).

---

## Kiến trúc

| Lớp | Công nghệ |
|---|---|
| Giao diện | React 19 + TypeScript, Vite. Không dùng router — vài mẫu đường dẫn `/admin/*` được khớp thủ công trong `src/main.tsx` |
| Máy chủ | Express 5, `ws` cho WebSocket realtime |
| Cơ sở dữ liệu | SQLite qua `better-sqlite3` (chế độ WAL), file tại `data/app.sqlite` |
| Xác thực người dùng | Google Identity Services → ID token được verify ở server → JWT phiên (HS256, `jose`) trong cookie `HttpOnly` |
| Xác thực quản trị | Tài khoản/mật khẩu riêng, hash scrypt, cookie `relay_admin` tách hẳn phiên người dùng |
| Dịch thuật | Bất kỳ API tương thích OpenAI (`/v1/chat/completions`) |
| Nhận dạng giọng nói | Soniox realtime qua WebSocket; dự phòng endpoint HTTP multipart |
| Thanh toán | VietQR + webhook SePay |

Mọi API key chỉ tồn tại ở backend. Trình duyệt không bao giờ nhận được khóa LLM, STT hay SePay.

---

## Yêu cầu

- **Node.js 20 trở lên**
- `cloudflared` (chỉ khi muốn đưa ra Internet qua Cloudflare Tunnel)
- Một API tương thích OpenAI cho phần dịch và biên bản
- Một dịch vụ STT (mặc định Soniox, model `soniox-stt`)

---

## Cài đặt và chạy trên máy

```bash
npm install
cp .env.example .env
```

Mở `.env`, điền tối thiểu ba giá trị:

| Biến | Không điền thì sao |
|---|---|
| `SESSION_SECRET` | **Server không khởi động** (cố ý, tối thiểu 16 ký tự) |
| `GOOGLE_CLIENT_ID` | Không có nút đăng nhập, mọi API cần đăng nhập trả `401` |
| `LLM_API_KEY` | Dịch và biên bản trả `503` |

Tạo `SESSION_SECRET` bằng: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Nếu LLM và STT nằm ở hai host khác nhau, đặt thêm `TRANSCRIPTION_BASE_URL` và
`TRANSCRIPTION_API_KEY`. Để dùng realtime, `TRANSCRIPTION_MODEL` phải là `soniox-stt`.

Tạo tài khoản quản trị (chỉ cần một lần):

```bash
npm run seed
```

Script in ra mật khẩu ngẫu nhiên **một lần duy nhất** — server chỉ lưu hash scrypt, mất là
phải `--reset`. Chi tiết ở [Trang quản trị](#trang-quản-trị).

Khởi động chế độ phát triển:

```bash
npm run dev
```

Mở <http://localhost:5173>. Vite proxy `/api` (kể cả WebSocket) sang backend ở cổng `3001`.

> Trong Google Cloud Console, thêm `http://localhost:5173` và `http://localhost:3001` vào
> danh sách **Authorized JavaScript origins**.

---

## Biến môi trường

Toàn bộ nằm trong `.env.example`, được nạp bằng `dotenv/config` từ file `.env` ở thư mục hiện
hành. Chỉ `SESSION_SECRET` là bắt buộc để server khởi động; thiếu các biến còn lại thì tính
năng tương ứng trả `503` chứ server vẫn chạy.

### Bắt buộc và gần như bắt buộc

| Biến | Mặc định | Mô tả |
|---|---|---|
| `SESSION_SECRET` | — | **Bắt buộc.** Ký JWT phiên. Tối thiểu 16 ký tự. Đổi giá trị này sẽ đăng xuất toàn bộ người dùng lẫn admin |
| `GOOGLE_CLIENT_ID` | — | Client ID cho Google Sign-In. Thiếu thì không ai đăng nhập được |
| `LLM_API_KEY` | — | Thiếu thì `/api/translate` và `/api/summarize` trả `503` |

### Dịch và biên bản

| Biến | Mặc định | Mô tả |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:8001` | Gốc API tương thích OpenAI |
| `LLM_MODEL` | `gpt-5-5-mini` | Model dùng để dịch và tạo biên bản. Đặt đúng tên model mà API của bạn hỗ trợ |
| `TRANSLATE_CHARS_PER_SECOND` | `100` | Quy đổi ký tự dịch sang giây hạn mức. `100` nghĩa là 100 ký tự ≈ 1 giây |

### Nhận dạng giọng nói

| Biến | Mặc định | Mô tả |
|---|---|---|
| `TRANSCRIPTION_BASE_URL` | bằng `LLM_BASE_URL` | Cho phép dùng host STT khác host LLM |
| `TRANSCRIPTION_API_KEY` | bằng `LLM_API_KEY` | Khóa STT riêng nếu có |
| `TRANSCRIPTION_MODEL` | `whisper-1` | **Phải đặt `soniox-stt`** để dùng được realtime WebSocket |

### Máy chủ

| Biến | Mặc định | Mô tả |
|---|---|---|
| `PORT` | `3001` | Cổng backend (và cổng phục vụ giao diện khi đã build) |
| `HOST` | `127.0.0.1` | Địa chỉ lắng nghe. Xem cảnh báo bên dưới trước khi đổi |
| `PUBLIC_BASE_URL` | — | Nếu bắt đầu bằng `https://`, cookie phiên được gắn cờ `Secure`. Đặt đúng tên miền thật khi chạy production |

> **Về `HOST`**: mặc định chỉ nghe loopback vì Cloudflare Tunnel chạy cùng máy và proxy tới
> `localhost:3001`. Khi `HOST=0.0.0.0`, server **không** tin header `CF-Connecting-IP` nữa —
> nếu vẫn tin, client gọi thẳng vào cổng có thể tự đặt header và vô hiệu hóa giới hạn đăng
> nhập admin. Giới hạn sẽ chuyển sang dùng IP socket thật.

### Hạn mức mặc định

Chỉ dùng **lần đầu** khi bảng `plans` còn trống. Sau đó sửa tại `/admin/plans` — không cần restart.

| Biến | Mặc định | Mô tả |
|---|---|---|
| `FREE_QUOTA_SECONDS` | `1800` | Hạn mức tháng của gói Free (30 phút) |
| `PRO_QUOTA_SECONDS` | `2592000` | Hạn mức tháng của gói Pro (30 ngày) |

### Thanh toán

Có thể để trống và cấu hình trực tiếp tại `/admin/settings`. Giá trị `.env` chỉ là mặc định
cho lần chạy đầu; sau khi lưu trên trang admin, **DB là nguồn duy nhất**.

| Biến | Mặc định | Mô tả |
|---|---|---|
| `BANK_BIN` | — | Mã BIN ngân hàng, ví dụ `970422` (MB Bank) |
| `BANK_ACCOUNT` | — | Số tài khoản nhận tiền |
| `BANK_ACCOUNT_NAME` | — | Tên chủ tài khoản, viết không dấu |
| `UPGRADE_AMOUNT_VND` | `99000` | Giá mặc định của gói Pro |
| `SEPAY_WEBHOOK_API_KEY` | — | Khóa xác thực webhook SePay. Không bao giờ trả xuống trình duyệt |

---

## Chạy production

```bash
npm run build
npm start
```

Backend phục vụ cả API và giao diện đã build tại <http://localhost:3001>.

> Backend đọc biến môi trường qua `dotenv/config` và mở DB tại `./data` **theo thư mục hiện
> hành**. Luôn chạy `npm start` từ thư mục gốc của dự án, nếu không sẽ tạo một DB trống khác.

### Đưa ra Internet bằng Cloudflare Tunnel

`npm run public` build, rồi chạy app song song với `cloudflared`.

`cloudflared.yml` chứa đường dẫn tuyệt đối tới file credentials của tunnel nên **đã được
gitignore** — mỗi máy tự tạo từ bản mẫu:

```bash
cp cloudflared.example.yml cloudflared.yml
```

Sửa hai dòng đầu cho đúng máy bạn:

```yaml
tunnel: <tunnel-id>
credentials-file: /path/to/<tunnel-id>.json

ingress:
  - hostname: translate.example.com
    service: http://localhost:3001
  - service: http_status:404
```

Rồi chạy:

```bash
npm run public
```

Nhớ đặt `PUBLIC_BASE_URL=https://translate.example.com` trong `.env` để cookie được gắn `Secure`.

---

## Hạn mức và gói cước

### Đơn vị

Tất cả hạn mức tính bằng **giây**. Hai nguồn được đối xử khác nhau:

| Nguồn | Cột DB | Hết hạn theo tháng? |
|---|---|---|
| Hạn mức tháng của gói | `quota_seconds` (đã dùng: `used_seconds`) | Có — reset đầu tháng |
| Thời gian mua thêm | `bonus_seconds` | Không |

Hạn mức tháng tiêu trước, hết mới trừ vào phần mua thêm. `quota_seconds = 0` nghĩa là
**không giới hạn** (mọi lượt dùng vẫn được ghi nhận để thống kê). Lưu ý: phần mua thêm
(`bonus_seconds`) vẫn được dùng kể cả khi hạn mức tháng đã cạn — đó là điểm khác biệt so với
việc hết hạn mức hoàn toàn.

### Kỳ tháng

Kỳ bắt đầu 00:00 ngày 1 hằng tháng theo **giờ máy chủ**. Request đầu tiên của tháng mới tự
làm mới hạn mức — kể cả request mở WebSocket realtime. Không có job nền nào cần chạy.

### Cách trừ

- **Ghi âm realtime**: server tự đếm thời gian trong kết nối, trừ mỗi 15 giây.
- **Ghi âm gửi từng đoạn** (`/api/transcribe`): trừ **trước** khi gọi STT, hoàn lại nếu lỗi.
  Thời lượng tính bằng mức lớn hơn giữa `duration_ms` client báo và ước lượng từ kích thước
  file; tối đa 60 giây mỗi đoạn.
- **Dịch và biên bản**: trừ trước khi gọi LLM, hoàn lại nếu lỗi. `100 ký tự = 1 giây`.

Việc trừ diễn ra trong một câu `UPDATE` có điều kiện, nên nhiều request song song không thể
cùng lọt qua bước kiểm tra rồi cùng tiêu tiền.

### Hai loại gói

Sửa tại `/admin/plans`:

| Loại | Mã | Cách hoạt động |
|---|---|---|
| Thuê bao | `subscription` | Đặt làm gói chính của người dùng, reset kỳ, cấp hạn mức tháng mới |
| Một lần | `event` | Cộng vào `bonus_seconds`, không đổi gói chính, không hết hạn theo tháng |

Gói một lần **không thể** đặt làm gói chính: hệ thống từ chối vì `monthly_seconds = 0` sẽ biến
người dùng thành không giới hạn. Hãy cấp qua mục **Cấp gói ngay** ở trang chi tiết người dùng.

### Đơn thanh toán

Mỗi đơn có mã `RELAY` + 6 ký tự hex (ví dụ `RELAY3F9A1C`) làm nội dung chuyển khoản. Đơn
`pending` quá **30 phút** tự chuyển sang `expired` mỗi lần có đơn mới được tạo hoặc webhook
được gọi.

---

## Trang quản trị

Dùng tài khoản/mật khẩu riêng, **tách hẳn** khỏi đăng nhập Google của người dùng. Tài khoản
lưu trong bảng `admin_accounts`, dùng được nhiều người quản trị, đổi mật khẩu không cần restart.

### Tạo và quản lý tài khoản

```bash
npm run seed                                  # tạo admin nếu chưa có, in mật khẩu một lần
npm run seed -- --reset admin                 # đặt lại mật khẩu cho tài khoản đã có
npm run seed -- --username boss               # tạo tài khoản với tên khác
SEED_ADMIN_PASSWORD=<mật-khẩu> npm run seed   # tự chọn mật khẩu (tối thiểu 12 ký tự)
```

Chạy lại `npm run seed` khi tài khoản đã tồn tại sẽ **không** ghi đè mật khẩu.

Hiện **chưa có giao diện** để tạo hay xóa tài khoản admin khác — mọi thao tác tạo/đặt lại đều
qua script trên. Đổi mật khẩu thì làm được ngay trong `/admin/settings`.

### Các trang

| Đường dẫn | Nội dung |
|---|---|
| `/admin` | Thống kê tổng quan, danh sách người dùng có tìm kiếm và phân trang |
| `/admin/users/:id` | Chi tiết một người dùng: mức sử dụng, đổi gói, đặt hạn mức, đặt lại thời gian đã dùng, xem đơn |
| `/admin/revenue` | Doanh thu theo ngày (7 / 30 / 90 ngày), khách chi trả nhiều nhất |
| `/admin/plans` | Thêm, sửa, ngừng bán gói cước (nút xóa thực chất là tắt `active`, không xóa dữ liệu; gói Free không tắt được) |
| `/admin/settings` | Tài khoản nhận tiền VietQR, giá nâng cấp, khóa SePay, đổi mật khẩu quản trị |

Mọi giao dịch chuyển khoản đều được lưu lại, kể cả giao dịch không khớp đơn (khách ghi sai nội
dung, chuyển thiếu tiền, tiền ra). Hiện **chưa có giao diện** cho danh sách này — chỉ có API
`GET /api/admin/payments/unmatched` và `POST /api/admin/payments/:id/credit`. Khi cần bù tay,
vào trang chi tiết người dùng và dùng **Cấp gói ngay** hoặc chỉnh hạn mức.

### Bảo mật

- Phiên admin là cookie `relay_admin` riêng, hết hạn sau **8 giờ**.
- Token admin mang fingerprint của hash mật khẩu, nên đổi mật khẩu sẽ thu hồi ngay mọi phiên
  admin cũ của tài khoản đó.
- Sau **10 lần đăng nhập sai** từ cùng một IP, đăng nhập bị chặn **10 phút**.
- Có thêm giới hạn **toàn cục 60 lượt/10 phút** — vì mỗi lượt chạy scrypt (~100 ms CPU), kẻ
  xoay IP có thể làm cạn CPU. Vượt ngưỡng toàn cục thì mọi IP đều bị chặn tạm.
- Mọi API `/api/admin/*` kiểm tra cookie ở server. Tài khoản quản trị không có quyền dùng
  micro hay API của người dùng.

---

## Thanh toán VietQR

1. Vào `/admin/settings`.
2. Chọn ngân hàng, nhập số tài khoản, tên chủ tài khoản (không dấu, đúng như ngân hàng đăng ký),
   giá nâng cấp và khóa webhook SePay.
3. Bấm **Lưu cấu hình**. Đơn tạo sau đó dùng ngay thông tin mới, **không cần restart**.

Ô xem trước hiển thị mã QR thật từ VietQR để bạn kiểm tra trước khi lưu.

### Cấu hình webhook SePay

Trỏ webhook về:

```
https://<tên-miền-của-bạn>/api/billing/sepay-webhook
```

Server chấp nhận khóa ở một trong các dạng: `Authorization: Bearer <key>`,
`Authorization: Apikey <key>`, hoặc header `X-Api-Key`. So sánh bằng
`timingSafeEqual`; không khớp hoặc chưa cấu hình khóa thì trả `401`.

Khi có webhook, server xử lý theo thứ tự:

1. Trùng `id` giao dịch → trả lại kết quả cũ, **không cộng thêm** lần nữa.
2. `transferType` khác `in` → bỏ qua (tiền ra không bao giờ là thanh toán).
3. Số tài khoản nhận khác tài khoản đã cấu hình → bỏ qua.
4. Tìm mã `RELAYxxxxxx` trong `content`, `description` hoặc `referenceCode`.
5. Không tìm thấy đơn → ghi nhận `matched = 0`.
6. Đơn đã `paid` → ghi nhận để hoàn/cộng bù, không cộng lần hai.
7. Số tiền **nhỏ hơn** giá gói → ghi nhận `matched = 0` (chuyển thiếu).
8. Hợp lệ → cấp thời gian theo gói của đơn.

Mọi trường hợp, kể cả bị bỏ qua, đều được lưu vào bảng `payments` để đối soát về sau
(xem [Khắc phục sự cố](#khắc-phục-sự-cố)).

Khóa SePay không bao giờ được gửi xuống trình duyệt.

---

## API

Tất cả endpoint dưới `/api` trả JSON, kể cả khi lỗi — đường dẫn không tồn tại trả
`404 { error }` chứ không rơi xuống `index.html`.

### Công khai

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| `GET` | `/api/health` | Trạng thái cấu hình: LLM, Google, thanh toán, admin |
| `POST` | `/api/auth/google` | Nhận `{ credential }` (ID token), đặt cookie phiên |
| `POST` | `/api/billing/sepay-webhook` | Webhook chuyển khoản |

### Cần đăng nhập

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| `GET` | `/api/me` | Thông tin người dùng hiện tại (đã áp dụng kỳ tháng mới) |
| `POST` | `/api/auth/logout` | Thu hồi token và xóa cookie |
| `POST` | `/api/usage/heartbeat` | Trả trạng thái hạn mức cho UI, gọi mỗi 15 giây |
| `GET` | `/api/plans` | Danh sách gói đang bán |
| `POST` | `/api/billing/orders` | Tạo đơn chuyển khoản `{ planId }` |
| `GET` | `/api/billing/orders/:id` | Trạng thái một đơn |
| `POST` | `/api/translate` | Dịch `{ text, source, target, context }` |
| `POST` | `/api/summarize` | Tạo biên bản từ `{ entries, outputLanguage, context }` |
| `POST` | `/api/transcribe` | Nhận dạng một đoạn ghi âm (multipart, WebM/Opus, tối đa 25 MB) |
| `WS` | `/api/transcribe/realtime` | Nhận dạng realtime |

### Quản trị

Ba endpoint mở công khai vì phải gọi được khi chưa đăng nhập:

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| `GET` | `/api/admin/session` | `{ configured, authenticated, username }` |
| `POST` | `/api/admin/login` | `{ username, password }` → đặt cookie admin |
| `POST` | `/api/admin/logout` | Xóa cookie admin |

Toàn bộ endpoint còn lại cần cookie admin: `POST /api/admin/password`,
`GET /api/admin/stats`, `GET|PUT /api/admin/settings/billing`, `GET /api/admin/plans`,
`PUT|DELETE /api/admin/plans/:id`, `GET /api/admin/users`, `GET|PATCH /api/admin/users/:id`,
`POST /api/admin/users/:id/grant`, `GET /api/admin/orders`, `GET /api/admin/revenue`,
`GET /api/admin/payments/unmatched`, `POST /api/admin/payments/:id/credit`.

Hai endpoint `payments/*` hiện **chưa có giao diện**, dùng trực tiếp bằng HTTP khi cần đối soát.

### Giới hạn tần suất

Token bucket trong bộ nhớ, mỗi người dùng một xô riêng cho từng nhóm endpoint:

| Nhóm | Xô | Hồi |
|---|---|---|
| `/api/translate` | 20 | 1 token/giây |
| `/api/summarize` | 3 | 1 token/20 giây |
| `/api/transcribe` | 30 | 2 token/giây |
| `/api/billing/orders` | 3 | 1 token/60 giây |

Vượt ngưỡng trả `429` kèm `Retry-After`.

> Giới hạn này chạy trong bộ nhớ tiến trình. Nếu chạy nhiều instance, cần chuyển sang Redis.

### Mã lỗi

| Mã | Ý nghĩa |
|---|---|
| `401` `auth_required` | Chưa đăng nhập hoặc phiên đã bị thu hồi |
| `402` `quota_exhausted` | Hết hạn mức — giao diện mở bảng nâng cấp |
| `429` `rate_limited` | Thao tác quá nhanh |
| `502` | Dịch vụ LLM/STT phía sau lỗi (hạn mức đã được hoàn) |

Thể loại lỗi do middleware (body quá lớn `413`, JSON hỏng `400`) cũng trả JSON thay vì trang
HTML mặc định của Express.

---

## Cấu trúc thư mục

```
server/
  index.ts        Toàn bộ route, WebSocket proxy tới Soniox, giới hạn tần suất
  db.ts           Schema SQLite, migration, mọi truy vấn, logic hạn mức
  auth.ts         Google ID token → JWT phiên, middleware requireAuth/requireQuota
  adminAuth.ts    Hash scrypt, phiên admin riêng, brute-force
  billing.ts      VietQR, đơn hàng, webhook SePay
  rateLimit.ts    Token bucket trong bộ nhớ

src/
  App.tsx         Toàn bộ ứng dụng phiên dịch
  main.tsx        Khớp đường dẫn /admin/* rồi render
  Admin*.tsx      Các trang quản trị
  adminShared.tsx Guard, header, tiện ích dùng chung cho trang admin
  styles.css      Design token sáng/tối + toàn bộ giao diện

scripts/seed.ts   Tạo/đặt lại tài khoản quản trị
data/             SQLite (không commit)
```

---

## Dữ liệu và sao lưu

Toàn bộ dữ liệu nằm trong `data/` — thư mục này đã được gitignore.

- `data/app.sqlite` — người dùng, đơn hàng, giao dịch, gói cước, cài đặt, tài khoản admin
- `data/app.sqlite-wal`, `app.sqlite-shm` — file phụ của chế độ WAL

Sao lưu an toàn khi server đang chạy (cần `sqlite3` CLI — có sẵn trên macOS):

```bash
sqlite3 data/app.sqlite ".backup 'backup-$(date +%F).sqlite'"
```

Không copy `app.sqlite` đơn lẻ khi server đang chạy — dữ liệu mới nhất có thể còn nằm trong
`-wal`. Khôi phục: dừng server, thay file trong `data/`, khởi động lại.

Để kiểm tra nhanh dữ liệu:

```bash
sqlite3 data/app.sqlite "SELECT plan, COUNT(*) FROM users GROUP BY plan;"
sqlite3 data/app.sqlite "SELECT status, COUNT(*), SUM(amount_vnd) FROM orders GROUP BY status;"
```

Migration tự chạy lúc khởi động (`addColumnIfMissing`), nên nâng cấp phiên bản chỉ cần thay
code và restart — nhưng vẫn nên sao lưu trước.

Hội thoại của người dùng **không** lưu trên server — chỉ nằm trong `localStorage` của trình
duyệt (100 lượt gần nhất).

---

## Lưu ý về trình duyệt và micro

- Ghi âm WebM/Opus hoạt động tốt nhất trên Chrome, Edge và Firefox.
- Micro chỉ dùng được trên `https://` hoặc `localhost` (yêu cầu bảo mật của trình duyệt).
- Nếu trình duyệt không hỗ trợ `MediaRecorder` WebM, ứng dụng chuyển sang PCM qua
  ScriptProcessor; nếu vẫn không được, ô nhập tay luôn hoạt động.
- Ứng dụng gửi chunk audio khoảng mỗi 250 ms. Sau ~1,2 giây im lặng, đoạn audio được commit,
  nhận transcript cuối cùng và bắt đầu lượt mới.
- Trên điện thoại, Wake Lock giữ màn hình sáng trong lúc ghi âm; khi chuyển sang tab khác
  rồi quay lại, lock được tự xin lại.

---

## Kiểm tra mã nguồn

```bash
npm run check   # tsc -b, gồm cả server và script
npm run build   # typecheck + build giao diện vào dist/
```

---

## Khắc phục sự cố

**Server báo `Chưa cấu hình SESSION_SECRET`**
Điền `SESSION_SECRET` (≥ 16 ký tự) vào `.env`. Đây là lỗi cố ý — server không chạy khi thiếu
khóa ký phiên.

**Không hiện nút đăng nhập Google**
Thiếu `GOOGLE_CLIENT_ID`, hoặc tên miền đang mở chưa có trong *Authorized JavaScript origins*.
Kiểm tra bằng `curl http://localhost:3001/api/health` — trường `authConfigured` phải là `true`.

**Đăng nhập xong bị đăng xuất ngay**
Ba nguyên nhân thường gặp:

- Đổi `SESSION_SECRET` → mọi token cũ mất hiệu lực.
- Đăng xuất ở một tab khác → `session_version` tăng, **tất cả** phiên của tài khoản bị thu hồi.
- `PUBLIC_BASE_URL` bắt đầu bằng `https://` nhưng bạn đang mở bằng `http://` trên một host
  không phải `localhost` → trình duyệt từ chối cookie `Secure`, nên phiên không được lưu.

**`/api/translate` trả 502**
Không kết nối được LLM. Kiểm tra `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
Hạn mức đã trừ cho request đó được hoàn lại.

**Realtime không hoạt động, chỉ có bản ghi từng đoạn**
`TRANSCRIPTION_MODEL` phải là `soniox-stt`. WebSocket realtime cần đúng model này và một
`TRANSCRIPTION_BASE_URL` truy cập được.

Nhớ rằng trình duyệt chỉ cho phép micro trên `https://` hoặc `localhost`. Nếu trang chạy qua
tunnel nhưng tên miền chưa bật HTTPS, nút ghi âm sẽ không hoạt động dù server vẫn khoẻ.

**Đơn chuyển khoản không tự cộng thời gian**
Kiểm tra: webhook SePay đã trỏ đúng URL chưa; khóa webhook có khớp không; nội dung chuyển
khoản có chứa mã `RELAYxxxxxx` không; số tiền chuyển có **đủ** giá gói không (thiếu một đồng
cũng không khớp). Giao dịch không khớp vẫn được lưu vào bảng `payments` với `matched = 0`;
xem bằng `GET /api/admin/payments/unmatched`, bù tay ở trang chi tiết người dùng.

**Đổi giá/gói mà người dùng vẫn thấy giá cũ**
Giá gói và hạn mức lấy từ DB sau lần chạy đầu tiên. Sửa tại `/admin/plans`; biến `.env` chỉ
dùng khi bảng `plans` còn trống.

**Mất dữ liệu sau khi chạy từ thư mục khác**
DB được mở theo `./data` của **thư mục hiện hành**. Luôn chạy `npm start` từ gốc dự án.

**Bị chặn 429 dù chỉ đăng nhập admin một mình**
Có thể đã chạm giới hạn toàn cục 60 lượt/10 phút (dùng chung cho mọi IP). Chờ hết cửa sổ
10 phút rồi thử lại; bộ đếm nằm trong bộ nhớ nên restart server cũng xoá được.
