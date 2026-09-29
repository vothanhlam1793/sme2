const { Text, Select, Integer, DateTime, Relationship } = require('@keystonejs/fields');
const { access } = require('../setting/access');

function configureFeeDefinitionSchema(schema) {
  schema.index({ status: 1, generationMode: 1, nextRunAt: 1 }, { name: 'fee_def_scheduler' });
}

module.exports = {
  adapterConfig: { configureMongooseSchema: configureFeeDefinitionSchema },
  fields: {
    code: { type: Text, isRequired: true, isUnique: true },
    name: { type: Text, isRequired: true },
    feeType: {
      type: Select,
      options: [
        { value: 'TUITION', label: 'Học phí' },
        { value: 'CAMERA', label: 'Camera' },
        { value: 'FACILITY', label: 'Cơ sở vật chất' },
        { value: 'EXTENDED', label: 'Phí mở rộng' },
        { value: 'ABSENCE_CREDIT', label: 'Giảm nghỉ học' },
      ],
      isRequired: true,
    },
    status: {
      type: Select,
      options: [
        { value: 'ENABLED', label: 'Đang bật' },
        { value: 'DISABLED', label: 'Tạm tắt' },
      ],
      defaultValue: 'ENABLED',
      isRequired: true,
    },
    generationMode: {
      type: Select,
      options: [
        { value: 'AUTOMATIC', label: 'Tự động định kỳ (Cron)' },
        { value: 'MANUAL', label: 'Chủ động nghiệp vụ' },
      ],
      isRequired: true,
    },
    generatorKey: {
      type: Select,
      options: [
        { value: 'TUITION_V1', label: 'Bộ tính Học phí V1' },
        { value: 'CAMERA_V1', label: 'Bộ tính Camera V1' },
        { value: 'FIXED_AMOUNT_V1', label: 'Số tiền cố định V1' },
        { value: 'MANUAL_ONLY', label: 'Tạo chủ động bằng tay' },
      ],
      isRequired: true,
    },
    subjectType: {
      type: Select,
      options: [
        { value: 'STUDENT', label: 'Học sinh' },
        { value: 'PARENT', label: 'Phụ huynh' },
      ],
      defaultValue: 'STUDENT',
      isRequired: true,
    },
    frequency: {
      type: Select,
      options: [
        { value: 'MONTHLY', label: 'Hàng tháng' },
        { value: 'SCHOOL_YEAR', label: 'Theo năm học' },
        { value: 'ONE_TIME', label: 'Một lần / Theo đợt' },
      ],
      defaultValue: 'MONTHLY',
      isRequired: true,
    },
    defaultAmount: { type: Integer, defaultValue: 0 },
    scheduleDay: { type: Integer, defaultValue: 25 },
    scheduleHour: { type: Integer, defaultValue: 1 },
    timezone: { type: Text, defaultValue: 'Asia/Ho_Chi_Minh' },
    scopeConfig: { type: Text, defaultValue: '{}' },
    generatorConfig: { type: Text, defaultValue: '{}' },
    lastRunAt: { type: DateTime },
    nextRunAt: { type: DateTime },
    lastRunStatus: { type: Text },
    createdAt: { type: DateTime },
    createdBy: { type: Relationship, ref: 'User', many: false },
    updatedAt: { type: DateTime },
    updatedBy: { type: Relationship, ref: 'User', many: false },
  },
  access: { read: access.userIsAdmin, create: false, update: false, delete: false },
};
