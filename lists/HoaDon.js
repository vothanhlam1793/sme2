const { Text, Checkbox, Relationship, Integer, DateTime } = require('@keystonejs/fields');
const code = require('../func/code');
const { gql } = require('apollo-server-express');
module.exports = {
    fields: {
        createdAt: {
            type: Text
        },
        items: {
            type: Relationship,
            ref: "Item.hoadon",
            many: true
        },
        total: {
            type: Integer
        },
        giamgia: {
            type: Integer
        },
        code: {
            type: Text,
            isUnique: true
        },
        subCode: {
            type: Text,
        },
        parent: {
            type: Relationship,
            ref: "Parent",
            many: false
        },
        student: {
            type: Relationship,
            ref: "Student",
            many: false
        },
        type: {
            type: Text,
        },
        phieuthu: {
            type: Relationship,
            ref: "PhieuThu",
            many: false
        },
        // Danh cho lien ket ngoai
        idItem: {
            type: Text,
            defaultValue: ""
        },
        item: {
            type: Text,
            defaultValue: ""
        }
    },
    hooks: {
        validateInput: async ({operation, resolvedData, context}) => {
            if(operation == "create"){
                if(resolvedData.code == undefined){
                    resolvedData.code = await code.getCode(context, "HD");
                } else {

                }
            }
        },
        afterChange: async ({operation, updatedItem, context, originalInput}) => {
            // console.log("AFTER", operation, originalInput);
            if(operation == "create"){
                // Neu type == THANHTOAN
                // 1. Tao no cho parent
                // 2. Tao phieu thu cho parent bang dung so tien
                // console.log("hoadon: ", resolvedData);
                await code.updateDebtParentByLog(context, {
                    type: "UP",
                    valueDebt: updatedItem.total,
                    item: "Parent",
                    idItem: updatedItem.parent,
                    itemS: "HoaDon",
                    idItemS: updatedItem.id,
                    actionLog: "CREATE"
                });
                if(updatedItem.type == "THANHTOAN"){
                    // console.log("Tao phieu thu");
                    var phieuthu = await code.createPhieuThu(context, {
                        total: originalInput.total,
                        idParent: updatedItem.parent,
                        item: "HoaDon",
                        idItem: updatedItem.id
                    });
                    resolvedData.phieuthu = phieuthu.id;
                }
            } 

        },
        beforeChange: async ({operation, resolvedData, existingItem, context}) => {
            console.log("before", resolvedData, operation);
        },
        beforeDelete: async ({context, existingItem}) => {
            console.log("DELETA", existingItem);
            // Xoá các phần tử của hoá đơn
            const {data, error} = await context.executeGraphQL({
                context,
                query: gql`
                query {
                    HoaDon(where: {id: "${existingItem.id}"}){
                      items{
                        id
                      }
                    }
                }
                `
            });
            data.HoaDon.items.forEach(async function (e){
                await context.executeGraphQL({
                    context,
                    query: gql`
                        mutation{
                            deleteItem (id: "${e.id}"){
                                id
                            }   
                        }
                    `
                })
            });

            // Xoá các log liên quan
            await code.updateDebtParentByLog(context, {
                type: "UP",
                valueDebt: existingItem.total,
                item: "Parent",
                idItem: existingItem.parent,
                itemS: "HoaDon",
                idItemS: existingItem.id,
                actionLog: "DELETE"
            });
            // console.log("EXIST",existingItem);
                // Neu type == THANHTOAN
                // 1. Xoa phieu thu da ket hop
                // 2. Xoa no da tao cho parent
            if(existingItem.type == "THANHTOAN"){
                var ret = await context.executeGraphQL({
                    query: gql`
                    query {
                        allPhieuThus(where: {
                          itemThu: "HoaDon",
                          idItemThu: "${existingItem.id}"
                        }){
                          id
                        }
                      }
                    `
                });
                if(ret.errors){
                    console.log("ERROR - DELETE - HOADON", errors);
                    return;
                } else {
                    if(ret.data.allPhieuThus.length > 0){
                        ret.data.allPhieuThus.forEach(async function(phieuthu){
                            await context.executeGraphQL({
                                context,
                                query: gql`
                                mutation {
                                    deletePhieuThu(id: "${phieuthu.id}"){
                                    id
                                    }
                                }
                                `
                            });
                        });
                    }
                }
            }

            // Xoá các log có liên quan đến NGHI
            if(existingItem.type == "NORMAL"){
                var d = await context.executeGraphQL({
                    context,
                    query: gql`
                    query {
                        allLogs(where: {
                        item: "Student",
                        key: "HOC_PHI_THANG",
                        itemS: "HoaDon",
                        idItemS: "${existingItem.id}"
                        }) {
                            id item itemS idItem idItemS key value
                        }
                    }
                    `
                });
                d.data.allLogs.forEach(async function(log){
                    await context.executeGraphQL({
                        context,
                        query: gql`
                            mutation{
                                deleteLog (id: "${log.id}"){
                                    id
                                }   
                            }
                        `
                    });
                });
            }

        }
    }

};