const MAX_INT = 2147483647;
const FEE_STATUSES = ['ACTIVE', 'CANCELLED'];
const FEE_SOURCES = ['AUTOMATIC', 'MANUAL'];
const FEE_TYPES = ['TUITION', 'CAMERA', 'FACILITY', 'EXTENDED', 'ABSENCE_CREDIT'];
const DOCUMENT_TYPES = ['INVOICE', 'MONTHLY_SETTLEMENT', 'ABSENCE_SETTLEMENT'];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function text(value, name, max = 255, required = true) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value !== value.trim() || (required && !value) || value.length > max) {
    fail(`${name} không hợp lệ`);
  }
  return value;
}
function enumValue(value, values, name) {
  if (!values.includes(value)) fail(`${name} không hợp lệ`);
  return value;
}
function optionalText(value, name, max = 255) {
  return value == null || value === '' ? '' : text(value, name, max);
}
function periodFields(input, type) {
  const billingMonth = optionalText(input.billingMonth, 'billingMonth', 7);
  const schoolYear = optionalText(input.schoolYear, 'schoolYear', 20);
  if (billingMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(billingMonth)) fail('billingMonth không hợp lệ');
  if (type === 'FACILITY' && !schoolYear) fail('Phí cơ sở vật chất cần năm học');
  if (['TUITION', 'CAMERA', 'ABSENCE_CREDIT'].includes(type) && !billingMonth) {
    fail('Loại phí này cần tháng tính phí');
  }
  if (type === 'EXTENDED' && !billingMonth && !schoolYear) fail('Khoản mở rộng cần kỳ áp dụng');
  return { billingMonth, schoolYear };
}
function configureFeeSchema(schema) {
  // Attach and cancel both update this revision, serializing the otherwise
  // write-skew-prone "no active link" invariant inside Mongo transactions.
  schema.add({ attachmentRevision: { type: Number, default: 0 } });
}
function configureFeeDocumentLinkSchema(schema) {
  // A fee is a billable line and may belong to only one active document at a
  // time. Detaching preserves history and releases this partial unique key.
  // Keystone creates its own non-unique relationship index on { fee: 1 }.
  // Include status in the key so Mongo can keep both indexes.
  schema.index({ fee: 1, status: 1 }, {
    unique: true,
    name: 'fee_document_active_attachment',
    partialFilterExpression: { status: 'ACTIVE' }
  });
}

class FeeDomain {
  constructor(keystone) {
    const fee = keystone.lists?.Fee?.adapter?.model;
    const link = keystone.lists?.FeeDocumentLink?.adapter?.model;
    if (!fee || !link) fail('Fee domain chưa sẵn sàng', 503);
    this.fees = fee.collection;
    this.links = link.collection;
    this.connection = fee.db;
    if (link.db !== this.connection) fail('Fee domain database mismatch', 503);
    this.ObjectId = fee.db.base.Types.ObjectId;
    this.collections = Object.fromEntries(['Student', 'Parent', 'User'].map(key => [
      key, keystone.lists?.[key]?.adapter?.model?.collection
    ]));
  }
  id(value, name = 'ID') {
    if (typeof value !== 'string' || !this.ObjectId.isValid(value) || String(new this.ObjectId(value)) !== value.toLowerCase()) {
      fail(`${name} không hợp lệ`);
    }
    return new this.ObjectId(value);
  }
  actor(value) { return this.id(String(value), 'Người thao tác'); }
  async ensureSubject(student, parent, session) {
    if (!student && !parent) fail('Phí phải gắn với học sinh và/hoặc phụ huynh');
    for (const [name, value] of [['Student', student], ['Parent', parent]]) {
      if (value && (!this.collections[name] || !await this.collections[name].findOne({ _id: value }, { session, projection: { _id: 1 } }))) {
        fail(`${name === 'Student' ? 'Học sinh' : 'Phụ huynh'} không tồn tại`, 404);
      }
    }
  }
  evidence(value) {
    if (value == null) return '';
    if (typeof value === 'string') return text(value, 'Evidence', 16384, false);
    if (typeof value !== 'object') fail('Evidence phải là JSON hoặc text');
    let encoded;
    try { encoded = JSON.stringify(value); } catch (_) { fail('Evidence JSON không hợp lệ'); }
    if (encoded.length > 16384) fail('Evidence quá dài');
    return encoded;
  }
  async create(input, actorId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Dữ liệu phí không hợp lệ');
    const student = input.studentId ? this.id(input.studentId, 'studentId') : null;
    const parent = input.parentId ? this.id(input.parentId, 'parentId') : null;
    const amount = input.amount;
    if (!Number.isInteger(amount) || amount < -MAX_INT || amount > MAX_INT) fail('Số tiền phải là số nguyên VND hợp lệ');
    const type = enumValue(input.type, FEE_TYPES, 'Loại phí');
    const _id = new this.ObjectId();
    const row = {
      _id,
      code: `KP-${String(_id).toUpperCase()}`,
      businessKey: text(input.businessKey, 'businessKey', 200),
      status: 'ACTIVE',
      source: enumValue(input.source, FEE_SOURCES, 'Nguồn phí'),
      type,
      student, parent, amount,
      ...periodFields(input, type),
      evidence: this.evidence(input.evidence),
      createdAt: new Date(), createdBy: this.actor(actorId), attachmentRevision: 0
    };
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.ensureSubject(student, parent, session);
        try { await this.fees.insertOne(row, { session }); }
        catch (error) { if (error.code === 11000) fail('businessKey đã tồn tại', 409); throw error; }
      });
    } finally { await session.endSession(); }
    return this.get(String(row._id));
  }
  async get(id) {
    const _id = this.id(id, 'feeId');
    const row = await this.fees.findOne({ _id });
    if (!row) fail('Không tìm thấy phí', 404);
    const attachments = await this.links.find({ fee: _id, status: 'ACTIVE' }).sort({ attachedAt: 1, _id: 1 }).toArray();
    return this.output(row, attachments);
  }
  output(row, attachments = []) {
    const id = value => value ? String(value) : null;
    return {
      id: id(row._id), code: row.code, businessKey: row.businessKey, status: row.status, source: row.source,
      type: row.type, studentId: id(row.student), parentId: id(row.parent), amount: row.amount,
      student: row.studentInfo || null, parent: row.parentInfo || null,
      billingMonth: row.billingMonth, schoolYear: row.schoolYear, evidence: row.evidence || '',
      createdAt: row.createdAt, createdBy: id(row.createdBy), cancelledAt: row.cancelledAt || null,
      cancelledBy: id(row.cancelledBy), cancellationReason: row.cancellationReason || '',
      attached: attachments.length > 0,
      attachments: attachments.map(link => ({ id: id(link._id), documentType: link.documentType,
        documentId: link.documentId, attachedAt: link.attachedAt, attachedBy: id(link.attachedBy) }))
    };
  }
  async list(query = {}) {
    const rawPage = Number(query.page || 1);
    const rawPageSize = Number(query.pageSize || query.limit || 50);
    if (!Number.isSafeInteger(rawPage) || rawPage < 1 || rawPage > 100000 ||
        !Number.isSafeInteger(rawPageSize) || rawPageSize < 1 || rawPageSize > 100) fail('Phân trang không hợp lệ');
    const where = {};
    if (query.status) where.status = enumValue(query.status, FEE_STATUSES, 'Trạng thái');
    if (query.source) where.source = enumValue(query.source, FEE_SOURCES, 'Nguồn phí');
    if (query.type) where.type = enumValue(query.type, FEE_TYPES, 'Loại phí');
    if (query.billingMonth) where.billingMonth = text(query.billingMonth, 'billingMonth', 20);
    if (query.schoolYear) where.schoolYear = text(query.schoolYear, 'schoolYear', 20);
    if (query.studentId) where.student = this.id(query.studentId, 'studentId');
    if (query.parentId) where.parent = this.id(query.parentId, 'parentId');
    const search = optionalText(query.search, 'Tìm kiếm', 200);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const [students, parents] = await Promise.all([
        this.collections.Student.find({ $or: [{ name: regex }, { sName: regex }] }, { projection: { _id: 1 } }).limit(200).toArray(),
        this.collections.Parent.find({ $or: [{ name: regex }, { code: regex }] }, { projection: { _id: 1 } }).limit(200).toArray()
      ]);
      where.$or = [{ code: regex }, { businessKey: regex }];
      if (students.length) where.$or.push({ student: { $in: students.map(row => row._id) } });
      if (parents.length) where.$or.push({ parent: { $in: parents.map(row => row._id) } });
    }
    const [rows, total, active, cancelled, attachedRows] = await Promise.all([
      this.fees.find(where).sort({ createdAt: -1, _id: -1 }).skip((rawPage - 1) * rawPageSize).limit(rawPageSize).toArray(),
      this.fees.countDocuments(where),
      this.fees.countDocuments({ ...where, status: 'ACTIVE' }),
      this.fees.countDocuments({ ...where, status: 'CANCELLED' }),
      this.fees.aggregate([{ $match: where }, { $lookup: { from: this.links.collectionName, localField: '_id',
        foreignField: 'fee', as: 'documentLinks' } }, { $match: { documentLinks: { $elemMatch: { status: 'ACTIVE' } } } },
      { $count: 'total' }]).toArray()
    ]);
    const feeIds = rows.map(row => row._id);
    const links = feeIds.length ? await this.links.find({ fee: { $in: feeIds }, status: 'ACTIVE' }).toArray() : [];
    const byFee = new Map();
    for (const link of links) {
      const key = String(link.fee);
      if (!byFee.has(key)) byFee.set(key, []);
      byFee.get(key).push(link);
    }
    const studentIds = [...new Set(rows.map(row => row.student && String(row.student)).filter(Boolean))];
    const parentIds = [...new Set(rows.map(row => row.parent && String(row.parent)).filter(Boolean))];
    const [students, parents] = await Promise.all([
      studentIds.length ? this.collections.Student.find({ _id: { $in: studentIds.map(value => this.id(value)) } },
        { projection: { name: 1, sName: 1, lophoc: 1 } }).toArray() : [],
      parentIds.length ? this.collections.Parent.find({ _id: { $in: parentIds.map(value => this.id(value)) } },
        { projection: { name: 1, code: 1 } }).toArray() : []
    ]);
    const studentMap = new Map(students.map(item => [String(item._id), {
      id: String(item._id), name: item.name || '', code: item.sName || '', classId: item.lophoc ? String(item.lophoc) : null
    }]));
    const parentMap = new Map(parents.map(item => [String(item._id), {
      id: String(item._id), name: item.name || '', code: item.code || ''
    }]));
    for (const row of rows) {
      row.studentInfo = row.student ? studentMap.get(String(row.student)) || null : null;
      row.parentInfo = row.parent ? parentMap.get(String(row.parent)) || null : null;
    }
    return { page: rawPage, pageSize: rawPageSize, total,
      summary: { total, active, cancelled, attached: attachedRows[0]?.total || 0 },
      rows: rows.map(row => this.output(row, byFee.get(String(row._id)) || [])) };
  }
  async cancel(feeId, reason, actorId) {
    const _id = this.id(feeId, 'feeId');
    const cancellationReason = text(reason, 'Lý do hủy', 2000);
    const cancelledBy = this.actor(actorId);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const fee = await this.fees.findOne({ _id }, { session });
        if (!fee) fail('Không tìm thấy phí', 404);
        if (fee.status === 'CANCELLED') fail('Phí đã bị hủy', 409);
        if (await this.links.findOne({ fee: _id, status: 'ACTIVE' }, { session, projection: { _id: 1 } })) {
          fail('Không thể hủy phí đang gắn chứng từ', 409);
        }
        await this.fees.updateOne({ _id, status: 'ACTIVE' }, { $set: {
          status: 'CANCELLED', cancelledAt: new Date(), cancelledBy, cancellationReason
        } }, { session });
      });
    } finally { await session.endSession(); }
    return this.get(feeId);
  }
  async attach(feeId, input, actorId) {
    const fee = this.id(feeId, 'feeId');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Dữ liệu gắn chứng từ không hợp lệ');
    const documentType = enumValue(input.documentType, DOCUMENT_TYPES, 'Loại chứng từ');
    const documentId = text(input.documentId, 'documentId', 200);
    const attachedBy = this.actor(actorId);
    const session = await this.connection.startSession();
    let linkId;
    try {
      await session.withTransaction(async () => {
        const updated = await this.fees.updateOne({ _id: fee, status: 'ACTIVE' }, { $inc: { attachmentRevision: 1 } }, { session });
        if (!updated.matchedCount) {
          const existing = await this.fees.findOne({ _id: fee }, { session, projection: { status: 1 } });
          if (!existing) fail('Không tìm thấy phí', 404);
          fail('Không thể gắn chứng từ vào phí đã hủy', 409);
        }
        try {
          linkId = (await this.links.insertOne({ fee, documentType, documentId, status: 'ACTIVE',
            attachedAt: new Date(), attachedBy }, { session })).insertedId;
        } catch (error) { if (error.code === 11000) fail('Phí đã được gắn vào một chứng từ', 409); throw error; }
      });
    } finally { await session.endSession(); }
    return { linkId: String(linkId), fee: await this.get(feeId) };
  }
  async detach(feeId, linkId, reason, actorId) {
    const fee = this.id(feeId, 'feeId');
    const _id = this.id(linkId, 'attachmentId');
    const detachReason = reason == null ? '' : text(reason, 'Lý do tháo', 2000, false);
    const detachedBy = this.actor(actorId);
    const result = await this.links.updateOne({ _id, fee, status: 'ACTIVE' }, { $set: {
      status: 'DETACHED', detachedAt: new Date(), detachedBy, detachReason
    } });
    if (!result.matchedCount) fail('Không tìm thấy liên kết đang hoạt động', 404);
    return this.get(feeId);
  }
}

module.exports = { FeeDomain, configureFeeSchema, configureFeeDocumentLinkSchema,
  FEE_STATUSES, FEE_SOURCES, FEE_TYPES, DOCUMENT_TYPES };
