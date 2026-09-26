# TÀI LIỆU CỔNG API TRA CỨU PHỤ HUYNH & HỌC SINH (PARENT PORTAL GATEWAY)
Phiên bản: **v2.1.0**  
Hệ thống cung cấp: `app.camerangochoang.com` (KeystoneJS Backend `sme2`)  
Đối tượng tích hợp: Đội ngũ phát triển App Phụ huynh (`camerangochoang.com`)

---

## 1. THÔNG TIN KẾT NỐI CHUNG
- **Base URL:** `https://demo3.cameramamnon.com` (hoặc domain Production)
- **Authentication Header:** `x-portal-token: camerangochoang_portal_secret_2026`
- **Content-Type:** `application/json`

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
        "status": "DANG_HOC",
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
        "code": "CT000014",
        "amount": 5000,
        "settledAt": "2026-09-27T00:04:03.000Z",
        "method": "Chuyển khoản ACB",
        "note": "Nạp tiền vào ví phụ huynh"
      }
    ]
  }
}
```

---

## 3. CÁC QUY ƯỚC QUAN TRỌNG CHO ĐỘI PHÁT TRIỂN APP MOBILE / FRONTEND

1. **Hiển thị Số dư nợ và Số dư ví:**
   - `parent.debt`: Nợ cần đóng. Nếu `parent.debt === 0`, hiển thị nhãn **"Đã hoàn thành học phí"**.
   - `parent.balance`: Số dư ví học phí của phụ huynh trong trường. Số tiền này có thể dùng để cấn trừ tự động cho các kỳ hóa đơn sau.
2. **Cú pháp chuyển khoản chuẩn:**
   - Luôn sử dụng `vietqr.transferContent` (chính là mã `PHxxxxxx` của phụ huynh). Không tự ý chèn thêm ký tự lạ để đảm bảo bot ACB / MONA Pay gạch nợ tự động trong 3 giây.
3. **Danh sách giáo viên & thông tin trẻ:**
   - Hiển thị thông tin lớp học và các cô giáo phụ trách trong mảng `teachers` của từng bé.
   - Trường `note` (`Student.luuy`) hiển thị lưu ý sức khỏe/dinh dưỡng của bé.
