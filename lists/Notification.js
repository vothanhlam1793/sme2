const { Text, Select, Relationship, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');

module.exports = {
    fields: {
        code: {
            type: Text,
            isUnique: true
        },
        title: {
            type: Text,
            isRequired: true
        },
        content: {
            type: Text,
            isRequired: true
        },
        scope: {
            type: Select,
            options: [
                { value: 'ALL_SCHOOL', label: 'Toàn trường' },
                { value: 'CLASS', label: 'Theo lớp' }
            ],
            defaultValue: 'ALL_SCHOOL',
            isRequired: true
        },
        classes: {
            type: Relationship,
            ref: 'LopHoc',
            many: true
        },
        status: {
            type: Select,
            options: [
                { value: 'PUBLISHED', label: 'Đã xuất bản' },
                { value: 'DRAFT', label: 'Bản nháp' }
            ],
            defaultValue: 'PUBLISHED'
        },
        publishedAt: {
            type: DateTime
        },
        createdBy: {
            type: Relationship,
            ref: 'User',
            many: false
        },
        updatedBy: {
            type: Relationship,
            ref: 'User',
            many: false
        }
    },
    access: {
        auth: true
    },
    hooks: {
        validateInput: async ({ operation, resolvedData, context }) => {
            if (operation === 'create') {
                if (!resolvedData.code) {
                    resolvedData.code = await code.getCode(context, 'TB');
                }
                if (!resolvedData.publishedAt) {
                    resolvedData.publishedAt = new Date().toISOString();
                }
            }
            const user = context.authedItem;
            if (user) {
                if (operation === 'create') {
                    resolvedData.createdBy = user.id;
                } else if (operation === 'update') {
                    resolvedData.updatedBy = user.id;
                }
            }
            return resolvedData;
        }
    }
};
