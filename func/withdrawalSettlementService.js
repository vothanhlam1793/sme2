const { gql } = require('apollo-server-express');
const { FeeDomain } = require('./feeDomain');
const SettlementService = require('./settlement');
const codeUtil = require('./code');

const BANK_CONFIG = {
  bankCode: process.env.VIETQR_BANK_CODE || 'ACB',
  accountNo: process.env.VIETQR_ACCOUNT_NO || '77229966',
  accountName: process.env.VIETQR_ACCOUNT_NAME || 'TRUONG MAM NON NGOC HOANG',
};

function generateVietQrUrl(addInfo, amount) {
  let url = `https://img.vietqr.io/image/${BANK_CONFIG.bankCode}-${BANK_CONFIG.accountNo}-compact2.png`;
  url += `?accountName=${encodeURIComponent(BANK_CONFIG.accountName)}`;
  url += `&addInfo=${encodeURIComponent(String(addInfo || '').toUpperCase())}`;
  if (amount && Number(amount) > 0) {
    url += `&amount=${Math.round(Number(amount))}`;
  }
  return url;
}

function getMonthRange(month, year) {
  const m = Number(month);
  const y = Number(year);
  const startDate = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return {
    startDate,
    endDate,
    startDateISO: startDate.toISOString(),
    endDateISO: endDate.toISOString(),
  };
}

class WithdrawalSettlementService {
  constructor(keystone) {
    this.keystone = keystone;
    this.feeDomain = new FeeDomain(keystone);
    this.ObjectId = keystone.lists?.Student?.adapter?.model?.db?.base?.Types?.ObjectId || require('mongoose').Types.ObjectId;
    this.collections = {
      Student: keystone.lists?.Student?.adapter?.model?.collection,
      Parent: keystone.lists?.Parent?.adapter?.model?.collection,
      LopHoc: keystone.lists?.LopHoc?.adapter?.model?.collection,
      DiemDanh: keystone.lists?.DiemDanh?.adapter?.model?.collection,
      Variable: keystone.lists?.Variable?.adapter?.model?.collection,
      Fee: keystone.lists?.Fee?.adapter?.model?.collection,
      PhieuKetSo: keystone.lists?.PhieuKetSo?.adapter?.model?.collection,
      ItemKetSo: keystone.lists?.ItemKetSo?.adapter?.model?.collection,
      HoaDon: keystone.lists?.HoaDon?.adapter?.model?.collection,
      CashTransaction: keystone.lists?.CashTransaction?.adapter?.model?.collection,
    };
  }

  id(val) {
    if (!val) return null;
    return new this.ObjectId(String(val));
  }

  /**
   * 1. XEM TRƯỚC QUYẾT TOÁN THÔI HỌC (PREVIEW)
   */
  async getWithdrawalPreview(context, { studentId, month, year }) {
    if (!studentId) throw new Error('Vui lòng chọn học sinh');
    const now = new Date();
    const curMonth = Number(month) || (now.getMonth() + 1);
    const curYear = Number(year) || now.getFullYear();
    const billingMonth = `${curYear}-${String(curMonth).padStart(2, '0')}`;
    const range = getMonthRange(curMonth, curYear);

    // 1. Lấy thông tin học sinh & Phụ huynh
    const student = await this.collections.Student.findOne({ _id: this.id(studentId) });
    if (!student) throw new Error('Không tìm thấy học sinh');

    let parent = null;
    if (student.parent) {
      parent = await this.collections.Parent.findOne({ _id: this.id(student.parent) });
    }

    let lophoc = null;
    if (student.lophoc) {
      lophoc = await this.collections.LopHoc.findOne({ _id: this.id(student.lophoc) });
    }

    // 2. Lấy đơn giá hệ số từ bảng Biến (Variables)
    const allVars = await this.collections.Variable.find({}).toArray();
    const varMap = {};
    for (const v of allVars) {
      if (v.key) varMap[v.key] = v.value;
    }

    const baseKey = student.namhocphi || 'HPN_2026';
    const studentBaseFee = Number(varMap[baseKey]) || 3000000;
    const studentDiscount = Number(student.hocphigiam) || 0;
    const netMonthlyTuition = Math.max(0, studentBaseFee - studentDiscount);
    const dailyTuitionStandard = Math.round(netMonthlyTuition / 22);

    const price545 = Number(varMap['PRICE_545']) || 15000;
    const priceVeTre = Number(varMap['PRICE_VETRE']) || 20000;
    const priceVeTre2 = Number(varMap['PRICE_VETRE2']) || 40000;

    // Kiểm tra đăng ký camera của bé
    const cameraVar = allVars.find(v => v.item === 'Student' && String(v.idItem) === String(student._id) && v.key === 'CAMERA');
    const hasCamera = cameraVar && (cameraVar.value === 'true' || cameraVar.value === '1' || cameraVar.value === true);
    const cameraAmount = hasCamera ? 50000 : 0;

    // 3. Đếm ngày điểm danh thực tế trong tháng
    const studentObjId = this.id(studentId);
    const diemdanhList = await this.collections.DiemDanh.find({
      date: { $gte: range.startDate, $lte: range.endDate },
      $or: [
        { co: studentObjId },
        { co: String(studentId) }
      ]
    }).toArray();

    let actualDays = 0;
    let anChieuCount = 0;
    let veTreCount = 0;
    let veTreAmount = 0;

    for (const dd of diemdanhList) {
      const type = (dd.type || '').toUpperCase();
      if (type.includes('545') || type.includes('ANCHIEU')) {
        anChieuCount += 1;
      } else if (type.includes('VETRE2')) {
        veTreCount += 1;
        veTreAmount += priceVeTre2;
      } else if (type.includes('VETRE')) {
        veTreCount += 1;
        veTreAmount += priceVeTre;
      } else {
        actualDays += 1;
      }
    }

    // Nếu điểm danh thông thường = 0 nhưng có điểm danh ăn chiều/về trễ thì lấy max
    if (actualDays === 0 && (anChieuCount > 0 || veTreCount > 0)) {
      actualDays = Math.max(anChieuCount, veTreCount);
    }
    // Mặc định hiển thị tối thiểu 1 ngày nếu chưa có dữ liệu điểm danh
    if (actualDays === 0) {
      actualDays = 10;
    }

    const actualTuition = Math.round((netMonthlyTuition / 22) * actualDays);
    const anChieuAmount = anChieuCount * price545;

    // 4. Kiểm tra tiền đã đóng của tháng này (qua Hóa Đơn hoặc Khoản phí Fee)
    let paidTuition = 0;
    let paidFacility = 0;

    // Tìm trong hóa đơn của tháng này
    const invoices = await this.collections.HoaDon.find({
      student: studentObjId,
      $or: [{ createdAt: { $gte: range.startDateISO, $lte: range.endDateISO } }]
    }).toArray();

    if (invoices.length > 0) {
      paidTuition = netMonthlyTuition;
    } else {
      // Hoặc kiểm tra Fee PAID
      const paidFee = await this.collections.Fee.findOne({
        student: studentObjId,
        billingMonth,
        type: 'TUITION',
        status: 'PAID'
      });
      if (paidFee) {
        paidTuition = paidFee.amount || netMonthlyTuition;
      }
    }

    const parentBalance = (parent && Number(parent.balance)) || 0;
    const parentDebt = (parent && Number(parent.debt)) || 0;

    // Tổng chi phí thực tế bé phải trả
    const totalActualCost = actualTuition + anChieuAmount + veTreAmount + cameraAmount;
    // Tổng số tiền đã có sẵn (đã đóng + ví khả dụng)
    const totalAvailable = paidTuition + parentBalance;
    // Số tiền ròng: Nếu > 0 là Hoàn lại cho PH, Nếu < 0 là Thu thêm của PH
    const settlementNet = totalAvailable - totalActualCost;

    return {
      student: {
        id: String(student._id),
        name: student.name,
        namhocphi: student.namhocphi || 'HPN_2026',
        hocphigiam: studentDiscount,
        baseFee: studentBaseFee,
        netMonthlyTuition,
        dailyTuitionStandard,
        status: student.status,
      },
      parent: parent ? {
        id: String(parent._id),
        name: parent.name,
        code: parent.code || 'PH',
        phone: parent.phone || '',
        balance: parentBalance,
        debt: parentDebt,
      } : null,
      lophoc: lophoc ? {
        id: String(lophoc._id),
        name: lophoc.name,
      } : null,
      billingMonth,
      month: curMonth,
      year: curYear,
      calculation: {
        actualDays,
        actualTuition,
        anChieuCount,
        anChieuAmount,
        price545,
        veTreCount,
        veTreAmount,
        hasCamera,
        cameraAmount,
        totalActualCost,
        paidTuition,
        parentBalance,
        totalAvailable,
        settlementNet,
        settlementType: settlementNet >= 0 ? 'REFUND' : 'COLLECT',
        settlementAmount: Math.abs(settlementNet),
      },
    };
  }

  /**
   * 2. XÁC NHẬN KẾT SỔ NGHỈ HỌC (EXECUTE WITHDRAWAL SETTLEMENT)
   */
  async executeWithdrawalSettlement(context, input, actorId) {
    const {
      studentId,
      billingMonth,
      actualDays = 0,
      actualTuition = 0,
      anChieuAmount = 0,
      veTreAmount = 0,
      cameraAmount = 0,
      paidTuition = 0,
      discount = 0,
      settlementAction = 'REFUND_CASH', // 'REFUND_CASH' | 'REFUND_BANK' | 'KEEP_IN_WALLET' | 'COLLECT_CASH' | 'COLLECT_ACB_QR' | 'RECORD_DEBT'
      markInactive = true,
      note = '',
    } = input;

    if (!studentId) throw new Error('Vui lòng chọn học sinh');

    const student = await this.collections.Student.findOne({ _id: this.id(studentId) });
    if (!student) throw new Error('Không tìm thấy học sinh');

    let parent = null;
    if (student.parent) {
      parent = await this.collections.Parent.findOne({ _id: this.id(student.parent) });
    }
    if (!parent) throw new Error('Học sinh chưa liên kết với phụ huynh');

    const parentId = String(parent._id);
    const parentBalance = Number(parent.balance) || 0;

    // Tính toán lại các con số cuối cùng
    const totalCost = Number(actualTuition) + Number(anChieuAmount) + Number(veTreAmount) + Number(cameraAmount);
    const totalAvailable = Number(paidTuition) + parentBalance;
    const rawNet = totalAvailable - totalCost - (Number(discount) || 0);
    const finalAmount = Math.abs(rawNet);
    const isRefund = rawNet >= 0;

    // 1. Cập nhật trạng thái học sinh sang NGHI_LUON
    if (markInactive) {
      await this.collections.Student.updateOne(
        { _id: student._id },
        {
          $set: {
            status: 'NGHI_LUON',
            updatedAt: new Date().toISOString(),
          }
        }
      );
    }

    // 2. Tạo Phiếu Kết Sổ & ItemKetSo với mã KS_NGHI_LUON
    const pksId = new this.ObjectId();
    const itemKsId = new this.ObjectId();

    await this.collections.PhieuKetSo.insertOne({
      _id: pksId,
      code: 'KSNH',
      status: 'NORMAL',
      createdAt: new Date().toISOString(),
      createdBy: actorId ? this.id(actorId) : null,
    });

    const itemKsData = {
      actualDays: Number(actualDays),
      actualTuition: Number(actualTuition),
      anChieuAmount: Number(anChieuAmount),
      veTreAmount: Number(veTreAmount),
      cameraAmount: Number(cameraAmount),
      paidTuition: Number(paidTuition),
      parentBalanceAtTime: parentBalance,
      settlementAction,
      isRefund,
      finalAmount,
      rawNet,
      discount: Number(discount) || 0,
      note: note || `Kết sổ thôi học cho bé ${student.name}`,
    };

    await this.collections.ItemKetSo.insertOne({
      _id: itemKsId,
      code: 'KS_NGHI_LUON',
      phieuketso: pksId,
      hocsinh: student._id,
      total: isRefund ? -finalAmount : finalAmount,
      data: JSON.stringify(itemKsData),
      createdAt: new Date().toISOString(),
    });

    // 3. Xử lý Dòng tiền kế toán theo phương thức đã chọn
    let receiptCode = `TL${Date.now().toString().slice(-6)}`;

    if (isRefund && finalAmount > 0) {
      // Trường hợp Nhà trường hoàn tiền lại cho Phụ huynh
      if (settlementAction === 'REFUND_CASH') {
        // Chi tiền mặt tại quầy
        await this.collections.CashTransaction.insertOne({
          _id: new this.ObjectId(),
          code: receiptCode,
          type: 'OUTFLOW',
          amount: finalAmount,
          paymentMethod: 'CASH',
          bankDescription: `Chi hoàn trả thôi học bé ${student.name} (${billingMonth})`,
          status: 'ALLOCATED',
          parent: parent._id,
          createdAt: new Date().toISOString(),
          createdBy: actorId ? this.id(actorId) : null,
        });
      } else if (settlementAction === 'REFUND_BANK') {
        // Chi chuyển khoản ngân hàng
        await this.collections.CashTransaction.insertOne({
          _id: new this.ObjectId(),
          code: receiptCode,
          type: 'OUTFLOW',
          amount: finalAmount,
          paymentMethod: 'ACB_BANK',
          bankDescription: `Chuyển khoản hoàn tiền thôi học bé ${student.name} (${billingMonth})`,
          status: 'ALLOCATED',
          parent: parent._id,
          createdAt: new Date().toISOString(),
          createdBy: actorId ? this.id(actorId) : null,
        });
      }
      // Đưa số dư ví của phụ huynh về 0 nếu đã quyết toán hết
      await this.collections.Parent.updateOne(
        { _id: parent._id },
        { $set: { balance: 0 } }
      );
    } else if (!isRefund && finalAmount > 0) {
      // Trường hợp Phụ huynh cần nộp thêm tiền
      if (settlementAction === 'COLLECT_CASH') {
        await SettlementService.processInflowAndSettle(context, {
          parentId,
          amount: finalAmount,
          paymentMethod: 'CASH',
          bankDescription: `Thu tiền mặt quyết toán thôi học bé ${student.name} (${billingMonth})`,
          userId: actorId,
          note: note || `Quyết toán thôi học bé ${student.name}`,
        });
      }
    }

    // 4. Sinh mã VietQR nếu phụ huynh cần đóng thêm tiền
    const qrInfo = parent.code ? `${parent.code} ${receiptCode}` : receiptCode;
    const qrUrl = (!isRefund && finalAmount > 0) ? generateVietQrUrl(qrInfo, finalAmount) : null;

    return {
      success: true,
      receipt: {
        id: String(itemKsId),
        code: receiptCode,
        studentName: student.name,
        parentName: parent.name,
        parentCode: parent.code || 'PH',
        parentPhone: parent.phone || '',
        billingMonth,
        actualDays: Number(actualDays),
        actualTuition: Number(actualTuition),
        anChieuAmount: Number(anChieuAmount),
        veTreAmount: Number(veTreAmount),
        cameraAmount: Number(cameraAmount),
        paidTuition: Number(paidTuition),
        parentBalanceAtTime: parentBalance,
        totalCost,
        totalAvailable,
        isRefund,
        settlementAmount: finalAmount,
        settlementAction,
        note,
        qrInfo,
        vietqrUrl: qrUrl,
        createdAt: new Date().toISOString(),
      },
    };
  }
}

module.exports = WithdrawalSettlementService;
