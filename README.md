# Phiên Dịch realtime

Ứng dụng web phiên dịch hội thoại trực tiếp giữa tiếng Việt, tiếng Anh và tiếng Nhật.

## Tính năng

- Ghi WebM/Opus trong trình duyệt, truyền audio theo WebSocket và hiển thị transcript tạm thời bằng dịch vụ STT realtime.
- Tự chia lượt nói theo khoảng lặng, nhận diện ngôn ngữ và chuyển câu vào đúng khung Việt, Anh hoặc Nhật.
- Tự động dùng lại endpoint HTTP transcription nếu kết nối realtime bị lỗi hoặc timeout.
- Dịch streaming qua API tương thích OpenAI.
- Phiên dịch một chiều hoặc hai chiều giữa Việt, Anh và Nhật.
- Điều khiển session với thời lượng, tạm dừng và kết thúc.
- Đọc bản dịch bằng giọng nói của trình duyệt.
- Từ khóa/ngữ cảnh để dịch chính xác thuật ngữ và tên riêng.
- Xuất transcript và tạo biên bản AI sau cuộc trò chuyện.
- Nhập nội dung bằng bàn phím khi trình duyệt không hỗ trợ nhận dạng giọng nói.
- Lưu tối đa 100 lượt hội thoại gần nhất trong trình duyệt.
- Đăng nhập Google, hạn mức dùng thử và nâng cấp Pro bằng VietQR.
- Trang quản trị `/admin` để xem người dùng, chỉnh gói/hạn mức và theo dõi đơn hàng.
- API key chỉ tồn tại ở backend.

## Chạy trên máy

Yêu cầu Node.js 20 trở lên.

```bash
npm install
cp .env.example .env
```

Mở `.env` và điền các giá trị bắt buộc — xem chú thích trong [`.env.example`](.env.example):

```dotenv
LLM_API_KEY=replace-with-llm-key
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
SESSION_SECRET=replace-with-long-random-string
PORT=3001
```

Tạo tài khoản quản trị (xem [Trang quản trị](#trang-quản-trị)):

```bash
npm run seed
```

Khởi động chế độ phát triển:

```bash
npm run dev
```

Sau đó mở <http://localhost:5173>. Backend chạy tại <http://localhost:3001>.

## Chạy production

```bash
npm run build
npm start
```

Sau khi build, backend phục vụ cả API và giao diện tại <http://localhost:3001>.

### Đưa ra Internet bằng Cloudflare Tunnel

`npm run public` build rồi chạy app cùng `cloudflared` dùng file `cloudflared.yml`.
File đó chứa đường dẫn credentials riêng của máy nên không được commit — tạo từ bản mẫu:

```bash
cp cloudflared.example.yml cloudflared.yml   # điền tunnel ID và đường dẫn credentials
npm run public
```

## Trang quản trị

Trang quản trị dùng tài khoản/mật khẩu riêng, tách hẳn khỏi đăng nhập Google của người dùng.
Tài khoản được lưu trong bảng `admin_accounts` của SQLite nên dùng được cho nhiều người quản trị,
không cần restart server khi đổi mật khẩu. Tạo tài khoản mặc định:

```bash
npm run seed
```

Script in ra mật khẩu ngẫu nhiên **một lần duy nhất** (server chỉ lưu hash scrypt). Chạy lại
`npm run seed` sẽ không ghi đè mật khẩu đã có. Các lựa chọn khác:

```bash
npm run seed -- --reset admin              # đặt lại mật khẩu cho tài khoản đã có
npm run seed -- --username boss            # tạo tài khoản với tên khác
SEED_ADMIN_PASSWORD=<mật-khẩu> npm run seed  # tự chọn mật khẩu (tối thiểu 12 ký tự)
```

Mở <http://localhost:3001/admin> (hoặc `/admin` khi chạy `npm run dev`). Phiên admin dùng cookie
riêng, hết hạn sau 8 giờ; đổi mật khẩu sẽ thu hồi mọi phiên cũ của tài khoản đó. Sau 10 lần
đăng nhập sai từ cùng một IP, đăng nhập bị chặn 10 phút.

Trang quản trị cho phép:

- Xem thống kê người dùng, doanh thu, đơn đang chờ.
- Tìm kiếm, phân trang danh sách người dùng và mức sử dụng.
- Đổi gói, đặt tổng hạn mức (giây, `0` = không giới hạn) và đặt lại thời gian đã dùng.
- Xem đơn nâng cấp của từng người dùng.
- Theo dõi doanh thu theo ngày tại `/admin/revenue`.
- Quản lý gói cước tại `/admin/plans`.
- Cấu hình tài khoản nhận tiền VietQR và khóa Sepay tại `/admin/settings`.

### Gói cước và hạn mức

Hạn mức được tính theo **kỳ tháng** (bắt đầu 00:00 ngày 1 hằng tháng, giờ máy chủ). Mỗi
request đầu tiên trong tháng mới sẽ tự làm mới hạn mức — không cần job nền.

Có hai loại gói trong bảng `plans`, sửa tại `/admin/plans`:

| Loại | Cách hoạt động |
|---|---|
| **Thuê bao** (`subscription`) | Đổi gói người dùng, đặt lại kỳ và cấp hạn mức tháng mới |
| **Một lần** (`event`) | Cộng thêm thời gian vào `bonus_seconds`, không đổi gói, không hết hạn theo tháng |

Thời gian mua thêm được cộng dồn: mua 2 lần là 2 lần cộng. Hạn mức tháng được dùng trước,
hết mới đến phần mua thêm. Đặt `monthly_seconds = 0` để tạo gói không giới hạn.

Giao diện người dùng có:

- Bấm vào badge hạn mức để mở bảng chọn gói và thanh toán VietQR.
- Banner cảnh báo khi còn dưới 5 phút; rung + thông báo khi còn dưới 1 phút.
- Mua thêm ngay giữa phiên mà không phải thoát ra.

Dịch văn bản (translation/biên bản) cũng trừ hạn mức: **100 ký tự = 1 giây**, đổi bằng
`TRANSLATE_CHARS_PER_SECOND`.

### Cấu hình VietQR

Tài khoản nhận tiền, giá nâng cấp và khóa webhook Sepay được lưu trong bảng `settings`
của SQLite, sửa trực tiếp tại `/admin/settings`. **Đổi thông tin không cần restart server** —
đơn tạo sau khi lưu dùng ngay cấu hình mới.

Các biến `.env` tương ứng (`BANK_BIN`, `BANK_ACCOUNT`, `BANK_ACCOUNT_NAME`,
`UPGRADE_AMOUNT_VND`, `SEPAY_WEBHOOK_API_KEY`) chỉ là giá trị mặc định cho lần chạy đầu.
Sau khi lưu trên trang admin, DB là nguồn duy nhất; xóa cấu hình trong DB sẽ quay lại `.env`.
Khóa Sepay không bao giờ được gửi xuống trình duyệt.

Mọi API `/api/admin/*` đều kiểm tra cookie admin ở server; sau 10 lần đăng nhập sai từ cùng
một IP, việc đăng nhập bị chặn trong 10 phút. Trang admin không chia sẻ phiên với ứng dụng
phiên dịch, nên tài khoản quản trị không có quyền dùng micro/API của người dùng.

## Kiểm tra mã nguồn

```bash
npm run check
npm run build
```

## Lưu ý về micro

Ghi âm WebM/Opus hoạt động tốt nhất trên Chrome, Edge và Firefox. Micro chỉ dùng được trên `localhost` hoặc website chạy HTTPS. Nếu trình duyệt không hỗ trợ MediaRecorder WebM, ô nhập tay vẫn hoạt động bình thường.

Ứng dụng gửi chunk WebM/Opus khoảng mỗi 250ms qua `/v1/audio/transcriptions/realtime` và hiển thị transcript tạm thời trong lúc người dùng nói. Sau khoảng 1.200ms im lặng, ứng dụng commit đoạn audio, nhận transcript cuối cùng và bắt đầu lượt mới. API key chỉ được backend dùng để mở WebSocket upstream và không được gửi xuống trình duyệt.
