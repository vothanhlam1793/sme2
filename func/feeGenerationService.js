const { FeeDomain } = require('./feeDomain');

function calculateNextRunDate(scheduleDay = 25, scheduleHour = 1, fromDate = new Date()) {
  const d = new Date(fromDate);
  // Calculate next run date in Vietnam time (UTC+7)
  const vnTime = new Date(d.getTime() + 7 * 3600000);
  let year = vnTime.getUTCFullYear();
  let month = vnTime.getUTCMonth(); // 0-indexed
  const currentDay = vnTime.getUTCDate();
  const currentHour = vnTime.getUTCHours();

  if (currentDay > scheduleDay || (currentDay === scheduleDay && currentHour >= scheduleHour)) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  // Handle month length
  const maxDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const actualDay = Math.min(scheduleDay, maxDays);
  // Target UTC timestamp corresponding to VN year/month/actualDay scheduleHour:00
  const targetVnTimestamp = Date.UTC(year, month, actualDay, scheduleHour, 0, 0);
  return new Date(targetVnTimestamp - 7 * 3600000);
}

class FeeGenerationService {
  constructor(keystone) {
    this.keystone = keystone;
    this.feeDomain = new FeeDomain(keystone);
    const def = keystone.lists?.FeeDefinition?.adapter?.model;
    const run = keystone.lists?.FeeGenerationRun?.adapter?.model;
    if (!def || !run) throw new Error('FeeGenerationService: Models not ready');
    this.definitions = def.collection;
    this.runs = run.collection;
    this.fees = keystone.lists?.Fee?.adapter?.model?.collection;
    this.ObjectId = def.db.base.Types.ObjectId;
    this.collections = {
      Student: keystone.lists?.Student?.adapter?.model?.collection,
      Parent: keystone.lists?.Parent?.adapter?.model?.collection,
      Phone: keystone.lists?.Phone?.adapter?.model?.collection,
      Variable: keystone.lists?.Variable?.adapter?.model?.collection,
      LopHoc: keystone.lists?.LopHoc?.adapter?.model?.collection,
      User: keystone.lists?.User?.adapter?.model?.collection,
    };
  }

  id(val) {
    if (!val) return null;
    return new this.ObjectId(String(val));
  }

  async ensureDefaultDefinitions(actorId) {
    const defaults = [
      {
        code: 'TUITION_MONTHLY',
        name: 'Học phí hàng tháng',
        feeType: 'TUITION',
        status: 'ENABLED',
        generationMode: 'AUTOMATIC',
        generatorKey: 'TUITION_V1',
        subjectType: 'STUDENT',
        frequency: 'MONTHLY',
        defaultAmount: 0,
        scheduleDay: 25,
        scheduleHour: 1,
        scopeConfig: JSON.stringify({ status: ['DANG_HOC'] }),
        generatorConfig: JSON.stringify({}),
      },
      {
        code: 'CAMERA_MONTHLY',
        name: 'Phí Camera theo số điện thoại',
        feeType: 'CAMERA',
        status: 'ENABLED',
        generationMode: 'AUTOMATIC',
        generatorKey: 'CAMERA_V1',
        subjectType: 'PARENT',
        frequency: 'MONTHLY',
        defaultAmount: 50000,
        scheduleDay: 25,
        scheduleHour: 2,
        scopeConfig: JSON.stringify({}),
        generatorConfig: JSON.stringify({ unitPrice: 50000, freePhones: 1 }),
      },
      {
        code: 'FACILITY_ANNUAL',
        name: 'Cơ sở vật chất đầu năm',
        feeType: 'FACILITY',
        status: 'ENABLED',
        generationMode: 'MANUAL',
        generatorKey: 'MANUAL_ONLY',
        subjectType: 'STUDENT',
        frequency: 'SCHOOL_YEAR',
        defaultAmount: 2000000,
        scheduleDay: 1,
        scheduleHour: 0,
        scopeConfig: JSON.stringify({}),
        generatorConfig: JSON.stringify({ allowHalf: true }),
      },
      {
        code: 'EXTENDED_ADHOC',
        name: 'Phí mở rộng / Khoản phát sinh',
        feeType: 'EXTENDED',
        status: 'ENABLED',
        generationMode: 'MANUAL',
        generatorKey: 'MANUAL_ONLY',
        subjectType: 'STUDENT',
        frequency: 'ONE_TIME',
        defaultAmount: 0,
        scheduleDay: 1,
        scheduleHour: 0,
        scopeConfig: JSON.stringify({}),
        generatorConfig: JSON.stringify({}),
      },
    ];

    for (const item of defaults) {
      const existing = await this.definitions.findOne({ code: item.code });
      if (!existing) {
        const nextRun = calculateNextRunDate(item.scheduleDay, item.scheduleHour);
        await this.definitions.insertOne({
          _id: new this.ObjectId(),
          ...item,
          nextRunAt: nextRun,
          createdAt: new Date(),
          createdBy: actorId ? this.id(actorId) : null,
          updatedAt: new Date(),
        });
      }
    }
  }

  async listDefinitions() {
    const list = await this.definitions.find({}).sort({ generationMode: 1, code: 1 }).toArray();
    return list.map(item => ({
      id: String(item._id),
      code: item.code,
      name: item.name,
      feeType: item.feeType,
      status: item.status,
      generationMode: item.generationMode,
      generatorKey: item.generatorKey,
      subjectType: item.subjectType,
      frequency: item.frequency,
      defaultAmount: item.defaultAmount || 0,
      scheduleDay: item.scheduleDay,
      scheduleHour: item.scheduleHour,
      timezone: item.timezone || 'Asia/Ho_Chi_Minh',
      scopeConfig: item.scopeConfig ? JSON.parse(item.scopeConfig) : {},
      generatorConfig: item.generatorConfig ? JSON.parse(item.generatorConfig) : {},
      lastRunAt: item.lastRunAt,
      nextRunAt: item.nextRunAt,
      lastRunStatus: item.lastRunStatus,
      createdAt: item.createdAt,
    }));
  }

  async updateDefinition(id, data, actorId) {
    const _id = this.id(id);
    const update = {
      updatedAt: new Date(),
      updatedBy: actorId ? this.id(actorId) : null,
    };
    if (data.name) update.name = String(data.name).trim();
    if (data.status) update.status = data.status === 'ENABLED' ? 'ENABLED' : 'DISABLED';
    if (data.defaultAmount !== undefined) update.defaultAmount = Number(data.defaultAmount) || 0;
    if (data.scheduleDay !== undefined) update.scheduleDay = Math.min(31, Math.max(1, Number(data.scheduleDay) || 25));
    if (data.scheduleHour !== undefined) update.scheduleHour = Math.min(23, Math.max(0, Number(data.scheduleHour) || 1));
    if (data.scopeConfig) update.scopeConfig = JSON.stringify(data.scopeConfig);
    if (data.generatorConfig) update.generatorConfig = JSON.stringify(data.generatorConfig);

    const doc = await this.definitions.findOne({ _id });
    if (!doc) throw new Error('Không tìm thấy cấu hình khoản phí');

    const nextDay = update.scheduleDay || doc.scheduleDay;
    const nextHour = update.scheduleHour !== undefined ? update.scheduleHour : doc.scheduleHour;
    update.nextRunAt = calculateNextRunDate(nextDay, nextHour);

    await this.definitions.updateOne({ _id }, { $set: update });
    return this.getDefinition(id);
  }

  async createDefinition(data, actorId) {
    if (!data.code || !data.name || !data.feeType) {
      throw new Error('Thiếu thông tin bắt buộc (mã, tên, loại phí)');
    }
    const code = String(data.code).trim().toUpperCase();
    const existing = await this.definitions.findOne({ code });
    if (existing) throw new Error(`Mã cấu hình ${code} đã tồn tại`);

    const scheduleDay = Math.min(31, Math.max(1, Number(data.scheduleDay) || 25));
    const scheduleHour = Math.min(23, Math.max(0, Number(data.scheduleHour) || 1));
    const nextRun = calculateNextRunDate(scheduleDay, scheduleHour);

    const doc = {
      _id: new this.ObjectId(),
      code,
      name: String(data.name).trim(),
      feeType: data.feeType,
      status: data.status === 'DISABLED' ? 'DISABLED' : 'ENABLED',
      generationMode: data.generationMode === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL',
      generatorKey: data.generatorKey || (data.generationMode === 'AUTOMATIC' ? 'FIXED_AMOUNT_V1' : 'MANUAL_ONLY'),
      subjectType: data.subjectType === 'PARENT' ? 'PARENT' : 'STUDENT',
      frequency: data.frequency || 'MONTHLY',
      defaultAmount: Number(data.defaultAmount) || 0,
      scheduleDay,
      scheduleHour,
      timezone: 'Asia/Ho_Chi_Minh',
      scopeConfig: JSON.stringify(data.scopeConfig || {}),
      generatorConfig: JSON.stringify(data.generatorConfig || {}),
      nextRunAt: nextRun,
      createdAt: new Date(),
      createdBy: actorId ? this.id(actorId) : null,
      updatedAt: new Date(),
    };

    await this.definitions.insertOne(doc);
    return this.getDefinition(String(doc._id));
  }

  async getDefinition(id) {
    const doc = await this.definitions.findOne({ _id: this.id(id) });
    if (!doc) return null;
    return {
      id: String(doc._id),
      code: doc.code,
      name: doc.name,
      feeType: doc.feeType,
      status: doc.status,
      generationMode: doc.generationMode,
      generatorKey: doc.generatorKey,
      subjectType: doc.subjectType,
      frequency: doc.frequency,
      defaultAmount: doc.defaultAmount || 0,
      scheduleDay: doc.scheduleDay,
      scheduleHour: doc.scheduleHour,
      scopeConfig: doc.scopeConfig ? JSON.parse(doc.scopeConfig) : {},
      generatorConfig: doc.generatorConfig ? JSON.parse(doc.generatorConfig) : {},
      lastRunAt: doc.lastRunAt,
      nextRunAt: doc.nextRunAt,
      lastRunStatus: doc.lastRunStatus,
    };
  }

  // ==========================================
  // RUN / GENERATE CORE
  // ==========================================

  async runDefinition(defId, options = {}, actorId = null) {
    const def = await this.definitions.findOne({ _id: this.id(defId) });
    if (!def) throw new Error('Không tìm thấy cấu hình khoản phí');

    const billingMonth = options.billingMonth || this.getDefaultBillingMonth();
    const schoolYear = options.schoolYear || '2026-2027';
    const isDryRun = Boolean(options.dryRun);
    const trigger = options.trigger || (isDryRun ? 'PREVIEW' : 'MANUAL_RUN');

    const runId = new this.ObjectId();
    const runCode = `RUN-${billingMonth.replace('-', '')}-${Date.now().toString().slice(-4)}`;

    const runDoc = {
      _id: runId,
      code: runCode,
      feeDefinition: def._id,
      billingMonth,
      schoolYear,
      trigger,
      status: 'RUNNING',
      totalTargets: 0,
      createdCount: 0,
      skippedCount: 0,
      failedCount: 0,
      itemsData: '[]',
      errorSummary: '',
      startedAt: new Date(),
      runBy: actorId ? this.id(actorId) : null,
      runByName: options.runByName || (actorId ? 'Quản trị viên' : 'Hệ thống Cron'),
    };

    await this.runs.insertOne(runDoc);

    const items = [];
    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
      if (def.generatorKey === 'TUITION_V1') {
        const res = await this.generateTuition(def, billingMonth, schoolYear, isDryRun, actorId);
        items.push(...res.items);
        createdCount += res.createdCount;
        skippedCount += res.skippedCount;
        failedCount += res.failedCount;
      } else if (def.generatorKey === 'CAMERA_V1') {
        const res = await this.generateCamera(def, billingMonth, schoolYear, isDryRun, actorId);
        items.push(...res.items);
        createdCount += res.createdCount;
        skippedCount += res.skippedCount;
        failedCount += res.failedCount;
      } else if (def.generatorKey === 'FIXED_AMOUNT_V1') {
        const res = await this.generateFixedAmount(def, billingMonth, schoolYear, isDryRun, actorId);
        items.push(...res.items);
        createdCount += res.createdCount;
        skippedCount += res.skippedCount;
        failedCount += res.failedCount;
      } else {
        throw new Error(`Cấu hình ${def.code} là loại thủ công, không có bộ tính tự động`);
      }

      const finalStatus = failedCount > 0 ? (createdCount > 0 ? 'PARTIAL' : 'FAILED') : 'SUCCESS';
      await this.runs.updateOne(
        { _id: runId },
        {
          $set: {
            status: finalStatus,
            totalTargets: items.length,
            createdCount,
            skippedCount,
            failedCount,
            itemsData: JSON.stringify(items.slice(0, 500)), // Limit detail snapshot
            completedAt: new Date(),
          },
        }
      );

      // Update definition lastRun status
      if (!isDryRun) {
        const nextRun = calculateNextRunDate(def.scheduleDay, def.scheduleHour);
        await this.definitions.updateOne(
          { _id: def._id },
          {
            $set: {
              lastRunAt: new Date(),
              lastRunStatus: finalStatus,
              nextRunAt: nextRun,
            },
          }
        );
      }

      return {
        runId: String(runId),
        code: runCode,
        status: finalStatus,
        isDryRun,
        totalTargets: items.length,
        createdCount,
        skippedCount,
        failedCount,
        items,
      };
    } catch (err) {
      await this.runs.updateOne(
        { _id: runId },
        {
          $set: {
            status: 'FAILED',
            errorSummary: err.message,
            completedAt: new Date(),
          },
        }
      );
      throw err;
    }
  }

  getDefaultBillingMonth() {
    const d = new Date(Date.now() + 7 * 3600000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  // ==========================================
  // GENERATOR 1: TUITION_V1
  // ==========================================
  async generateTuition(def, billingMonth, schoolYear, isDryRun, actorId) {
    const scope = def.scopeConfig ? JSON.parse(def.scopeConfig) : {};
    const allowedStatuses = scope.status && scope.status.length ? scope.status : ['DANG_HOC'];

    // 1. Lấy danh sách học sinh
    const query = { status: { $in: allowedStatuses } };
    if (scope.classIds && scope.classIds.length) {
      query.lophoc = { $in: scope.classIds.map(id => this.id(id)) };
    }

    const students = await this.collections.Student.find(query).toArray();

    // 2. Lấy biểu phí học phí HPN_*
    const variables = await this.collections.Variable.find({ key: { $regex: /^HPN_/ } }).toArray();
    const tuitionMap = new Map();
    for (const v of variables) {
      tuitionMap.set(v.key, Number(v.value) || 0);
    }

    const items = [];
    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const s of students) {
      const studentId = String(s._id);
      const parentId = s.parent ? String(s.parent) : null;
      const namhocphi = s.namhocphi || 'HPN_2023';
      const baseFee = tuitionMap.get(namhocphi);

      const itemResult = {
        targetId: studentId,
        targetName: s.name,
        targetCode: s.sName || '',
        businessKey: `TUITION:${def.code}:${studentId}:${billingMonth}`,
        amount: 0,
        status: 'READY',
        reason: '',
      };

      if (baseFee === undefined) {
        itemResult.status = 'FAILED';
        itemResult.reason = `Không tìm thấy mức học phí cho biểu ${namhocphi}`;
        failedCount++;
        items.push(itemResult);
        continue;
      }

      const discount = Number(s.hocphigiam) || 0;
      const finalAmount = Math.max(0, baseFee - discount);
      itemResult.amount = finalAmount;

      // Kiểm tra businessKey đã tồn tại chưa
      const existingFee = await this.fees.findOne({ businessKey: itemResult.businessKey });
      if (existingFee) {
        itemResult.status = 'ALREADY_EXISTS';
        itemResult.feeCode = existingFee.code;
        itemResult.reason = `Đã tồn tại khoản phí ${existingFee.code} cho tháng ${billingMonth}`;
        skippedCount++;
        items.push(itemResult);
        continue;
      }

      if (!isDryRun) {
        try {
          const created = await this.feeDomain.create(
            {
              businessKey: itemResult.businessKey,
              source: 'AUTOMATIC',
              type: 'TUITION',
              studentId,
              parentId,
              billingMonth,
              schoolYear,
              amount: finalAmount,
              evidence: {
                generator: 'TUITION_V1',
                definitionCode: def.code,
                namhocphi,
                baseFee,
                discount,
                studentName: s.name,
              },
            },
            actorId || '000000000000000000000000'
          );
          itemResult.status = 'CREATED';
          itemResult.feeCode = created.code;
          createdCount++;
        } catch (err) {
          itemResult.status = 'FAILED';
          itemResult.reason = err.message;
          failedCount++;
        }
      } else {
        itemResult.status = 'WILL_CREATE';
        createdCount++;
      }

      items.push(itemResult);
    }

    return { items, createdCount, skippedCount, failedCount };
  }

  // ==========================================
  // GENERATOR 2: CAMERA_V1
  // ==========================================
  async generateCamera(def, billingMonth, schoolYear, isDryRun, actorId) {
    const config = def.generatorConfig ? JSON.parse(def.generatorConfig) : {};
    const unitPrice = Number(config.unitPrice) || 50000;
    const freePhones = Number(config.freePhones) || 1;

    // Quét các phụ huynh có con đang học
    const activeStudents = await this.collections.Student.find({ status: 'DANG_HOC' }).toArray();
    const parentIds = [...new Set(activeStudents.map(s => s.parent && String(s.parent)).filter(Boolean))];

    const parents = await this.collections.Parent.find({ _id: { $in: parentIds.map(id => this.id(id)) } }).toArray();
    const phones = await this.collections.Phone.find({ parent: { $in: parents.map(p => p._id) } }).toArray();

    const phonesByParent = new Map();
    for (const ph of phones) {
      const pId = String(ph.parent);
      if (!phonesByParent.has(pId)) phonesByParent.set(pId, []);
      phonesByParent.get(pId).push(ph.number);
    }

    const items = [];
    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const p of parents) {
      const parentId = String(p._id);
      const activePhonesList = [...new Set(phonesByParent.get(parentId) || [])];
      const activeCount = activePhonesList.length;
      const billableCount = Math.max(0, activeCount - freePhones);
      const amount = billableCount * unitPrice;

      const itemResult = {
        targetId: parentId,
        targetName: p.name || `Phụ huynh ${p.code || ''}`,
        targetCode: p.code || '',
        businessKey: `CAMERA:${def.code}:${parentId}:${billingMonth}`,
        amount,
        status: 'READY',
        reason: '',
      };

      if (amount <= 0) {
        itemResult.status = 'SKIPPED_ZERO';
        itemResult.reason = `Số điện thoại (${activeCount}) <= số miễn phí (${freePhones}), không thu tiền`;
        skippedCount++;
        items.push(itemResult);
        continue;
      }

      const existingFee = await this.fees.findOne({ businessKey: itemResult.businessKey });
      if (existingFee) {
        itemResult.status = 'ALREADY_EXISTS';
        itemResult.feeCode = existingFee.code;
        itemResult.reason = `Đã tồn tại khoản phí camera ${existingFee.code} cho tháng ${billingMonth}`;
        skippedCount++;
        items.push(itemResult);
        continue;
      }

      if (!isDryRun) {
        try {
          const created = await this.feeDomain.create(
            {
              businessKey: itemResult.businessKey,
              source: 'AUTOMATIC',
              type: 'CAMERA',
              parentId,
              billingMonth,
              schoolYear,
              amount,
              evidence: {
                generator: 'CAMERA_V1',
                definitionCode: def.code,
                activeCount,
                freePhones,
                billableCount,
                unitPrice,
                phones: activePhonesList,
              },
            },
            actorId || '000000000000000000000000'
          );
          itemResult.status = 'CREATED';
          itemResult.feeCode = created.code;
          createdCount++;
        } catch (err) {
          itemResult.status = 'FAILED';
          itemResult.reason = err.message;
          failedCount++;
        }
      } else {
        itemResult.status = 'WILL_CREATE';
        createdCount++;
      }

      items.push(itemResult);
    }

    return { items, createdCount, skippedCount, failedCount };
  }

  // ==========================================
  // GENERATOR 3: FIXED_AMOUNT_V1
  // ==========================================
  async generateFixedAmount(def, billingMonth, schoolYear, isDryRun, actorId) {
    const scope = def.scopeConfig ? JSON.parse(def.scopeConfig) : {};
    const amount = Number(def.defaultAmount) || 0;
    if (amount <= 0) throw new Error('Số tiền cố định cấu hình phải lớn hơn 0');

    const query = { status: 'DANG_HOC' };
    if (scope.classIds && scope.classIds.length) {
      query.lophoc = { $in: scope.classIds.map(id => this.id(id)) };
    }

    const students = await this.collections.Student.find(query).toArray();
    const items = [];
    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const s of students) {
      const studentId = String(s._id);
      const parentId = s.parent ? String(s.parent) : null;

      const itemResult = {
        targetId: studentId,
        targetName: s.name,
        targetCode: s.sName || '',
        businessKey: `FIXED:${def.code}:${studentId}:${billingMonth}`,
        amount,
        status: 'READY',
        reason: '',
      };

      const existingFee = await this.fees.findOne({ businessKey: itemResult.businessKey });
      if (existingFee) {
        itemResult.status = 'ALREADY_EXISTS';
        itemResult.feeCode = existingFee.code;
        itemResult.reason = `Đã tồn tại khoản phí ${existingFee.code}`;
        skippedCount++;
        items.push(itemResult);
        continue;
      }

      if (!isDryRun) {
        try {
          const created = await this.feeDomain.create(
            {
              businessKey: itemResult.businessKey,
              source: 'AUTOMATIC',
              type: def.feeType,
              studentId,
              parentId,
              billingMonth,
              schoolYear,
              amount,
              evidence: {
                generator: 'FIXED_AMOUNT_V1',
                definitionCode: def.code,
                definitionName: def.name,
              },
            },
            actorId || '000000000000000000000000'
          );
          itemResult.status = 'CREATED';
          itemResult.feeCode = created.code;
          createdCount++;
        } catch (err) {
          itemResult.status = 'FAILED';
          itemResult.reason = err.message;
          failedCount++;
        }
      } else {
        itemResult.status = 'WILL_CREATE';
        createdCount++;
      }

      items.push(itemResult);
    }

    return { items, createdCount, skippedCount, failedCount };
  }

  // ==========================================
  // TẠO THỦ CÔNG ÍT CLICK (MANUAL BULK)
  // ==========================================
  async createManualBulk(input, actorId) {
    const { feeType, studentIds = [], parentIds = [], amount, billingMonth, schoolYear, reason } = input;
    if (!feeType) throw new Error('Cần chọn loại phí');
    const numAmount = Number(amount);
    if (!Number.isInteger(numAmount) || numAmount === 0) throw new Error('Số tiền phải là số nguyên khác 0');
    if (!studentIds.length && !parentIds.length) throw new Error('Cần chọn ít nhất 1 học sinh hoặc phụ huynh');

    const createdFees = [];
    const errors = [];
    const timestamp = Date.now().toString().slice(-6);

    // Xử lý học sinh
    for (const sId of studentIds) {
      const student = await this.collections.Student.findOne({ _id: this.id(sId) });
      if (!student) {
        errors.push({ id: sId, error: 'Không tìm thấy học sinh' });
        continue;
      }
      const bKey = `MANUAL:${feeType}:${sId}:${billingMonth || schoolYear || timestamp}:${timestamp}`;
      try {
        const fee = await this.feeDomain.create(
          {
            businessKey: bKey,
            source: 'MANUAL',
            type: feeType,
            studentId: sId,
            parentId: student.parent ? String(student.parent) : null,
            billingMonth,
            schoolYear,
            amount: numAmount,
            evidence: {
              source: 'MANUAL_BULK',
              reason: reason || 'Tạo chủ động qua hệ thống khoản phí',
              studentName: student.name,
            },
          },
          actorId
        );
        createdFees.push(fee);
      } catch (err) {
        errors.push({ id: sId, name: student.name, error: err.message });
      }
    }

    // Xử lý phụ huynh nếu có
    for (const pId of parentIds) {
      const parent = await this.collections.Parent.findOne({ _id: this.id(pId) });
      if (!parent) {
        errors.push({ id: pId, error: 'Không tìm thấy phụ huynh' });
        continue;
      }
      const bKey = `MANUAL:${feeType}:${pId}:${billingMonth || schoolYear || timestamp}:${timestamp}`;
      try {
        const fee = await this.feeDomain.create(
          {
            businessKey: bKey,
            source: 'MANUAL',
            type: feeType,
            parentId: pId,
            billingMonth,
            schoolYear,
            amount: numAmount,
            evidence: {
              source: 'MANUAL_BULK',
              reason: reason || 'Tạo chủ động qua hệ thống khoản phí',
              parentName: parent.name,
            },
          },
          actorId
        );
        createdFees.push(fee);
      } catch (err) {
        errors.push({ id: pId, name: parent.name, error: err.message });
      }
    }

    return {
      success: true,
      createdCount: createdFees.length,
      failedCount: errors.length,
      createdFees,
      errors,
    };
  }

  // ==========================================
  // LỊCH SỬ RUN LOGS
  // ==========================================
  async listRuns(query = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const where = {};
    if (query.defId) where.feeDefinition = this.id(query.defId);

    const [rows, total] = await Promise.all([
      this.runs.find(where).sort({ startedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      this.runs.countDocuments(where),
    ]);

    const defIds = [...new Set(rows.map(r => String(r.feeDefinition)))];
    const defs = await this.definitions.find({ _id: { $in: defIds.map(id => this.id(id)) } }).toArray();
    const defMap = new Map(defs.map(d => [String(d._id), d.name]));

    return {
      page,
      limit,
      total,
      rows: rows.map(r => ({
        id: String(r._id),
        code: r.code,
        defId: String(r.feeDefinition),
        defName: defMap.get(String(r.feeDefinition)) || 'Không rõ',
        billingMonth: r.billingMonth,
        schoolYear: r.schoolYear,
        trigger: r.trigger,
        status: r.status,
        totalTargets: r.totalTargets,
        createdCount: r.createdCount,
        skippedCount: r.skippedCount,
        failedCount: r.failedCount,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        runByName: r.runByName,
      })),
    };
  }

  async getRunDetail(id) {
    const r = await this.runs.findOne({ _id: this.id(id) });
    if (!r) throw new Error('Không tìm thấy lần chạy');
    const def = await this.definitions.findOne({ _id: r.feeDefinition });
    return {
      id: String(r._id),
      code: r.code,
      defId: String(r.feeDefinition),
      defName: def?.name || 'Không rõ',
      billingMonth: r.billingMonth,
      schoolYear: r.schoolYear,
      trigger: r.trigger,
      status: r.status,
      totalTargets: r.totalTargets,
      createdCount: r.createdCount,
      skippedCount: r.skippedCount,
      failedCount: r.failedCount,
      items: r.itemsData ? JSON.parse(r.itemsData) : [],
      errorSummary: r.errorSummary,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      runByName: r.runByName,
    };
  }
}

module.exports = { FeeGenerationService, calculateNextRunDate };
