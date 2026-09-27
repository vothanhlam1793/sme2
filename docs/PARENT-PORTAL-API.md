# TÀI LIỆU CỔNG API TRA CỨU PHỤ HUYNH & HỌC SINH (PARENT PORTAL GATEWAY)
Phiên bản: **v2.1.0**  
Hệ thống cung cấp: `app.camerangochoang.com` (KeystoneJS Backend `sme2`)  
Đối tượng tích hợp: Đội ngũ phát triển App Phụ huynh (`camerangochoang.com`)

---

## 1. THÔNG TIN KẾT NỐI CHUNG
- **Base URL:** `https://demo3.cameramamnon.com` (hoặc domain Production)
- **Authentication Header:** `x-portal-token: <PARENT_PORTAL_SECRET>`
- **Content-Type:** `application/json`
- **Server-to-server only:** Backend của App gọi API này; không đưa secret vào trình duyệt, ứng dụng mobile, URL hoặc mã nguồn client. Backend tích hợp phải xác thực người dùng và quyền truy cập số điện thoại trước khi gọi.

---

## 2. API 1: Tra cứu thông tin Phụ huynh, Trẻ, Học phí, VietQR & Thông báo

### **Endpoint:**
`POST /api/portal/parent-summary`

### **Request Body:**
```json
{
  "phone": "0933064964"
}
```
*(Hệ thống hỗ trợ tự động chuẩn hóa định dạng `0933064964`, `84933064964`, `+84933064964` hoặc chuỗi có khoảng trắng/dấu chấm)*

### **Response Structure (HTTP 200 - Thành công):**
```json
{
  "success": true,
  "data": {
    "parent": {
      "id": "664c6ec53e8b1e0024b4f368",
      "code": "PH000566",
      "name": "PH Phan Ngọc Quỳnh Như",
      "phone": "0933064964",
      "debt": 0,
      "balance": 960000,
      "isPaid": true
    },
    "students": [
      {
        "id": "664c6ec53e8b1e0024b4f36e",
        "name": "Phan Ngọc Quỳnh Như",
        "birthday": "2021-05-20T17:00:00.000Z",
        "status": null,
        "note": "Dị ứng phấn hoa, ăn nhạt",
        "tuitionDiscount": "0",
        "className": "Chồi 3",
        "classId": "642f82029a34bd0026c03842",
        "teachers": [
          {
            "id": "6436042fcc96d40024f66bd1",
            "name": "Cô Nguyễn Thị Mai",
            "phone": "0901234567"
          }
        ]
      }
    ],
    "vietqr": {
      "bankName": "ACB",
      "accountNo": "77229966",
      "accountName": "TRUONG MAM NON NGOC HOANG",
      "transferContent": "PH000566",
      "amount": 0,
      "qrImageUrl": "https://img.vietqr.io/image/ACB-77229966-print.png?accountName=TRUONG%20MAM%20NON%20NGOC%20HOANG&addInfo=PH000566"
    },
    "latestInvoice": {
      "id": "65bc1234...",
      "code": "HD001050",
      "total": 3175000,
      "studentName": "Phan Ngọc Quỳnh Như",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "items": [
        { "name": "Tiền học phí tháng 09/2026", "quantity": 1, "total": 2000000 },
        { "name": "Tiền ăn bán trú (22 ngày)", "quantity": 22, "total": 1100000 },
        { "name": "Tiền camera", "quantity": 1, "total": 75000 }
      ]
    },
    "notifications": [
      {
        "id": "65cc5678...",
        "code": "TB00001",
        "title": "Thông báo thu học phí Tháng 10/2026",
        "content": "Kính gửi Quý Phụ huynh, nhà trường xin gửi thông báo kết sổ...",
        "publishedAt": "2026-09-24T08:00:00.000Z"
      }
    ],
    "paymentHistory": [
      {
        "code": "STL000014",
        "amount": 5000,
        "settledAt": "2026-09-27T00:04:03.000Z",
        "method": "Chuyển khoản ACB",
        "note": "Thanh toán công nợ"
      }
    ]
  }
}
```

---

## 3. CÁC QUY ƯỚC QUAN TRỌNG CHO ĐỘI PHÁT TRIỂN APP MOBILE / FRONTEND

1. **Hiển thị Số dư nợ và Số dư ví:**
    - `parent.debt`: Nợ tổng hợp hiện tại; `parent.isPaid` được tính bằng `debt <= 0`. Có thể hiển thị **"Không còn nợ hiện tại"**, không suy ra trạng thái thanh toán của từng hóa đơn.
   - `parent.balance`: Số dư ví học phí của phụ huynh trong trường. Số tiền này có thể dùng để cấn trừ tự động cho các kỳ hóa đơn sau.
2. **Cú pháp chuyển khoản chuẩn:**
    - Luôn sử dụng `vietqr.transferContent` (mã phụ huynh) để hỗ trợ đối soát. Không có cam kết thời gian xử lý; nhận tiền không đồng nghĩa mọi hóa đơn đã được thanh toán.
3. **Danh sách giáo viên & thông tin trẻ:**
   - Hiển thị thông tin lớp học và các cô giáo phụ trách trong mảng `teachers` của từng bé.
    - Trường `note` (`Student.luuy`) hiển thị lưu ý sức khỏe/dinh dưỡng của bé.
    - `students` giữ nguyên cấu trúc tương thích ở ví dụ trên. `status` trả về giá trị nguồn; nếu thiếu hoặc rỗng thì trả `null` (chưa xác định), không tự gán `DANG_HOC`.
4. **Phạm vi dữ liệu:**
    - `latestInvoice`: Hóa đơn mới nhất theo `createdAt` của phụ huynh, hoặc `null`; không chứa trạng thái đã thanh toán từng hóa đơn.
    - `notifications`: Lấy 10 thông báo `PUBLISHED` mới nhất rồi lọc toàn trường/lớp của trẻ; không phải toàn bộ lịch sử thông báo.
    - `paymentHistory`: Tối đa 5 bản ghi `PaymentSettlement` có trạng thái `SUCCESS`, sắp xếp `settledAt` giảm dần (mã `STL`). Không phải lịch sử dòng tiền `CashTransaction` (mã `CT`); nạp ví chưa phát sinh settlement có thể không xuất hiện. `AUTO_ACB` được hiển thị là `Chuyển khoản ACB`, các loại khác là `Thanh toán trực tiếp` theo ánh xạ hiện tại.

## 4. LỖI TRA CỨU

Các phản hồi lỗi có `success: false` và `message`:
- **400:** Thiếu số điện thoại.
- **401:** Thiếu hoặc sai portal token.
- **404:** Truy vấn thành công nhưng không có bản ghi điện thoại hoặc không liên kết phụ huynh.
- **500:** Lỗi máy chủ/GraphQL, kể cả GraphQL trả dữ liệu một phần kèm `errors`. Không diễn giải lỗi này thành "không tìm thấy" hoặc dữ liệu lịch sử rỗng. Phản hồi hiện tại có thêm trường `error`.

Sau `PAYMENT_RECEIVED`, backend tích hợp nên tra cứu lại summary để đồng bộ. Sự kiện không chứng minh mọi hóa đơn đã được trả đủ; xem [đặc tả WebSocket](WEBSOCKET-REALTIME-SPEC.md).
