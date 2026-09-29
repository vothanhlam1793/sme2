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

class InvoiceService {
  constructor(keystone) {
    this.keystone = keystone;
    this.feeDomain = new FeeDomain(keystone);
    this.ObjectId = keystone.lists?.HoaDon?.adapter?.model?.db?.base?.Types?.ObjectId || require('mongoose').Types.ObjectId;
    this.collections = {
      HoaDon: keystone.lists?.HoaDon?.adapter?.model?.collection,
      Item: keystone.lists?.Item?.adapter?.model?.collection,
      Student: keystone.lists?.Student?.adapter?.model?.collection,
      Parent: keystone.lists?.Parent?.adapter?.model?.collection,
      SanPham: keystone.lists?.SanPham?.adapter?.model?.collection,
      User: keystone.lists?.User?.adapter?.model?.collection,
      Fee: keystone.lists?.Fee?.adapter?.model?.collection,
      FeeDocumentLink: keystone.lists?.FeeDocumentLink?.adapter?.model?.collection,
    };
  }

  id(val) {
    if (!val) return null;
    return new this.ObjectId(String(val));
  }

  /**
   * 1. HÓA ĐƠN NHẬP HỌC (ADMISSION INVOICE)
   */
  async createAdmissionInvoice(context, input, actorId) {
    const {
      studentId,
      paymentMethod = 'CASH', // 'CASH' | 'ACB_BANK' | 'WALLET' | 'DEBT'
      facilityAmount = 0,
      schoolYear = '2026-2027',
      tuitionItems = [], // [{ billingMonth: '2026-09', amount: 1500000, note: 'Nửa tháng 9' }, { billingMonth: '2026-10', amount: 3000000, note: 'Tháng 10' }]
      productItems = [], // [{ sanphamId, name, price, amount, total }]
      discount = 0,
      note = '',
    } = input;

    if (!studentId) throw new Error('Vui lòng chọn học sinh nhập học');

    const student = await this.collections.Student.findOne({ _id: this.id(studentId) });
    if (!student) throw new Error('Không tìm thấy học sinh');
    if (!student.parent) throw new Error('Học sinh chưa được gán phụ huynh');

    const parent = await this.collections.Parent.findOne({ _id: this.id(student.parent) });
    if (!parent) throw new Error('Không tìm thấy thông tin phụ huynh');

    const lineItems = [];
    const feePlans = [];

    // 1. Phí Cơ sở vật chất đầu năm
    const numFacility = Number(facilityAmount) || 0;
    if (numFacility > 0) {
      lineItems.push({
        name: `Cơ sở vật chất (${schoolYear})`,
        price: numFacility,
        amount: 1,
        total: numFacility,
        feeType: 'FACILITY',
        schoolYear,
      });
      feePlans.push({
        feeType: 'FACILITY',
        amount: numFacility,
        schoolYear,
        note: `CSVC nhập học ${schoolYear}`,
      });
    }

    // 2. Các tháng học phí (chọn tháng & số tiền linh hoạt)
    for (const t of tuitionItems) {
      const tAmount = Number(t.amount) || 0;
      const tMonth = String(t.billingMonth || '').trim();
      if (tAmount > 0 && /^\d{4}-(0[1-9]|1[0-2])$/.test(tMonth)) {
        lineItems.push({
          name: `Học phí tháng ${tMonth}${t.note ? ` (${t.note})` : ''}`,
          price: tAmount,
          amount: 1,
          total: tAmount,
          feeType: 'TUITION',
          billingMonth: tMonth,
          schoolYear,
        });
        feePlans.push({
          feeType: 'TUITION',
          amount: tAmount,
          billingMonth: tMonth,
          schoolYear,
          note: t.note || `Học phí tháng ${tMonth} (Hóa đơn nhập học)`,
        });
      }
    }

    // 3. Sản phẩm kèm theo (Đồng phục, Balo, v.v.)
    for (const p of productItems) {
      const pPrice = Number(p.price) || 0;
      const pQty = Number(p.amount) || 1;
      const pTotal = Number(p.total) || pPrice * pQty;
      if (pTotal > 0) {
        lineItems.push({
          sanphamId: p.sanphamId || null,
          name: p.name || 'Sản phẩm / Đồng phục',
          price: pPrice,
          amount: pQty,
          total: pTotal,
        });
      }
    }

    const subTotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const numDiscount = Math.max(0, Number(discount) || 0);
    const finalTotal = Math.max(0, subTotal - numDiscount);

    // Sinh mã hóa đơn HDxxxxxx
    let hdCode;
    try {
      hdCode = await codeUtil.getCode(context, 'HD');
    } catch (_) {
      hdCode = `HD${Date.now().toString().slice(-6)}`;
    }

    const hoaDonId = new this.ObjectId();
    const createdItemIds = [];

    // Tạo các dòng Item trong DB
    for (const line of lineItems) {
      const itemId = new this.ObjectId();
      await this.collections.Item.insertOne({
        _id: itemId,
        sanpham: line.sanphamId ? this.id(line.sanphamId) : null,
        price: line.price,
        amount: line.amount,
        total: line.total,
        hoadon: hoaDonId,
        createdAt: new Date(),
      });
      createdItemIds.push(itemId);
    }

    const hoaDonType = (paymentMethod === 'CASH' || paymentMethod === 'ACB_BANK' || paymentMethod === 'WALLET')
      ? 'THANHTOAN'
      : 'NHAPHOC';

    const hoaDonDoc = {
      _id: hoaDonId,
      code: hdCode,
      total: finalTotal,
      giamgia: numDiscount,
      parent: this.id(parent._id),
      student: this.id(student._id),
      items: createdItemIds,
      type: hoaDonType,
      createdAt: new Date().toISOString(),
      createdBy: actorId ? this.id(actorId) : null,
    };

    await this.collections.HoaDon.insertOne(hoaDonDoc);

    // Sinh các bản ghi Fee tương ứng và gắn liên kết FeeDocumentLink
    const linkedFees = [];
    for (const fp of feePlans) {
      const timestamp = Date.now().toString().slice(-6);
      let businessKey;
      if (fp.feeType === 'TUITION') {
        businessKey = `TUITION:ADMISSION:${student._id}:${fp.billingMonth}:${timestamp}`;
      } else if (fp.feeType === 'FACILITY') {
        businessKey = `FACILITY:ADMISSION:${student._id}:${fp.schoolYear}:${timestamp}`;
      } else {
        businessKey = `EXTENDED:ADMISSION:${student._id}:${timestamp}`;
      }

      try {
        const feeCreated = await this.feeDomain.create(
          {
            businessKey,
            source: 'MANUAL',
            type: fp.feeType,
            studentId: String(student._id),
            parentId: String(parent._id),
            billingMonth: fp.billingMonth,
            schoolYear: fp.schoolYear || schoolYear,
            amount: fp.amount,
            evidence: {
              source: 'ADMISSION_INVOICE',
              invoiceId: String(hoaDonId),
              invoiceCode: hdCode,
              note: fp.note,
              studentName: student.name,
            },
          },
          actorId || '000000000000000000000000'
        );

        await this.feeDomain.attach(
          feeCreated.id,
          {
            documentType: 'INVOICE',
            documentId: String(hoaDonId),
          },
          actorId || '000000000000000000000000'
        );

        linkedFees.push(feeCreated);
      } catch (err) {
        console.warn(`[InvoiceService] Lỗi tạo/gắn Fee ${businessKey}:`, err.message);
      }
    }

    // Xử lý hạch toán tài chính theo phương thức thanh toán
    if (finalTotal > 0) {
      // 1. Ghi nhận phát sinh nợ hóa đơn
      await SettlementService.processBillCreated(context, {
        parentId: String(parent._id),
        amount: finalTotal,
        itemType: 'HoaDon',
        itemId: String(hoaDonId),
        note: `Phát sinh Hóa đơn nhập học ${hdCode}`,
      });

      // 2. Xử lý thanh toán nếu thu ngay
      if (paymentMethod === 'CASH') {
        await SettlementService.processInflowAndSettle(context, {
          parentId: String(parent._id),
          amount: finalTotal,
          paymentMethod: 'CASH',
          bankRef: hdCode,
          bankDescription: `Thu tiền mặt HĐ nhập học ${hdCode}`,
          settleType: 'MANUAL_ACCOUNTANT',
          userId: actorId,
          note: note || `Thu tiền mặt HĐ nhập học ${hdCode}`,
        });
      } else if (paymentMethod === 'ACB_BANK') {
        await SettlementService.processInflowAndSettle(context, {
          parentId: String(parent._id),
          amount: finalTotal,
          paymentMethod: 'ACB_BANK',
          bankRef: hdCode,
          bankDescription: `Chuyển khoản ACB HĐ nhập học ${hdCode}`,
          settleType: 'SCHOOL_TRANSFER',
          userId: actorId,
          note: note || `Chuyển khoản thanh toán HĐ nhập học ${hdCode}`,
        });
      } else if (paymentMethod === 'WALLET') {
        await SettlementService.transferBalanceToDebt(context, {
          parentId: String(parent._id),
          amount: finalTotal,
          note: `Trích số dư ví thanh toán HĐ nhập học ${hdCode}`,
          userId: actorId,
        });
      }
    }

    const qrInfo = parent.code ? `${parent.code} ${hdCode}` : hdCode;
    const qrUrl = generateVietQrUrl(qrInfo, finalTotal);

    return {
      success: true,
      invoice: {
        id: String(hoaDonId),
        code: hdCode,
        total: finalTotal,
        discount: numDiscount,
        type: hoaDonType,
        paymentMethod,
        studentName: student.name,
        parentName: parent.name,
        parentCode: parent.code || '',
        parentPhone: parent.phone || '',
        createdAt: hoaDonDoc.createdAt,
        qrInfo,
        vietqrUrl: qrUrl,
        items: lineItems,
        linkedFeesCount: linkedFees.length,
      },
    };
  }

  /**
   * 2. HÓA ĐƠN BÁN LẺ & THU ĐỘT XUẤT (RETAIL / AD-HOC INVOICE)
   */
  async createRetailInvoice(context, input, actorId) {
    const {
      studentId,
      paymentMethod = 'CASH',
      items = [], // [{ sanphamId, name, price, amount, total }]
      discount = 0,
      note = '',
    } = input;

    if (!studentId) throw new Error('Vui lòng chọn học sinh');
    if (!items.length) throw new Error('Vui lòng chọn ít nhất 1 sản phẩm hoặc khoản thu');

    const student = await this.collections.Student.findOne({ _id: this.id(studentId) });
    if (!student) throw new Error('Không tìm thấy học sinh');
    if (!student.parent) throw new Error('Học sinh chưa có phụ huynh');

    const parent = await this.collections.Parent.findOne({ _id: this.id(student.parent) });
    if (!parent) throw new Error('Không tìm thấy phụ huynh');

    const lineItems = [];
    for (const it of items) {
      const pPrice = Number(it.price) || 0;
      const pQty = Number(it.amount) || 1;
      const pTotal = Number(it.total) || pPrice * pQty;
      if (pTotal > 0) {
        lineItems.push({
          sanphamId: it.sanphamId || null,
          name: it.name || 'Sản phẩm / Dịch vụ',
          price: pPrice,
          amount: pQty,
          total: pTotal,
        });
      }
    }

    const subTotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const numDiscount = Math.max(0, Number(discount) || 0);
    const finalTotal = Math.max(0, subTotal - numDiscount);

    let hdCode;
    try {
      hdCode = await codeUtil.getCode(context, 'HD');
    } catch (_) {
      hdCode = `HD${Date.now().toString().slice(-6)}`;
    }

    const hoaDonId = new this.ObjectId();
    const createdItemIds = [];

    for (const line of lineItems) {
      const itemId = new this.ObjectId();
      await this.collections.Item.insertOne({
        _id: itemId,
        sanpham: line.sanphamId ? this.id(line.sanphamId) : null,
        price: line.price,
        amount: line.amount,
        total: line.total,
        hoadon: hoaDonId,
        createdAt: new Date(),
      });
      createdItemIds.push(itemId);
    }

    const hoaDonType = (paymentMethod === 'CASH' || paymentMethod === 'ACB_BANK' || paymentMethod === 'WALLET')
      ? 'THANHTOAN'
      : 'BANLE';

    const hoaDonDoc = {
      _id: hoaDonId,
      code: hdCode,
      total: finalTotal,
      giamgia: numDiscount,
      parent: this.id(parent._id),
      student: this.id(student._id),
      items: createdItemIds,
      type: hoaDonType,
      createdAt: new Date().toISOString(),
      createdBy: actorId ? this.id(actorId) : null,
    };

    await this.collections.HoaDon.insertOne(hoaDonDoc);

    // Ghi nhận nợ và thanh toán
    if (finalTotal > 0) {
      await SettlementService.processBillCreated(context, {
        parentId: String(parent._id),
        amount: finalTotal,
        itemType: 'HoaDon',
        itemId: String(hoaDonId),
        note: `Phát sinh Hóa đơn bán lẻ ${hdCode}`,
      });

      if (paymentMethod === 'CASH') {
        await SettlementService.processInflowAndSettle(context, {
          parentId: String(parent._id),
          amount: finalTotal,
          paymentMethod: 'CASH',
          bankRef: hdCode,
          bankDescription: `Thu tiền mặt HĐ bán lẻ ${hdCode}`,
          settleType: 'MANUAL_ACCOUNTANT',
          userId: actorId,
          note: note || `Thu tiền mặt HĐ bán lẻ ${hdCode}`,
        });
      } else if (paymentMethod === 'ACB_BANK') {
        await SettlementService.processInflowAndSettle(context, {
          parentId: String(parent._id),
          amount: finalTotal,
          paymentMethod: 'ACB_BANK',
          bankRef: hdCode,
          bankDescription: `Chuyển khoản ACB HĐ bán lẻ ${hdCode}`,
          settleType: 'SCHOOL_TRANSFER',
          userId: actorId,
          note: note || `Chuyển khoản HĐ bán lẻ ${hdCode}`,
        });
      } else if (paymentMethod === 'WALLET') {
        await SettlementService.transferBalanceToDebt(context, {
          parentId: String(parent._id),
          amount: finalTotal,
          note: `Trích ví thanh toán HĐ bán lẻ ${hdCode}`,
          userId: actorId,
        });
      }
    }

    const qrInfo = parent.code ? `${parent.code} ${hdCode}` : hdCode;
    const qrUrl = generateVietQrUrl(qrInfo, finalTotal);

    return {
      success: true,
      invoice: {
        id: String(hoaDonId),
        code: hdCode,
        total: finalTotal,
        discount: numDiscount,
        type: hoaDonType,
        paymentMethod,
        studentName: student.name,
        parentName: parent.name,
        parentCode: parent.code || '',
        parentPhone: parent.phone || '',
        createdAt: hoaDonDoc.createdAt,
        qrInfo,
        vietqrUrl: qrUrl,
        items: lineItems,
      },
    };
  }

  /**
   * 3. XEM CHI TIẾT HÓA ĐƠN
   */
  async getInvoiceDetail(context, invoiceId) {
    const _id = this.id(invoiceId);
    const hd = await this.collections.HoaDon.findOne({ _id });
    if (!hd) throw new Error('Không tìm thấy hóa đơn');

    const [student, parent, items, linkedFeeRows] = await Promise.all([
      hd.student ? this.collections.Student.findOne({ _id: this.id(hd.student) }) : null,
      hd.parent ? this.collections.Parent.findOne({ _id: this.id(hd.parent) }) : null,
      this.collections.Item.find({ hoadon: _id }).toArray(),
      this.collections.FeeDocumentLink.find({ documentId: String(_id), status: 'ACTIVE' }).toArray(),
    ]);

    const sanphamIds = items.map(it => it.sanpham).filter(Boolean);
    const sanphams = sanphamIds.length
      ? await this.collections.SanPham.find({ _id: { $in: sanphamIds.map(id => this.id(id)) } }).toArray()
      : [];
    const spMap = new Map(sanphams.map(sp => [String(sp._id), sp.name]));

    const feeIds = linkedFeeRows.map(l => l.fee);
    const fees = feeIds.length
      ? await this.collections.Fee.find({ _id: { $in: feeIds.map(id => this.id(id)) } }).toArray()
      : [];

    const qrInfo = parent && parent.code ? `${parent.code} ${hd.code}` : hd.code;

    return {
      id: String(hd._id),
      code: hd.code,
      total: hd.total,
      discount: hd.giamgia || 0,
      type: hd.type,
      createdAt: hd.createdAt,
      student: student ? { id: String(student._id), name: student.name, sName: student.sName } : null,
      parent: parent ? { id: String(parent._id), name: parent.name, code: parent.code, phone: parent.phone } : null,
      parentCode: parent?.code || '',
      qrInfo,
      vietqrUrl: generateVietQrUrl(qrInfo, hd.total),
      items: items.map(it => ({
        id: String(it._id),
        name: spMap.get(String(it.sanpham)) || 'Khoản thu / Dịch vụ',
        price: it.price,
        amount: it.amount,
        total: it.total,
      })),
      fees: fees.map(f => ({
        id: String(f._id),
        code: f.code,
        type: f.type,
        billingMonth: f.billingMonth,
        schoolYear: f.schoolYear,
        amount: f.amount,
      })),
    };
  }
}

module.exports = { InvoiceService, generateVietQrUrl };
