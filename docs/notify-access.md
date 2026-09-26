# HƯỚNG DẪN KỸ THUẬT TÍCH HỢP KÊNH THÔNG BÁO REALTIME (WEBSOCKET HUB)
**Dành cho đội ngũ phát triển App Phụ Huynh / Website `camerangochoang.com`**  
Phiên bản: **v2.1.0** — Hệ thống: **Mầm Non Ngọc Hoàng** (`demo3.cameramamnon.com`)

---

## 1. TỔNG QUAN KIẾN TRÚC & NGUYÊN TẮC BẢO MẬT

Hệ thống trường Mầm Non Ngọc Hoàng cung cấp kênh thông báo thời gian thực 2 chiều (WebSocket Realtime Push) phục vụ:
- Báo có tiền chuyển khoản ngân hàng / nạp ví ngay lập tức (< 100ms).
- Báo trạng thái gạch nợ học phí, số nợ còn lại (`debt`) và số dư ví khả dụng (`balance`).
- Báo phát hành phiếu báo học phí / kết sổ tháng mới kèm liên kết VietQR động.
- Báo trạng thái điểm danh bé đến lớp / đón về / suất ăn chiều.
- Thông báo chung từ ban giám hiệu nhà trường.

### Mô hình luồng xác thực an toàn (Zero-Trust Handshake)

```
[ App / Web Phụ Huynh (camerangochoang.com) ]
       │
       │ (1) User đăng nhập thành công bằng Số ĐT: 0933064964
       │ (2) Gửi Request nội bộ: GET /api/get-school-ws-ticket
       ▼
[ Backend Server camerangochoang.com ]
       │
       │ (3) Lấy API_KEY bí mật (được cấp từ Admin Trường Ngọc Hoàng)
       │ (4) Sinh Timestamp hiện tại: ts = Math.floor(Date.now() / 1000)
       │ (5) Tạo chữ ký: sig = HMAC-SHA256(API_KEY, "0933064964:1790318000")
       │ (6) Trả vé kết nối về cho Client: { wssUrl, phone, ts, sig }
       ▼
[ App / Web Phụ Huynh ]
       │
       │ (7) Mở kết nối WebSocket an toàn:
       │     wss://demo3.cameramamnon.com/ws/parent?phone=0933064964&ts=1790318000&sig=<sig>
       ▼
[ Nginx Gateway SSL SVR12 ]
       │
       │ (8) Upgrade Connection sang WebSocket RFC 6455
       │ (9) Chuyển tiếp vào Backend Trường Ngọc Hoàng (Port 3011)
       ▼
[ WebSocket Hub Backend Trường Ngọc Hoàng ]
       │
       │ (10) Kiểm tra Timestamp (Lệch không quá 300 giây để chống Replay Attack)
       │ (11) Xác minh chữ ký HMAC-SHA256 khớp với API Key trong DB
       │ (12) Khớp phụ huynh theo Số ĐT ➔ Gán vào Room riêng `parent_<ID>` và Room chung `school_all`
       │ (13) Bắn Frame xác nhận: { type: "AUTH_SUCCESS", parent: { code: "PH000891", name: "..." } }
```

---

## 2. THÔNG SỐ KẾT NỐI

- **WSS URL:** `wss://demo3.cameramamnon.com/ws/parent`
- **Giao thức:** Native WebSocket (RFC 6455)
- **Định dạng dữ liệu:** JSON UTF-8
- **Cơ chế xác thực:** Chữ ký HMAC-SHA256 qua URL Query Parameters
- **API Secret Key:** Được lấy trực tiếp trong trang quản trị Admin: **`https://demo3.cameramamnon.com/setup`** (Mục *Cổng Tích Hợp App Phụ Huynh*).
  - *Secret Key mặc định hiện tại:* `camerangochoang_portal_secret_2026`

---

## 3. HƯỚNG DẪN DÀNH CHO BACKEND `camerangochoang.com` (CẤP VÉ TICKET)

Backend của `camerangochoang.com` cần cung cấp 1 API nội bộ cho App/Web sau khi phụ huynh đăng nhập thành công.

### Quy cách sinh chữ ký (Signature Algorithm)
- **Chuỗi dữ liệu ký (Raw Data):** `${cleanPhone}:${timestamp}`  
  *(Ví dụ: `0933064964:1790318000`)*
- **Chuẩn hóa SĐT:** Chuỗi 10 chữ số bắt đầu bằng `0` (ví dụ `0933064964`). Nếu là `84933064964` chuyển thành `0933064964`.
- **Timestamp:** Unix Timestamp dạng giây (10 chữ số).
- **Thuật toán:** `HMAC-SHA256` với `API_KEY` bí mật, xuất kết quả dạng chuỗi `hex`.

### Code mẫu Backend:

#### A. Node.js (Express / NestJS)
```javascript
const crypto = require('crypto');

const PORTAL_API_KEY = process.env.SCHOOL_PORTAL_SECRET || 'camerangochoang_portal_secret_2026';
const SCHOOL_WS_URL = 'wss://demo3.cameramamnon.com/ws/parent';

app.get('/api/get-school-ws-ticket', (req, res) => {
  // Lấy số điện thoại phụ huynh từ session/JWT đăng nhập của bạn
  let phone = req.user.phone.replace(/\D/g, '');
  if (phone.startsWith('84')) phone = '0' + phone.slice(2);

  const timestamp = Math.floor(Date.now() / 1000);
  const rawData = `${phone}:${timestamp}`;
  const signature = crypto.createHmac('sha256', PORTAL_API_KEY).update(rawData).digest('hex');

  return res.json({
    success: true,
    data: {
      wsUrl: `${SCHOOL_WS_URL}?phone=${phone}&ts=${timestamp}&sig=${signature}`,
      phone: phone,
      timestamp: timestamp,
      signature: signature
    }
  });
});
```

#### B. PHP (Laravel / Native PHP)
```php
<?php
$portalApiKey = env('SCHOOL_PORTAL_SECRET', 'camerangochoang_portal_secret_2026');
$schoolWsUrl = 'wss://demo3.cameramamnon.com/ws/parent';

function getSchoolWsTicket($userPhone) {
    global $portalApiKey, $schoolWsUrl;
    
    // Chuẩn hóa SĐT
    $phone = preg_replace('/\D/', '', $userPhone);
    if (strpos($phone, '84') === 0) {
        $phone = '0' . substr($phone, 2);
    }
    
    $timestamp = time();
    $rawData = $phone . ':' . $timestamp;
    $signature = hash_hmac('sha256', $rawData, $portalApiKey);
    
    return [
        'wsUrl' => "{$schoolWsUrl}?phone={$phone}&ts={$timestamp}&sig={$signature}",
        'phone' => $phone,
        'timestamp' => $timestamp,
        'signature' => $signature
    ];
}
```

#### C. Python (FastAPI / Django)
```python
import time, hmac, hashlib, re

PORTAL_API_KEY = "camerangochoang_portal_secret_2026"
SCHOOL_WS_URL = "wss://demo3.cameramamnon.com/ws/parent"

def get_school_ws_ticket(user_phone: str):
    phone = re.sub(r'\D', '', user_phone)
    if phone.startswith('84'):
        phone = '0' + phone[2:]
        
    timestamp = int(time.time())
    raw_data = f"{phone}:{timestamp}".encode('utf-8')
    sig = hmac.new(PORTAL_API_KEY.encode('utf-8'), raw_data, hashlib.sha256).hexdigest()
    
    return {
        "wsUrl": f"{SCHOOL_WS_URL}?phone={phone}&ts={timestamp}&sig={sig}",
        "phone": phone,
        "timestamp": timestamp,
        "signature": sig
    }
```

---

## 4. HƯỚNG DẪN DÀNH CHO FRONTEND / MOBILE APP `camerangochoang.com`

### A. Code Mẫu JavaScript / Web (Vue, React, Native JS)

```javascript
class SchoolRealtimeClient {
  constructor(getTicketApiUrl) {
    this.getTicketApiUrl = getTicketApiUrl;
    this.ws = null;
    this.pingInterval = null;
    this.reconnectTimeout = null;
    this.isClosedManually = false;
  }

  async connect() {
    this.isClosedManually = false;
    try {
      // 1. Lấy vé kết nối từ backend camerangochoang.com
      const res = await fetch(this.getTicketApiUrl, {
        headers: { 'Authorization': 'Bearer ' + localStorage.getItem('access_token') }
      });
      const resData = await res.json();
      if (!resData.success) throw new Error('Không lấy được ticket kết nối');

      const { wsUrl } = resData.data;

      // 2. Mở kết nối WebSocket
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('✅ Đã kết nối WebSocket thành công tới Hệ thống Trường Ngọc Hoàng');
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleEvent(msg);
        } catch (e) {
          console.warn('Nhận message không phải JSON:', event.data);
        }
      };

      this.ws.onclose = (e) => {
        console.warn('⚠️ WebSocket đóng kết nối (Code:', e.code, e.reason, ')');
        this.stopHeartbeat();
        if (!this.isClosedManually) {
          // Tự động kết nối lại sau 3-5 giây
          this.reconnectTimeout = setTimeout(() => this.connect(), 4000);
        }
      };

      this.ws.onerror = (err) => {
        console.error('❌ Lỗi WebSocket:', err);
      };

    } catch (err) {
      console.error('Không thể kết nối WebSocket:', err);
      setTimeout(() => this.connect(), 5000);
    }
  }

  // Heartbeat định kỳ 30s để giữ kết nối qua tường lửa mạng 4G/WiFi
  startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.pingInterval) clearInterval(this.pingInterval);
  }

  // Xử lý các sự kiện nghiệp vụ từ trường bắn về
  handleEvent(msg) {
    switch (msg.type) {
      case 'AUTH_SUCCESS':
        console.log('Đã xác thực Phụ huynh:', msg.parent);
        break;

      case 'PAYMENT_RECEIVED':
        // Cập nhật số dư ví, đổi trạng thái học phí
        alert(`🔔 Tiền vào: +${msg.data.amount.toLocaleString()} đ! Số nợ còn: ${msg.data.remainingDebt.toLocaleString()} đ`);
        break;

      case 'INVOICE_PUBLISHED':
        // Thông báo học phí tháng mới
        console.log('Có hóa đơn học phí mới:', msg.data);
        break;

      case 'ATTENDANCE_UPDATE':
        // Điểm danh bé
        console.log('Cập nhật điểm danh bé:', msg.data);
        break;

      case 'SCHOOL_ANNOUNCEMENT':
        // Tin tức nhà trường
        console.log('Tin trường:', msg.data);
        break;

      case 'pong':
        // Phản hồi heartbeat
        break;
    }
  }

  disconnect() {
    this.isClosedManually = true;
    this.stopHeartbeat();
    if (this.ws) this.ws.close();
  }
}

// Khởi chạy khi phụ huynh mở app
const client = new SchoolRealtimeClient('/api/get-school-ws-ticket');
client.connect();
```

---

### B. Code Mẫu Mobile Flutter (Dart)

```dart
import 'dart:convert';
import 'dart:async';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class SchoolNotificationService {
  WebSocketChannel? _channel;
  Timer? _heartbeatTimer;

  void connect(String wsUrl) {
    try {
      _channel = IOWebSocketChannel.connect(Uri.parse(wsUrl));

      _channel!.stream.listen((message) {
        final data = jsonDecode(message);
        _handleMessage(data);
      }, onDone: () {
        _heartbeatTimer?.cancel();
        // Reconnect sau 5s
        Future.delayed(Duration(seconds: 5), () => connect(wsUrl));
      }, onError: (error) {
        print("Lỗi WebSocket: $error");
      });

      // Ping 30s
      _heartbeatTimer = Timer.periodic(Duration(seconds: 30), (timer) {
        _channel?.sink.add(jsonEncode({"type": "ping"}));
      });

    } catch (e) {
      print("Không thể kết nối: $e");
    }
  }

  void _handleMessage(Map<String, dynamic> msg) {
    final type = msg['type'];
    if (type == 'PAYMENT_RECEIVED') {
      print("Nhận thông báo đóng học phí thành công: ${msg['data']}");
    }
  }
}
```

---

## 5. ĐẶC TẢ CÁC SỰ KIỆN REALTIME (EVENT CATALOG)

### 1. `AUTH_SUCCESS` (Xác thực kết nối thành công)
Gửi ngay sau khi client mở kết nối thành công:
```json
{
  "type": "AUTH_SUCCESS",
  "message": "Kết nối kênh thông báo Trường Ngọc Hoàng thành công",
  "parent": {
    "id": "6a4da63fc4215b0008456410",
    "code": "PH000891",
    "name": "Vũ Kim Sơn (Bố Vũ Kim Bách)",
    "phone": "0933064964",
    "debt": 0,
    "balance": 100000
  },
  "connectedAt": "2026-09-25T08:30:00.000Z"
}
```

---

### 2. `PAYMENT_RECEIVED` (Tiền vào & Gạch nợ học phí)
Bắn realtime khi tiền ngân hàng ACB / MONA Pay chảy vào hoặc kế toán thu tiền:
```json
{
  "type": "PAYMENT_RECEIVED",
  "title": "Biến động dòng tiền / Đã nạp học phí",
  "data": {
    "transactionCode": "CT000007",
    "amount": 10000,
    "paymentMethod": "ACB_BANK",
    "description": "PH000891 chuyển tiền học phí",
    "settledAmount": 10000,
    "remainingDebt": 0,
    "remainingBalance": 100000,
    "receivedAt": "2026-09-25T08:32:00.000Z"
  }
}
```

---

### 3. `INVOICE_PUBLISHED` (Phát hành phiếu học phí mới)
Bắn khi trường chốt sổ kết toán học phí tháng:
```json
{
  "type": "INVOICE_PUBLISHED",
  "title": "Thông báo học phí Tháng 10/2026",
  "data": {
    "invoiceCode": "HD001050",
    "studentName": "Vũ Kim Bách",
    "className": "Lớp Mầm 1",
    "totalAmount": 3250000,
    "vietqrUrl": "https://img.vietqr.io/image/ACB-77229966-print.png?accountName=TRUONG%20MAM%20NON%20NGOC%20HOANG&addInfo=PH000891&amount=3250000"
  }
}
```

---

### 4. `ATTENDANCE_UPDATE` (Điểm danh bé)
Bắn khi giáo viên điểm danh đến lớp, về trễ, hoặc ăn chiều:
```json
{
  "type": "ATTENDANCE_UPDATE",
  "title": "Cập nhật điểm danh bé",
  "data": {
    "studentName": "Vũ Kim Bách",
    "status": "DA_DEN_LOP",
    "time": "07:45:00",
    "note": "Bé vào lớp vui vẻ"
  }
}
```

---

## 6. MÃ LỖI ĐÓNG KẾT NỐI (WEBSOCKET CLOSE CODES)

Khi kết nối bị từ chối, máy chủ sẽ đóng kết nối với các mã lỗi tiêu chuẩn:

| Mã lỗi | Lý do (`reason`) | Giải pháp khắc phục |
| :--- | :--- | :--- |
| **`4001`** | `ERR_INVALID_SIGNATURE` | Kiểm tra lại `API_KEY` bí mật giữa 2 server có khớp nhau không và định dạng chuỗi ký `${phone}:${timestamp}`. |
| **`4002`** | `ERR_TICKET_EXPIRED` | Đồng hồ giữa 2 server bị lệch quá 300 giây. Đồng bộ lại thời gian NTP trên máy chủ. |
| **`4003`** | `ERR_PARENT_NOT_FOUND` | Số điện thoại này chưa được đăng ký trong danh bạ phụ huynh trường Ngọc Hoàng. |
| **`4004`** | `ERR_PORTAL_DISABLED` | Cổng thông báo đang tạm tắt trong cài đặt Admin trường. |

---

*Mọi thắc mắc kỹ thuật trong quá trình tích hợp, vui lòng liên hệ bộ phận Kỹ thuật Hệ thống Trường Mầm Non Ngọc Hoàng.*
