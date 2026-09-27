# WEBSOCKET REALTIME CHO APP PHỤ HUYNH — HỢP ĐỒNG HIỆN TẠI

Nguồn đối chiếu: `routes/wsHub.js` và các điểm phát sự kiện trong `func/settlement.js`.

## 1. Kết nối và xác thực

- URL qua reverse proxy: `wss://<HOST>/ws/parent`.
- Hub chạy cổng riêng `WS_PORT` (mặc định `3013`); URL public phụ thuộc cấu hình proxy.
- Query: `?phone=<PHONE>&ts=<UNIX_SECONDS>&sig=<HMAC_HEX>`.
- Backend tích hợp xác thực người dùng/quyền truy cập phụ huynh trước khi cấp URL đã ký. Secret chỉ dùng server-to-server, không chuyển xuống browser/mobile.
- Chuẩn hóa `phone`: bỏ ký tự không phải chữ số, đổi đầu `84` thành `0`. Ký chuỗi `${cleanPhone}:${ts}` bằng HMAC SHA256, xuất hex:

```javascript
// Chỉ chạy trên backend tích hợp. Secret phải khớp config.api_key của Hub.
const secret = process.env.PARENT_PORTAL_SECRET; // <PORTAL_SECRET>
const sig = crypto.createHmac('sha256', secret)
  .update(`${cleanPhone}:${ts}`).digest('hex');
```

Hub đọc `PORTAL_GATEWAY_CONFIG`: `portal_enabled`, `api_key`, `ticket_ttl_seconds` (TTL mặc định 300 giây). Hub kiểm tra độ lệch tuyệt đối giữa timestamp và thời gian máy chủ. Tạo vé mới khi kết nối lại. Route cấp vé của backend tích hợp phải được triển khai riêng; không có endpoint cấp vé được định nghĩa trong `parentPortal.js`.

Xác thực thất bại: đóng socket mã `4001`; lỗi kết nối nội bộ được bắt: `1011`. Chờ `AUTH_SUCCESS`, không coi riêng `onopen` là đã xác thực.

## 2. Frame điều khiển hiện tại

`AUTH_SUCCESS` có cấu trúc riêng, không nằm trong envelope sự kiện nghiệp vụ:

```json
{
  "type": "AUTH_SUCCESS",
  "message": "Kết nối kênh thông báo Trường Ngọc Hoàng thành công",
  "parent": {
    "id": "parent-id",
    "code": "PH000566",
    "name": "Phụ huynh mẫu",
    "phone": "0901234567",
    "debt": 100000,
    "balance": 0,
    "students": [{ "id": "student-id", "name": "Bé mẫu", "className": "Chồi 3" }]
  },
  "connectedAt": "2026-09-27T00:04:03.000Z"
}
```

Heartbeat là JSON do client gửi (có thể mỗi 25–30 giây):

```json
{ "type": "ping" }
```

Hub phản hồi:

```json
{ "type": "pong", "time": 1790467443000 }
```

`time` là `Date.now()` tính bằng mili giây. Hub hiện không tự lên lịch ping hoặc ngắt socket theo timeout heartbeat. Client phải quản lý timeout, dọn timer và kết nối lại.

## 3. Envelope sự kiện nghiệp vụ

`sendToParent` và `broadcastAll` gửi đúng ba trường: `type`, `data`, `timestamp` (ISO 8601). Không có `title` hoặc `message` ở cấp ngoài do Hub tự thêm.

### `PAYMENT_RECEIVED` — đã có điểm phát

Phát tới phòng phụ huynh từ xử lý dòng tiền/gán dòng tiền trong settlement service. Ví dụ minh họa nhận tiền nhưng vẫn còn nợ:

```json
{
  "type": "PAYMENT_RECEIVED",
  "data": {
    "transactionCode": "CT000014",
    "amount": 5000,
    "paymentMethod": "ACB_BANK",
    "description": "PH000566",
    "settledAmount": 5000,
    "remainingDebt": 100000,
    "remainingBalance": 0,
    "receivedAt": "2026-09-27T00:04:03.000Z"
  },
  "timestamp": "2026-09-27T00:04:03.100Z"
}
```

- `amount` là số tiền nhận/gán; `settledAmount` là phần đã cấn trừ, có thể bằng 0.
- `remainingDebt` và `remainingBalance` là số dư tại thời điểm xử lý; không phải trạng thái từng hóa đơn.
- `transactionCode` là mã dòng tiền `CT`, không phải mã settlement `STL` trong `parent-summary.paymentHistory`.
- Không đổi tất cả hóa đơn sang "Đã thanh toán" khi nhận sự kiện. Backend tích hợp nên gọi lại summary để đồng bộ và dùng dữ liệu chi tiết hóa đơn nếu cần kết luận từng hóa đơn.
- Không cam kết xử lý trong 3 giây hoặc giao sự kiện tức thời. Hub chỉ gửi tới socket đang mở; chưa có ACK, lưu trữ/replay hoặc bảo đảm giao nhận. Sau kết nối lại, tải lại summary.

## 4. Dự kiến — chưa có điểm phát/API trong triển khai hiện tại

Các mục dưới đây là kế hoạch, không phải hợp đồng đã triển khai:

| Mục | Trạng thái |
| --- | --- |
| `INVOICE_PUBLISHED` | Dự kiến; chưa có điểm phát trong mã hiện tại. |
| `ATTENDANCE_UPDATE` | Dự kiến; chưa triển khai sự kiện điểm danh. |
| `NEW_NOTIFICATION` | Dự kiến; chưa có điểm phát. Summary hiện có danh sách thông báo giới hạn. |
| Lịch sử điểm danh, lịch sử sự kiện/replay qua WS | Dự kiến; chưa có API/frame yêu cầu hoặc phản hồi. |

Payload cho các mục dự kiến chưa được chốt. Lịch sử thanh toán REST hiện có chỉ là các settlement `SUCCESS` giới hạn trong [Parent Portal API](PARENT-PORTAL-API.md), không phải lịch sử đầy đủ dòng tiền hay WS.
