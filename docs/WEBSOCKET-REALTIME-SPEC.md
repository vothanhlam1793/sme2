# ĐẶC TẢ GIAO THỨC WEBSOCKET REALTIME CHO APP PHỤ HUYNH
Phiên bản: **v2.1.0**  
Hệ thống: `app.camerangochoang.com` (KeystoneJS Backend `sme2`)  
Module: `routes/wsHub.js`

---

## 1. TỔNG QUAN KIẾN TRÚC & HANDSHAKE AUTHENTICATION

WebSocket Hub phục vụ kết nối thời gian thực 2 chiều giữa Hệ thống quản lý trường và Ứng dụng Phụ Huynh, đảm bảo khi có biến động tài chính (nạp tiền ngân hàng, gạch nợ), xuất bản học phí, điểm danh hoặc thông báo mới thì điện thoại phụ huynh sẽ nhận được ngay lập tức.

### 1.1 Thông tin cổng & Đường dẫn kết nối
- **URL WebSocket:** `wss://demo3.cameramamnon.com/ws/parent` (hoặc cổng trực tiếp `ws://IP:3013`)
- **Cơ chế xác thực Handshake:**
  Phụ huynh kết nối qua URL query parameters:
  ```text
  wss://demo3.cameramamnon.com/ws/parent?phone=<SO_DIEN_THOAI>&ts=<UNIX_TIMESTAMP>&sig=<SIGNATURE>
  ```
  - `phone`: Số điện thoại phụ huynh (ví dụ `0933064964`).
  - `ts`: Thời gian hiện tại tính bằng giây (`Math.floor(Date.now() / 1000)`). Vé có hiệu lực trong 300 giây (5 phút).
  - `sig`: Chữ ký xác thực bảo mật tính bằng thuật toán HMAC SHA256:
    ```javascript
    sig = crypto.createHmac('sha256', PORTAL_SECRET).update(`${phone}:${ts}`).digest('hex');
    ```

### 1.2 Handshake Lifecycle
1. **Kết nối thành công:** Máy chủ trả về sự kiện `AUTH_SUCCESS` kèm toàn bộ thông tin hồ sơ phụ huynh và số dư ban đầu:
   ```json
   {
     "type": "AUTH_SUCCESS",
     "message": "Kết nối phòng thông báo phụ huynh thành công",
     "parent": {
       "id": "664c6ec53e8b1e0024b4f368",
       "code": "PH000566",
       "name": "PH Phan Ngọc Quỳnh Như",
       "phone": "0933064964",
       "debt": 0,
       "balance": 960000
     }
   }
   ```
2. **Heartbeat / Keep-alive:** Client gửi `{"type": "ping"}` định kỳ mỗi 25-30 giây; Máy chủ phản hồi `{"type": "pong"}` để giữ kết nối qua các hạ tầng NAT/Proxy/Cloudflare.

---

## 2. DANH MỤC CÁC SỰ KIỆN REALTIME (EVENT CATALOG)

---

### Sự kiện 1: `PAYMENT_RECEIVED` (Tiền nạp vào ACB & Tự động gạch nợ thành công)
- **Mô tả:** Bắn ngay khi ACB / MONA Pay ghi nhận dòng tiền chuyển khoản từ phụ huynh, hệ thống tự động tăng ví và cấn trừ vào hóa đơn nợ.
- **Payload:**
  ```json
  {
    "type": "PAYMENT_RECEIVED",
    "title": "💵 Biến động số dư học phí",
    "message": "Đã nhận 5.000 đ qua Chuyển khoản ACB. Học phí đã được tự động thanh toán!",
    "data": {
      "transactionCode": "CT000014",
      "amount": 5000,
      "paymentMethod": "ACB_BANK",
      "description": "[ACB - 77229966] PH000566 FT26271207470414",
      "settledAmount": 0,
      "remainingDebt": 0,
      "remainingBalance": 960000,
      "receivedAt": "2026-09-27T00:04:03Z"
    }
  }
  ```
- **Hành động khuyến nghị cho App Mobile:**
  - Cập nhật số dư hiển thị `debt` và `balance` trên màn hình ngay lập tức mà không cần gọi lại API.
  - Bật thông báo Toast hoặc popup chúc mừng.
  - Đổi trạng thái phiếu thu từ "Chờ thanh toán" sang "Đã thanh toán".

---

### Sự kiện 2: `INVOICE_PUBLISHED` (Nhà trường phát hành phiếu thu / kết sổ học phí mới)
- **Mô tả:** Bắn khi kế toán bấm chốt kết sổ tháng hoặc tạo mới hóa đơn học phí cho học sinh.
- **Payload:**
  ```json
  {
    "type": "INVOICE_PUBLISHED",
    "title": "📋 Thông báo học phí tháng mới",
    "message": "Nhà trường đã gửi phiếu thu học phí cho bé Phan Ngọc Quỳnh Như (Lớp Chồi 3)",
    "data": {
      "invoiceId": "65bc1234...",
      "invoiceCode": "HD001050",
      "studentName": "Phan Ngọc Quỳnh Như",
      "className": "Chồi 3",
      "totalAmount": 3175000,
      "vietqrUrl": "https://img.vietqr.io/image/ACB-77229966-print.png?...",
      "items": [
        { "name": "Tiền học phí tháng 09/2026", "quantity": 1, "total": 2000000 },
        { "name": "Tiền ăn bán trú (22 ngày)", "quantity": 22, "total": 1100000 },
        { "name": "Tiền camera", "quantity": 1, "total": 75000 }
      ]
    }
  }
  ```
- **Hành động khuyến nghị cho App Mobile:**
  - Tăng số lượng thông báo chưa đọc (`badge++`).
  - Đưa hóa đơn mới lên đầu danh sách tra cứu kèm nút bấm mở Modal VietQR thanh toán nhanh.

---

### Sự kiện 3: `ATTENDANCE_UPDATE` (Điểm danh đến lớp / Báo về)
- **Mô tả:** Bắn khi giáo viên chủ nhiệm hoàn tất điểm danh sáng hoặc ghi nhận trả trẻ buổi chiều.
- **Payload:**
  ```json
  {
    "type": "ATTENDANCE_UPDATE",
    "title": "🏫 Điểm danh lớp học",
    "message": "Bé Phan Ngọc Quỳnh Như đã có mặt tại Lớp Chồi 3",
    "data": {
      "studentId": "664c6ec53e8b1e0024b4f36e",
      "studentName": "Phan Ngọc Quỳnh Như",
      "className": "Chồi 3",
      "date": "2026-09-27",
      "status": "CO",
      "afternoonSnack": true,
      "checkinTime": "07:45"
    }
  }
  ```

---

### Sự kiện 4: `NEW_NOTIFICATION` (Thông báo tin tức chung / Lịch nghỉ)
- **Mô tả:** Bắn khi Ban Giám Hiệu gửi thông báo khẩn, lịch nghỉ lễ hoặc hoạt động ngoại khóa.
- **Payload:**
  ```json
  {
    "type": "NEW_NOTIFICATION",
    "title": "🎉 Thông báo nghỉ lễ 30/4 - 1/5",
    "message": "Kính gửi Quý Phụ huynh, nhà trường xin trân trọng thông báo lịch nghỉ...",
    "data": {
      "id": "65cc5678...",
      "code": "TB00002",
      "publishedAt": "2026-09-27T08:00:00Z"
    }
  }
  ```

---

## 3. MÃ NGUỒN MẪU TÍCH HỢP CLIENT (JAVASCRIPT / VUE / REACT NATIVE)

```javascript
class SchoolRealtimeClient {
  constructor(phone, getTicketEndpoint) {
    this.phone = phone;
    this.getTicketEndpoint = getTicketEndpoint;
    this.ws = null;
    this.reconnectTimer = null;
  }

  async connect() {
    try {
      const res = await fetch(`${this.getTicketEndpoint}?phone=${this.phone}`);
      const { wsUrl } = await res.json();
      
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('✅ [WebSocket] Đã kết nối thành công tới Trường Mầm Non Ngọc Hoàng');
        // Bắt đầu Heartbeat ping
        this.pingInterval = setInterval(() => {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        console.log('📩 [Realtime Event]:', msg);
        if (msg.type === 'PAYMENT_RECEIVED') {
          // Xử lý nạp tiền & gạch nợ thành công
          this.onPaymentReceived(msg.data);
        } else if (msg.type === 'INVOICE_PUBLISHED') {
          // Xử lý thông báo học phí mới
          this.onInvoicePublished(msg.data);
        }
      };

      this.ws.onclose = () => {
        clearInterval(this.pingInterval);
        console.warn('⚠️ [WebSocket] Mất kết nối, tự động kết nối lại sau 5s...');
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      };
    } catch (e) {
      console.error('❌ [WebSocket] Lỗi kết nối:', e);
      setTimeout(() => this.connect(), 5000);
    }
  }
}
```
