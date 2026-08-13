# Phiên Dịch realtime

Ứng dụng web phiên dịch hội thoại trực tiếp giữa tiếng Việt, tiếng Anh và tiếng Nhật.

## Tính năng

- Ghi WebM/Opus trong trình duyệt, tự chia câu theo khoảng lặng và nhận dạng bằng Whisper-compatible API.
- Dịch streaming qua API tương thích OpenAI.
- Phiên dịch một chiều hoặc hai chiều giữa Việt, Anh và Nhật.
- Điều khiển session với thời lượng, tạm dừng và kết thúc.
- Đọc bản dịch bằng giọng nói của trình duyệt.
- Từ khóa/ngữ cảnh để dịch chính xác thuật ngữ và tên riêng.
- Xuất transcript và tạo biên bản AI sau cuộc trò chuyện.
- Nhập nội dung bằng bàn phím khi trình duyệt không hỗ trợ nhận dạng giọng nói.
- Lưu tối đa 100 lượt hội thoại gần nhất trong trình duyệt.
- API key chỉ tồn tại ở backend.

## Chạy trên máy

Yêu cầu Node.js 20 trở lên.

```bash
npm install
cp .env.example .env
```

Mở `.env` và điền một API key mới:

```dotenv
LLM_BASE_URL=http://localhost:8001
LLM_API_KEY=replace-with-a-new-key
LLM_MODEL=gpt-5-5-mini
TRANSCRIPTION_MODEL=whisper-1
PORT=3001
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

## Kiểm tra mã nguồn

```bash
npm run check
npm run build
```

## Lưu ý về micro

Ghi âm WebM/Opus hoạt động tốt nhất trên Chrome, Edge và Firefox. Micro chỉ dùng được trên `localhost` hoặc website chạy HTTPS. Nếu trình duyệt không hỗ trợ MediaRecorder WebM, ô nhập tay vẫn hoạt động bình thường.

Ứng dụng tự kết thúc một đoạn sau khoảng 700ms im lặng và gửi file tới `/v1/audio/transcriptions`. Đây là near-realtime theo lượt nói, không trả transcript tạm thời theo từng từ.
