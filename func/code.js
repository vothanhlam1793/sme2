const { gql } = require('apollo-server-express');
function sixValue(number) {
    return ("0000000" + number).substring(("0000000" + number).length - 6, ("0000000" + number).length)
}
var arrLog = [];
var stateArrLog = "IDLE";
module.exports = {
    async getCode(context, type) {
        // console.log("GET CODE: ", type);
        var code = "";
        // Chưa có - tiến hành tạo đối tượng mới
        const { data, error } = await context.executeGraphQL({
            context,
            query: gql`
                query {
                    allVariables(where: {key: "${type}CODE"}){
                        key
                        id
                        value
                    }
                }
            `
        });
        // console.log(data);
        if (data.allVariables.length == 0) {
            // Chưa có - tiến hành tạo mới
            code = type + sixValue(1);

            // Lưu lại giá trị mới
            await context.executeGraphQL({
                context,
                query: gql`
                    mutation {
                        createVariable (data: {
                            key: "${type}CODE",
                            value: "2",
                        }) {
                            key
                            value
                            slug
                        }
                    }
                `
            });
        } else {
            code = type + sixValue(parseInt(data.allVariables[0].value));
            await context.executeGraphQL({
                context,
                query: gql`
                    mutation updateValue($id: ID!, $value: String){
                        updateVariable (id: $id, data: {
                            value: $value,
                        }) {
                            key
                            value
                            slug
                        }
                    }
                `,
                variables: {
                    id: data.allVariables[0].id,
                    value: (parseInt(data.allVariables[0].value) + 1).toString()
                }
            });
        }
        return code;
    },
    async getStudent(context, id) {
        const { data, error } = await context.executeGraphQL({
            context,
            query: gql`
            query {
                Student (where: {id: "${id}"}){
                  id
                  name
                  status
                  lophoc {
                    id
                  }
                  hocphi
                  luuy
                  parent {
                    id
                    name
                    debt
                    phone {
                      number
                    }
                    status
                    code
                  }
                }
              }
            `
        });
        return data.Student;
    },
    async getParent(context, id) {
        const { data, error } = await context.executeGraphQL({
            context,
            query: gql
                `query {
                Parent (where: {id: "${id}"}){
                  debt
                  id
                  code
                  name
                  phone {
                    number
                  }
                  status
                }
            }`
        });
        return data.Parent;
    },
    async updateParentDebt(context, d) {
        const { data, error } = await context.executeGraphQL({
            context,
            query: gql
                `mutation {
                updateParent(id: "${d.id}", data: {
                    debt: ${d.debt}
                }){
                    id
                }
            }`
        });
        return data;
    },
    async deleteItemsKetSo(context, data) {
        data.forEach(async function (item) {
            await context.executeGraphQL({
                query: gql`
                mutation {
                    deleteItemKetSo (id: "${item}"){
                      id
                    }
                  }
                `
            })
        });
        return;
        // var str = "[";
        // data.forEach(function(e, i){
        //     if(i != 0){
        //         str += ",";
        //     }
        //     str += `"${e}"`;
        // })
        // str += "]";
        // const {data1, error} = await context.executeGraphQL({
        //     context,
        //     query: gql
        //     `mutation {
        //         deleteItemKetSos (ids: ${str}){
        //           id
        //         }
        //     }`  
        // });
    },
    async getPhieuKetSo(context, id) {
        const { data, error } = await context.executeGraphQL({
            context,
            query: gql
                `query {
                PhieuKetSo (where: {id: "${id}"}){
                  items{
                    id
                  }
                }
            }`
        });
        return data.PhieuKetSo;
    },
    async createPhieuThu(context, d1) {
        // console.log("Dao phieu thu");
        const { data, errors } = await context.executeGraphQL({
            context,
            query: gql`
            mutation {
                createPhieuThu(data: {
                      total: ${d1.total},
                  parent: {
                    connect: {
                      id: "${d1.idParent}"
                    }
                  },
                  createdAt: "${(new Date()).toISOString()}",
                  itemThu: "${d1.item}",
                  idItemThu: "${d1.idItem}"
                }){
                  id
                }
              }
            `
        });
        // console.log("CODE TAO PHIEU THU", errors, data);
        return data.createPhieuThu;

    },
    async createLog(context, obj) {
        // console.log("CREATE-LOG", obj);
        const { data, errors } = await context.executeGraphQL({
            query: gql`
            mutation {
                createLog (data: {
                  item: "${obj.item}",
                  idItem: "${obj.idItem}",
                  itemS: "${obj.itemS}",
                  idItemS: "${obj.idItemS}",
                  key: "${obj.key}",
                  value: "${obj.value}",
                  createdAt: "${obj.createdAt}",
                  createdTime: ${obj.createdTime},
                  type: "${obj.type}",
                  valueChange: "${obj.valueChange}"
                }){
                  id
                  item
                  idItem
                }
            }
            `
        });
        if (errors) {
            // console.log("ERRORS - CREATE LOG", errors);
        } else {
            // console.log(data);
        }
        return data;
    },
    async searchLogByTime(context, obj) {
        var { data, errors } = await context.executeGraphQL({
            query: gql`
            query {
                allLogs(where: {
                  key: "${obj.key}",
                  item: "${obj.item}",
                  idItem: "${obj.idItem}",
                  createdTime_gte: ${parseInt(obj.time)}
                }){
                    id item itemS idItem idItemS key value createdTime type valueChange createdAt
                }
            }
            `
        });
        return data.allLogs;
    },
    async updateValueLog(context, idLog, value, valueChange) {
        var ret = await context.executeGraphQL({
            query: gql`
            mutation {
                updateLog(id: "${idLog}", data: {
                  value: "${value}",
                  valueChange: "${valueChange}"
                }) {
                    id item itemS idItem idItemS key value createdTime type valueChange
                }
            }
            `
        })
        // console.log("RETSULT", ret);
        return ret;
    },
    async getLogByItem(context, obj) {
        // console.log(obj);
        var { data, errors } = await context.executeGraphQL({
            query: gql`
            query {
                allLogs(where: {
                    itemS: "${obj.itemS}",
                    idItemS: "${obj.idItemS}",
                    
                    key: "${obj.key}",
                    item: "${obj.item}",
                    idItem: "${obj.idItem}",
                }){
                  id item itemS idItem idItemS key value createdTime createdAt type valueChange createdAt
                }
            }
            `
        });
        // console.log("GET LOG BY TIME - ", data);
        return data.allLogs[0];
    },
    async startUpdateDebtPrentLog(context) {
        var data = arrLog.pop();
        // console.log("START", data);
        if (data == undefined) {
            stateArrLog = "IDLE";
            return;
        } else {
            stateArrLog = "RUNNING";
        }
        // console.log("RUNNING - ", data, stateArrLog);
        var ret = await this.updateRunDebtParentByLog(context, data);
        // console.log("RET", ret);
        if (data.length == 0) {
            stateArrLog = "IDLE";
            return;
        } else {
            await this.startUpdateDebtPrentLog(context);
        }
    },
    async updateDebtParentByLog(context, data) {
        arrLog.push(data);
        if (stateArrLog == "IDLE") {
            // Khoi dong vong lap 
            // console.log("Khoi dong vong lap", arrLog);
            this.startUpdateDebtPrentLog(context);
        } else {
            // console.log("DANG CHAY", stateArrLog. arrLog);
        }
        return;
    },
    async updateRunDebtParentByLog(context, data) {
        // console.log("ITEM DATA", data);
        if ((data.item == undefined)
            || (data.idItem == undefined)
            || (data.itemS == undefined)
            || (data.idItemS == undefined)
        ) {
            return;
        }
        /*
            data: {
                valueDebt       : +/- value
                item/idItem     : Parent
                itemS/idItemS   : 
                type            : "UP"/"DOWN" 
            }
        */
        // console.log(data);
        var parent = await this.getParent(context, data.idItem);
        // console.log("ITEM PARENT ",parent);
        var debt = parent.debt;
        if (debt == null) {
            debt = 0;
        }

        // console.log("UPDATE - DONE PARENT");
        if (data.actionLog == "CREATE") {
            // Neu moi thi cap nhat don gian la xong
            if (data.type == "UP") {
                debt += parseInt(data.valueDebt);
            } else if (data.type == "DOWN") {
                debt -= parseInt(data.valueDebt);
            }

            var oData = {
                item: data.item,
                idItem: data.idItem,
                key: "debt",
                value: debt,
                createdAt: (new Date()).toISOString(),
                createdTime: parseInt((new Date()).getTime() / 1000),
                type: data.type,
                valueChange: data.valueDebt
            }
            oData.itemS = data.itemS;
            oData.idItemS = data.idItemS;
            // console.log(oData);
            await this.createLog(context, oData)
            await this.updateParentDebt(context, {
                id: parent.id,
                debt: debt
            });
            return;
        }

        if (data.actionLog == "DELETE") {
            // Thay doi nhung du lieu qua khu
            data.key = "debt";

            // Tai log hien tai
            var log = await this.getLogByItem(context, data);

            if (log == undefined) {
                return;
            }
            // Lay thoi gian bat dau tim kiem
            data.time = log.createdTime;

            // Tai logs bi anh huong
            var logs = await this.searchLogByTime(context, data);
            var that = this;

            logs = logs.map(function (e) {
                e.count = (new Date(e.createdAt)).getTime();
                return e;
            });
            log.count = (new Date(log.createdAt)).getTime();

            // console.log("LOG", log);
            // console.log("LOGS", logs);

            logs.forEach(async function (item) {
                if (item.count > log.count) {
                    if (log.type == "UP") {
                        await that.updateValueLog(
                            context,
                            item.id,
                            parseInt(item.value) - parseInt(log.valueChange),
                            parseInt(item.valueChange)
                        );
                    } else {
                        await that.updateValueLog(
                            context,
                            item.id,
                            parseInt(item.value) + parseInt(log.valueChange),
                            parseInt(item.valueChange)
                        );
                    }
                }
            });

            // Cap nhat no hien tai
            if (log.type == "UP") {
                debt -= parseInt(log.valueChange);
            } else {
                debt += parseInt(log.valueChange);
            }
            await this.updateParentDebt(context, {
                id: parent.id,
                debt: debt
            });
            // Xoa log hien tai
            await context.executeGraphQL({
                query: gql`
                mutation {
                    deleteLog(id: "${log.id}"){
                      id
                    }
                } 
                `
            });
            return;
        }

        if (data.actionLog == "UPDATE") {
            // Thay doi nhung du lieu qua khu
            data.key = "debt";

            // Tai log hien tai
            var log = await this.getLogByItem(context, data);
            if (log == undefined) {
                return;
            }

            // Lay thoi gian bat dau tim kiem
            data.time = log.createdTime;

            // Tai logs bi anh huong
            var logs = await this.searchLogByTime(context, data);
            var that = this;

            logs = logs.map(function (e) {
                e.count = (new Date(e.createdAt)).getTime();
                return e;
            });
            log.count = (new Date(log.createdAt)).getTime();

            // Tinh toan su sai khac
            logs.forEach(async function (item) {
                if (item.count > log.count) {
                    if (log.type == "UP") {
                        await that.updateValueLog(
                            context,
                            item.id,
                            parseInt(item.value) - parseInt(log.valueChange) + parseInt(data.valueDebt),
                            parseInt(item.valueChange)
                        );
                    } else {
                        await that.updateValueLog(
                            context,
                            item.id,
                            parseInt(item.value) + parseInt(log.valueChange) - parseInt(data.valueDebt),
                            parseInt(item.valueChange)
                        );
                    }
                }
            });

            // Cap nhat no hien tai
            if (log.type == "UP") {
                debt = debt - parseInt(log.valueChange) + parseInt(data.valueDebt);
            } else {
                debt = debt + parseInt(log.valueChange) - parseInt(data.valueDebt);
            }

            await this.updateParentDebt(context, {
                id: parent.id,
                debt: debt
            });

            // Cap nhat Log hien tai
            if (log.type == "UP") {
                await that.updateValueLog(
                    context,
                    log.id,
                    parseInt(log.value) - parseInt(log.valueChange) + parseInt(data.valueDebt),
                    parseInt(data.valueDebt)
                );
            } else {
                await that.updateValueLog(
                    context,
                    log.id,
                    parseInt(log.value) + parseInt(log.valueChange) - parseInt(data.valueDebt),
                    parseInt(data.valueDebt)
                );
            }
            return;
        }

        // if ((data.actionLog == "UPDATE")){
        //     data.key = "debt";
        //     var log = await this.getLogByItem(context, data);
        //     // console.log("ITEM LOG", log);
        //     if(log == undefined){
        //         return;
        //     }
        //     // console.log("ONE", log);
        //     data.time = log.createdTime;
        //     var logs = await this.searchLogByTime(context, data);
        //     var that = this;

        //     // console.log("LOGS", logs);
        //     var denta = 0;
        //     var vNow = (data.actionLog == "DELETE") ? 0:data.valueDebt;

        //     if(data.actionLog == "UPDATE"){
        //         if(data.type == "UP"){
        //             if(log.type == "UP"){
        //                 denta = parseInt(vNow) - parseInt(log.valueChange);
        //             } else {
        //                 denta = parseInt(vNow) + parseInt(log.valueChange);
        //             }
        //         } else {
        //             // data.type == "DOWN"
        //             if(log.type == "UP"){
        //                 denta = - parseInt(vNow) - parseInt(log.valueChange);
        //             } else {
        //                 denta = - parseInt(vNow) + parseInt(log.valueChange);
        //             }
        //         }
        //         debt += denta;
        //     }
        //     // console.log("DENTA",denta,vNow);
        //     if(data.actionLog == "UPDATE"){
        //         logs.forEach(async function(item){
        //             if(item.id == log.id){
        //                 await that.updateValueLog(
        //                     context, 
        //                     item.id,
        //                     parseInt(item.value) + parseInt(denta),
        //                     parseInt(item.valueChange) + parseInt(denta));
        //             } else {
        //                 await that.updateValueLog(
        //                     context, 
        //                     item.id,
        //                     parseInt(item.value) + parseInt(denta),
        //                     parseInt(item.valueChange));
        //             }
        //         });
        //     } else {
        //         logs.forEach(async function(item){
        //             if(item.id == log.id){
        //                 return;
        //             }
        //             if(log.type == "UP"){
        //                 await that.updateValueLog(
        //                     context, 
        //                     item.id,
        //                     parseInt(item.value) - parseInt(log.valueChange),
        //                     parseInt(item.valueChange));
        //             } else {
        //                 await that.updateValueLog(
        //                     context, 
        //                     item.id,
        //                     parseInt(item.value) + parseInt(log.valueChange),
        //                     parseInt(item.valueChange));
        //             }
        //         });
        //         // Xoa doi tuong
        //     }
        // }
    },
    async connectHoaDonWithItemKetSo(context, data) {
        var ret = await context.executeGraphQL({
            query: gql`
            mutation {
                updateHoaDon (id: "${data.idHoaDon}", data: {
                  item: "ItemKetSo",
                  idItem: "${data.idItemKetSo}"
                }) {
                  id
                }
            }
            `
        });
        if (ret.errors) {
            console.log("ERROR - CONNECT - HD- IKS", errors);
            return;
        } else {
            return ret.data;
        }
    },
    async disconnectHoaDonWithItemKetSo(context, data) {
        var ret = await context.executeGraphQL({
            query: gql`
            mutation {
                updateHoaDon (id: "${data.idHoaDon}", data: {
                  item: "",
                  idItem: ""
                }) {
                  id
                  item
                  idItem
                }
            }
            `
        });
        if (ret.errors) {
            console.log("ERROR - CONNECT - HD- IKS", errors);
            return;
        } else {
            console.log(ret.data);
            return ret.data;
        }
    },
    async updateHoaDonWithItemKetSo(context, reso, exist) {
        var oHoaDons = [];
        var temp = {};
        try {
            temp = JSON.parse(exist.data);
        } catch (e) {
            console.log("ERRORS", e);
        }
        if (temp.hoadons) {
            oHoaDons = temp.hoadons;
        }
        // console.log("EXIST - ", exist);
        // console.log("HOA DON - ", oHoaDons);
        var that = this;
        oHoaDons.forEach(async function (hoadon) {
            await that.disconnectHoaDonWithItemKetSo(context, {
                idHoaDon: hoadon.id,
                idItemKetSo: exist.id
            });
        })

        reso.hoadons.forEach(async function (hoadon) {
            await that.connectHoaDonWithItemKetSo(context, {
                idHoaDon: hoadon.id,
                idItemKetSo: exist.id
            });
        })
    }
}