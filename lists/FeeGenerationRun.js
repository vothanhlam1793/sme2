const { Text, Select, Integer, DateTime, Relationship } = require('@keystonejs/fields');
const { access } = require('../setting/access');

function configureFeeGenerationRunSchema(schema) {
  schema.index({ feeDefinition: 1, createdAt: -1 }, { name: 'fee_run_by_def' });
  schema.index({ status: 1, createdAt: -1 }, { name: 'fee_run_by_status' });
}

module.exports = {
  adapterConfig: { configureMongooseSchema: configureFeeGenerationRunSchema },
  fields: {
    code: { type: Text, isRequired: true, isUnique: true },
    feeDefinition: { type: Relationship, ref: 'FeeDefinition', many: false, isRequired: true },
    billingMonth: { type: Text },
    schoolYear: { type: Text },
    trigger: {
      type: Select,
      options: [
        { value: 'CRON', label: 'Tự động (Cron)' },
        { value: 'MANUAL_RUN', label: 'Chạy ngay (Thủ công)' },
        { value: 'PREVIEW', label: 'Chạy thử (Xem trước)' },
      ],
      defaultValue: 'CRON',
      isRequired: true,
    },
    status: {
      type: Select,
      options: [
        { value: 'RUNNING', label: 'Đang chạy' },
        { value: 'SUCCESS', label: 'Thành công' },
        { value: 'PARTIAL', label: 'Một phần / Có lỗi' },
        { value: 'FAILED', label: 'Thất bại' },
      ],
      defaultValue: 'RUNNING',
      isRequired: true,
    },
    totalTargets: { type: Integer, defaultValue: 0 },
    createdCount: { type: Integer, defaultValue: 0 },
    skippedCount: { type: Integer, defaultValue: 0 },
    failedCount: { type: Integer, defaultValue: 0 },
    itemsData: { type: Text, defaultValue: '[]' },
    errorSummary: { type: Text, defaultValue: '' },
    startedAt: { type: DateTime },
    completedAt: { type: DateTime },
    runBy: { type: Relationship, ref: 'User', many: false },
    runByName: { type: Text, defaultValue: 'Hệ thống Cron' },
  },
  access: { read: access.userIsAdmin, create: false, update: false, delete: false },
};
