# Kết nối trường với hệ thống camera

## Luồng vận hành

1. Triển khai camera có `GET /api/school/parent` và hỗ trợ `createOnly`.
2. Triển khai backend có list `CameraIntegration` và router `/api/camera-integration`.
3. Triển khai frontend, mở **Cài đặt → Kết nối camera** (`/setup/camera`) bằng tài khoản `User.isAdmin`.
4. Nhập HTTPS origin của camera và API key, kiểm tra kết nối, chọn mapping lớp rồi lưu.
5. Ở hồ sơ phụ huynh, dùng nút tạo/đồng bộ cạnh từng SĐT. Khi tạo mới, username = SĐT chuẩn hóa, PIN tạm ngẫu nhiên 4 số, trạng thái RESET.
6. Khi mapping hoặc lớp/trạng thái học sinh thay đổi, bấm đồng bộ ở từng SĐT hoặc đồng bộ tài khoản đã cấp trên trang cài đặt. Chưa có đồng bộ tự động theo sự kiện.

## Quy tắc

- Lấy dữ liệu Phone → Parent → Student → LopHoc tại backend; chỉ lấy học sinh `DANG_HOC`. Hồ sơ Parent `DEACTIVE` không có lớp đủ điều kiện.
- Hợp danh sách lớp của các bé, loại trùng. Nếu một bé đang học chưa có lớp hoặc chưa mapping, chặn đồng bộ toàn tài khoản với thông báo cụ thể.
- Mapping lưu ID lớp trường → ID lớp camera; một lớp trường chọn một lớp camera. Nhiều lớp trường có thể cùng map một lớp camera.
- Đồng bộ thay thế toàn bộ lớp camera bằng kết quả tính từ trường; không sửa PIN hay trạng thái khóa tài khoản đã tồn tại.
- Giữ nguyên trạng thái tạm ngưng camera. Không còn bé đang học: chỉ gọi `toggle-active` với `active: false`, giữ nguyên lớp đã gán, PIN và trạng thái tài khoản; không gọi đồng bộ lớp. Khi có bé học lại, đồng bộ lớp rồi bật camera bằng nút riêng.
- Bulk chỉ cập nhật tài khoản đã tồn tại, không tạo hàng loạt. Hiển thị tiến độ/lỗi từng số. Chạy tuần tự; giữ trang mở đến khi hoàn tất.
- Lưu mapping chưa cập nhật tài khoản; cần thao tác đồng bộ riêng.
- API key nằm trong list riêng bị chặn read/create/update/delete qua GraphQL thông thường; management router có xác thực session và quyền admin mới dùng context hệ thống. API trả `apiKeyConfigured`, không trả key.
- Đổi địa chỉ camera yêu cầu nhập key mới. HTTPS xác minh TLS, không theo redirect, timeout 10 giây và giới hạn phản hồi 1 MiB.

## Kiểm tra local không dùng dữ liệu thật

```sh
node --test scripts/cameraIntegration.test.js
```

Trước triển khai live cần kiểm tra bằng tài khoản thử: mapping thật, lớp nhiều con, cấp PIN/đổi PIN, bật/tắt camera và chuyển lớp. Test mock không xác nhận deployment hay thông tin kết nối thật.
