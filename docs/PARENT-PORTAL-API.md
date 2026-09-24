# TÀI LIỆU CỔNG API TRA CỨU PHỤ HUYNH (PARENT PORTAL GATEWAY)
Phiên bản: **v2.0.1**  
Hệ thống cung cấp: `app.camerangochoang.com` (KeystoneJS Backend `sme2`)  
Đối tượng tích hợp: Đội ngũ phát triển App Phụ huynh (`camerangochoang.com`)

---

## 1. THÔNG TIN KẾT NỐI
- **Base URL:** `https://api2.camerangochoang.com` (hoặc domain backend nội bộ)
- **Authentication Header:** `x-portal-token: camerangochoang_portal_secret_2026`
- **Content-Type:** `application/json`

---

## 2. API 1: Tra cứu thông tin Phụ huynh, Học sinh, Học phí, VietQR & Thông báo

### **Endpoint:**
`POST /api/portal/parent-summary`

### **Request Body:**
```json
{
  "phone": "0912345678"
}
```
*(Hệ thống hỗ trợ cả định dạng `0912345678` hoặc `84912345678`)*

### **Response (Thành công - HTTP 200):**
```json
{
  "success": true,
  "data": {
    "parent": {
      "id": "64df...",
      "code": "PH000920",
      "name": "Nguyễn Văn A",
      "phone": "0912345678",
      "debt": 3250000,
      "balance": 0,
      "isPaid": false
    },
    "students": [
      {
        "id": "64ef...",
        "name": "Nguyễn Minh Khang",
        "status": "DANG_HOC",
        "className": "Lớp Mầm 1",
        "classId": "64aa..."
      }
    ],
    "vietqr": {
      "bankName": "ACB",
      "accountNo": "77229966",
      "accountName": "TRUONG MAM NON NGOC HOANG",
      "transferContent": "PH000920",
      "amount": 3250000,
      "qrImageUrl": "https://img.vietqr.io/image/ACB-77229966-print.png?accountName=TRUONG%20MAM%20NON%20NGOC%20HOANG&addInfo=PH000920&amount=3250000"
    },
    "latestInvoice": {
      "id": "65bc...",
      "code": "HD001050",
      "total": 3250000,
      "studentName": "Nguyễn Minh Khang",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "items": [
        { "name": "Tiền học phí", "total": 2000000, "quantity": 1 },
        { "name": "Tiền ăn 22 ngày", "total": 1100000, "quantity": 22 },
        { "name": "Tiền camera", "total": 150000, "quantity": 1 }
      ]
    },
    "notifications": [
      {
        "id": "65cc...",
        "code": "TB00001",
        "title": "Thông báo thu học phí Tháng 10/2026",
        "content": "Kính gửi Quý Phụ huynh, nhà trường xin gửi thông báo kết sổ học phí...",
        "publishedAt": "2026-09-24T08:00:00.000Z"
      }
    ],
    "paymentHistory": [
      {
        "code": "STL000015",
        "amount": 3250000,
        "settledAt": "2026-08-15T09:30:00.000Z",
        "method": "Chuyển khoản ACB",
        "note": "Gạch nợ cho Hóa đơn HD000980 (3.250.000 đ)"
      }
    ]
  }
}
```

---

## 3. API 2: Webhook tiếp nhận biến động số dư ACB (Dành cho Bot / Webhook Ngân hàng)

### **Endpoint:**
`POST /api/portal/acb-webhook`

### **Request Body:**
```json
{
  "amount": 3250000,
  "description": "NGUYEN VAN A CHUYEN TIEN PH000920 THANG 10",
  "bankRef": "ACB123456789"
}
```

### **Quy tắc xử lý tự động:**
1. Hệ thống tự động bóc tách Regex `PH\d{4,8}` để tìm Phụ huynh (`PH000920`).
2. Tự động nạp dòng tiền `CashTransaction` (Số tiền `+3.250.000 đ`).
3. Tự động cấn trừ vào hóa đơn chưa thu của phụ huynh và tạo `PaymentSettlement` có lưu log.
4. Ngay khi giao dịch hoàn tất, phụ huynh tra cứu lại API 1 sẽ thấy ngay `"isPaid": true` và `"debt": 0`.
