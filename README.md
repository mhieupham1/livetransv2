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
- API key chỉ tồn tại ở backend.

## Chạy trên máy

Yêu cầu Node.js 20 trở lên.

```bash
npm install
cp .env.example .env
```

Mở `.env` và điền một API key mới:

```dotenv
LLM_BASE_URL=http://localhost:3000
LLM_API_KEY=replace-with-a-new-key
LLM_MODEL=gpt-5-6-mini
TRANSCRIPTION_MODEL=soniox-stt
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

Ứng dụng gửi chunk WebM/Opus khoảng mỗi 250ms qua `/v1/audio/transcriptions/realtime` và hiển thị transcript tạm thời trong lúc người dùng nói. Sau khoảng 1.200ms im lặng, ứng dụng commit đoạn audio, nhận transcript cuối cùng và bắt đầu lượt mới. API key chỉ được backend dùng để mở WebSocket upstream và không được gửi xuống trình duyệt.
