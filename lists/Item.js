const { Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');

module.exports = {
    fields: {
        sanpham: {
            type: Relationship,
            ref: "SanPham",
            many: false
        },
        price: {
            type: Integer
        },
        amount: {
            type: Integer
        },
        total: {
            type: Integer
        },
        hoadon: {
            type: Relationship,
            ref: "HoaDon.items",
            many: false
        }
    },

    hooks: {
        validateInput: async ({operation, resolvedData, context}) => {
            resolvedData.total = resolvedData.price * resolvedData.amount;  
        }
    }
};