/**
 * ============================================================
 *  在线数据同步模块 - 从腾讯文档获取数据并更新大屏
 * ============================================================
 *  功能：点击"数据更新"按钮，前端直接从腾讯文档API获取
 *        最新数据，解码protobuf，解析后实时更新大屏
 * ============================================================
 */

window.VR_SYNC = (function () {
    "use strict";

    // ===== 配置 =====
    var DOC_ID = "DYk1EZUJBQmR0dmJa";
    var DOC_URL = "https://docs.qq.com/sheet/" + DOC_ID;
    var API_BASE = "https://docs.qq.com/dop-api/opendoc?id=" + DOC_ID;
    var WORK_TYPE_TAB_ID = "dv5mdr";

    // Cloudflare Worker 代理地址（部署后替换为你的 Worker URL）
    // 部署方法见 worker/proxy.js 文件头部说明
    var PROXY_URL = ""; // 例如: "https://vr-proxy.xxx.workers.dev/?url="

    var NUM_COLS = 10;
    var DIRECT_INT_COLS = { 1: true };
    var INDEXED_NUM_COLS = { 4: true, 5: true, 6: true, 8: true };

    var LINE_NAME_MAP = {
        "杭温": "杭温铁路",
        "杭昌": "杭昌高铁",
        "沪昆高铁": "沪昆高铁",
        "沪昆": "沪昆线",
        "衢九": "衢九线",
        "杭衢": "杭衢高铁"
    };

    var LINES_CONFIG = [
        { name: "杭温铁路", code: "hw", color: "#00d4ff" },
        { name: "杭昌高铁", code: "hc", color: "#f59e0b" },
        { name: "沪昆高铁", code: "hk", color: "#10b981" },
        { name: "沪昆线", code: "hkx", color: "#84cc16" },
        { name: "衢九线", code: "qj", color: "#a855f7" },
        { name: "杭衢高铁", code: "hq", color: "#ef4444" }
    ];

    // ===== Protobuf 解码器（最小化实现） =====

    function readVarint(bytes, offset) {
        var result = 0n;
        var shift = 0n;
        while (offset < bytes.length) {
            var byte = bytes[offset];
            result |= BigInt(byte & 0x7f) << shift;
            offset++;
            if ((byte & 0x80) === 0) {
                return { value: result, offset: offset };
            }
            shift += 7n;
            if (shift > 70n) return null;
        }
        return null;
    }

    function addField(result, key, value) {
        if (key in result) {
            if (Array.isArray(result[key])) {
                result[key].push(value);
            } else {
                result[key] = [result[key], value];
            }
        } else {
            result[key] = value;
        }
    }

    function asArray(value) {
        if (value === undefined || value === null) return [];
        return Array.isArray(value) ? value : [value];
    }

    /**
     * 解码 protobuf 消息
     * 返回解码后的对象，如果数据不是有效的 protobuf 则返回 null
     */
    function decodeProtobuf(bytes) {
        var result = {};
        var offset = 0;
        var valid = true;

        while (offset < bytes.length) {
            var tagResult = readVarint(bytes, offset);
            if (!tagResult) { valid = false; break; }
            offset = tagResult.offset;

            var fieldNum = Number(tagResult.value >> 3n);
            var wireType = Number(tagResult.value & 7n);

            if (fieldNum === 0 || fieldNum > 100000) { valid = false; break; }
            var key = String(fieldNum);

            if (wireType === 0) {
                // Varint
                var valResult = readVarint(bytes, offset);
                if (!valResult) { valid = false; break; }
                offset = valResult.offset;
                addField(result, key, valResult.value);
            } else if (wireType === 2) {
                // Length-delimited
                var lenResult = readVarint(bytes, offset);
                if (!lenResult) { valid = false; break; }
                var length = Number(lenResult.value);
                offset = lenResult.offset;
                if (length < 0 || offset + length > bytes.length) { valid = false; break; }
                var data = bytes.subarray(offset, offset + length);
                offset += length;

                // 尝试解码为嵌套消息
                var decoded = null;
                if (data.length > 0) {
                    decoded = decodeProtobuf(data);
                }
                if (decoded !== null) {
                    addField(result, key, decoded);
                } else {
                    addField(result, key, data);
                }
            } else if (wireType === 5) {
                // 32-bit fixed
                if (offset + 4 > bytes.length) { valid = false; break; }
                offset += 4;
            } else if (wireType === 1) {
                // 64-bit fixed
                if (offset + 8 > bytes.length) { valid = false; break; }
                offset += 8;
            } else {
                valid = false;
                break;
            }
        }

        if (!valid || offset !== bytes.length) return null;
        return result;
    }

    /** int64 -> double 转换（与 Python struct.pack/unpack 一致） */
    function int64ToDouble(bigIntValue) {
        var buffer = new ArrayBuffer(8);
        var view = new DataView(buffer);
        try {
            view.setBigInt64(0, bigIntValue, true);
            return view.getFloat64(0, true);
        } catch (e) {
            return 0.0;
        }
    }

    function toBigInt(val) {
        if (typeof val === 'bigint') return val;
        if (typeof val === 'number') return BigInt(Math.trunc(val));
        return 0n;
    }

    function toNum(val) {
        if (val === undefined || val === null) return 0;
        if (typeof val === 'bigint') return Number(val);
        if (typeof val === 'number') return val;
        if (val instanceof Uint8Array) return 0;
        return Number(val) || 0;
    }

    function bytesToText(data) {
        if (data instanceof Uint8Array) {
            return new TextDecoder('utf-8').decode(data);
        }
        if (typeof data === 'string') return data;
        return String(data);
    }

    // ===== Zlib 解压 =====

    async function inflateData(compressed) {
        // 优先使用浏览器内置 DecompressionStream
        if (typeof DecompressionStream !== 'undefined') {
            try {
                var ds = new DecompressionStream('deflate');
                var blob = new Blob([compressed]);
                var stream = blob.stream().pipeThrough(ds);
                var buffer = await new Response(stream).arrayBuffer();
                return new Uint8Array(buffer);
            } catch (e) {
                console.log("[sync] DecompressionStream 失败，尝试 pako...");
            }
        }

        // 回退到 pako
        if (typeof pako !== 'undefined') {
            return pako.inflate(compressed);
        }

        throw new Error("无法解压数据：浏览器不支持 DecompressionStream 且 pako 未加载");
    }

    // ===== 数据获取（通过 Cloudflare Worker 代理） =====

    async function fetchWithFallback(url) {
        // 1. 如果配置了 Cloudflare Worker 代理，直接使用
        if (PROXY_URL) {
            try {
                var resp = await fetch(PROXY_URL + encodeURIComponent(url), {
                    headers: { "Accept": "application/json, text/plain, */*" }
                });
                if (resp.ok) return await resp.json();
                throw new Error("代理返回 " + resp.status);
            } catch (e) {
                throw new Error("代理请求失败: " + e.message);
            }
        }

        // 2. 未配置代理 — 尝试直接请求（大概率因CORS失败）
        try {
            var resp2 = await fetch(url, {
                headers: { "Accept": "application/json, text/plain, */*" }
            });
            if (resp2.ok) return await resp2.json();
        } catch (e) {
            // CORS 失败，预期之中
        }

        // 3. 尝试公共 CORS 代理（不稳定，作为最后手段）
        var proxies = [
            function (u) { return "https://corsproxy.io/?url=" + encodeURIComponent(u); },
            function (u) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); }
        ];

        for (var i = 0; i < proxies.length; i++) {
            try {
                resp2 = await fetch(proxies[i](url));
                if (resp2.ok) return await resp2.json();
            } catch (e) {
                console.log("[sync] 代理 " + (i + 1) + " 失败: " + e.message);
            }
        }

        throw new Error("数据同步需要配置代理。腾讯文档API要求Referer头，浏览器无法直接访问。请联系管理员部署 worker/proxy.js 到 Cloudflare Worker，并将地址填入 sync.js 的 PROXY_URL 变量。当前数据仍可通过后台自动同步任务更新。");
    }

    async function fetchSheetData(tabId) {
        var url = API_BASE + "&normal=1&outformat=1";
        if (tabId) {
            url = API_BASE + "&tab=" + tabId + "&normal=1&outformat=1";
        }
        return await fetchWithFallback(url);
    }

    // ===== 数据解码 =====

    async function decodeApiData(apiData) {
        var cv = apiData.clientVars || {};
        var ccv = cv.collab_client_vars || {};
        var iat = ccv.initialAttributedText || {};
        var textList = iat.text || [];

        if (!textList || textList.length === 0) {
            throw new Error("未找到表格数据 (initialAttributedText.text 为空)");
        }

        var relatedSheet = textList[0].related_sheet || "";
        if (!relatedSheet) {
            throw new Error("related_sheet 字段为空");
        }

        // Base64 解码
        var binaryString = atob(relatedSheet);
        var compressed = new Uint8Array(binaryString.length);
        for (var i = 0; i < binaryString.length; i++) {
            compressed[i] = binaryString.charCodeAt(i);
        }

        // Zlib 解压
        var decompressed = await inflateData(compressed);

        // Protobuf 解码
        var decoded = decodeProtobuf(decompressed);
        if (decoded === null) {
            throw new Error("Protobuf 解码失败");
        }

        // 动态查找包含实际数据的 sheet
        var items = asArray(decoded["1"] && decoded["1"]["5"]);
        var sheetData = null;

        for (var j = 0; j < items.length; j++) {
            var item = items[j];
            for (var key in item) {
                if (key === "1") continue;
                var data = item[key];
                if (data && typeof data === 'object' && !Array.isArray(data) && data["5"] && data["6"]) {
                    var inner = data["5"];
                    if (inner && (inner["1"] || inner["3"])) {
                        sheetData = data;
                        break;
                    }
                }
            }
            if (sheetData) break;
        }

        if (!sheetData) {
            throw new Error("未找到包含数据的 sheet");
        }

        // 提取文本值
        var textValues = [];
        var textItems = asArray(sheetData["5"]["1"]);
        for (var k = 0; k < textItems.length; k++) {
            var val = textItems[k]["1"];
            textValues.push(val ? bytesToText(val) : "");
        }

        // 提取数字值（int64 -> double）
        var numValues = [];
        var numItems = asArray(sheetData["5"]["3"]);
        for (var m = 0; m < numItems.length; m++) {
            var numVal = numItems[m]["1"];
            if (numVal !== undefined && numVal !== null) {
                numValues.push(int64ToDouble(toBigInt(numVal)));
            } else {
                numValues.push(0.0);
            }
        }

        // 提取超链接值
        var hyperlinkValues = [];
        if (sheetData["5"]["2"]) {
            var linkItems = asArray(sheetData["5"]["2"]);
            for (var n = 0; n < linkItems.length; n++) {
                try {
                    var linkData = linkItems[n]["3"] || {};
                    var urlObj = linkData["3"] || {};
                    var urlBytes = urlObj["1"];
                    hyperlinkValues.push(urlBytes ? bytesToText(urlBytes) : "");
                } catch (e) {
                    hyperlinkValues.push("");
                }
            }
        }

        // 提取单元格
        var cells = asArray(sheetData["6"]);

        return {
            textValues: textValues,
            numValues: numValues,
            hyperlinkValues: hyperlinkValues,
            cells: cells
        };
    }

    // ===== 表格重建 =====

    function reconstructTable(extracted) {
        var textValues = extracted.textValues;
        var numValues = extracted.numValues;
        var cells = extracted.cells;
        var hyperlinkValues = extracted.hyperlinkValues;

        // 查找数字索引偏移量
        var numOffset = null;
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            var ci = cell["3"] || {};
            var ctype = toNum(ci["1"]);
            var col = toNum(cell["2"]);

            if (ctype === 2 && col in INDEXED_NUM_COLS) {
                var f2 = ci["2"] || {};
                var f2Val = toNum(f2["1"]);
                if (f2Val > 0) {
                    numOffset = f2Val;
                    break;
                }
            }
        }
        if (numOffset === null) numOffset = 0;

        // 构建 (row, col) -> value 映射
        var table = {};
        for (var i2 = 0; i2 < cells.length; i2++) {
            var c = cells[i2];
            var row = toNum(c["1"]);
            var col = toNum(c["2"]);
            var c2 = c["3"] || {};
            var ctype2 = toNum(c2["1"]);
            var f2b = c2["2"] || {};
            var f2Val2 = f2b["1"] !== undefined ? toNum(f2b["1"]) : null;

            var value = null;

            if (ctype2 === 4) {
                // 文本单元格
                var idx = f2Val2 !== null ? f2Val2 : 0;
                value = idx < textValues.length ? textValues[idx] : "";
            } else if (ctype2 === 6) {
                // 超链接单元格（0-based 索引）
                // hyperlinkValues 列表可能包含未被引用的条目（如已删除的超链接），
                // f2Val 直接作为 0-based 索引使用
                if (f2Val2 !== null && hyperlinkValues.length > 0 && f2Val2 >= 0 && f2Val2 < hyperlinkValues.length) {
                    value = hyperlinkValues[f2Val2];
                } else {
                    value = "";
                }
            } else if (ctype2 === 2) {
                // 数字单元格
                if (col in DIRECT_INT_COLS) {
                    value = f2Val2 !== null ? f2Val2 : 0;
                } else if (col in INDEXED_NUM_COLS && f2Val2 !== null) {
                    var numIdx = f2Val2 - numOffset;
                    value = (numIdx >= 0 && numIdx < numValues.length) ? numValues[numIdx] : 0.0;
                } else {
                    value = f2Val2 !== null ? f2Val2 : 0;
                }
            }

            if (value !== null) {
                table[row + "," + col] = value;
            }
        }

        // 找最大行列
        var maxRow = 0;
        for (var k in table) {
            var parts = k.split(",");
            var r = parseInt(parts[0]);
            if (r > maxRow) maxRow = r;
        }

        // 重建二维表格
        var rows = [];
        for (var r2 = 0; r2 <= maxRow; r2++) {
            var rowData = [];
            for (var c3 = 0; c3 < NUM_COLS; c3++) {
                rowData.push(table[r2 + "," + c3] !== undefined ? table[r2 + "," + c3] : null);
            }
            rows.push(rowData);
        }

        return rows;
    }

    // ===== VR 作品数据解析 =====

    function parseWorkData(rows) {
        var works = [];
        var tunnelMileages = {};

        for (var i = 1; i < rows.length; i++) {
            var row = rows[i];
            if (row.length < NUM_COLS) continue;

            var line = row[0] !== null ? String(row[0]).trim() : "";
            var tunnelNumRaw = row[1];
            var tunnelNameRaw = row[2] !== null ? String(row[2]).trim() : "";
            var mileageRaw = row[3] !== null ? String(row[3]).trim() : "";
            var lngRaw = row[4];
            var latRaw = row[5];
            var elevRaw = row[6];
            var workshop = row[7] !== null ? String(row[7]).trim() : "";
            var yearRaw = row[8];
            var url = row[9] !== null ? String(row[9]).trim() : "";

            if (!line && !tunnelNameRaw && !url) continue;

            // 隧道编号
            var tunnelNum = 0;
            if (tunnelNumRaw !== null) {
                tunnelNum = parseInt(tunnelNumRaw);
                if (isNaN(tunnelNum)) tunnelNum = 0;
            }

            // 位置
            var position = "";
            if (tunnelNameRaw.indexOf("进口") >= 0) position = "进口";
            else if (tunnelNameRaw.indexOf("出口") >= 0) position = "出口";
            else if (tunnelNameRaw.indexOf("涵洞") >= 0) position = "涵洞";
            else if (tunnelNameRaw.indexOf("中心") >= 0) position = "中心点";

            // 清理隧道名
            var cleanName = tunnelNameRaw;
            var suffixes = ["（进口）", "（出口）", "(进口)", "(出口)", "（涵洞）", "(涵洞)", "（中心点）", "(中心点)"];
            for (var s = 0; s < suffixes.length; s++) {
                cleanName = cleanName.split(suffixes[s]).join("");
            }
            cleanName = cleanName.trim();

            // 清理里程
            var mileage = mileageRaw;
            var mSuffixes = ["（进口）", "（出口）", "(进口)", "(出口)"];
            for (var s2 = 0; s2 < mSuffixes.length; s2++) {
                mileage = mileage.split(mSuffixes[s2]).join("");
            }
            mileage = mileage.trim();

            // 经纬度高程
            var lng = 0.0, lat = 0.0, elevation = 0.0;
            if (lngRaw !== null) { lng = Math.round(parseFloat(lngRaw) * 1000000) / 1000000; if (isNaN(lng)) lng = 0.0; }
            if (latRaw !== null) { lat = Math.round(parseFloat(latRaw) * 1000000) / 1000000; if (isNaN(lat)) lat = 0.0; }
            if (elevRaw !== null) { elevation = Math.round(parseFloat(elevRaw) * 10) / 10; if (isNaN(elevation)) elevation = 0.0; }

            // 年份
            var year = "";
            if (yearRaw !== null) {
                if (typeof yearRaw === 'number' && yearRaw > 0) {
                    year = String(parseInt(yearRaw));
                } else {
                    year = String(yearRaw).trim();
                }
            }

            // 隧道里程范围
            var mMatch = mileage.match(/K(\d+)\+(\d+)/i);
            if (mMatch) {
                var mVal = parseInt(mMatch[1]) * 1000 + parseInt(mMatch[2]);
                var tkey = line + ":" + tunnelNum;
                if (!tunnelMileages[tkey]) {
                    tunnelMileages[tkey] = { min: mVal, max: mVal, name: cleanName };
                } else {
                    tunnelMileages[tkey].min = Math.min(tunnelMileages[tkey].min, mVal);
                    tunnelMileages[tkey].max = Math.max(tunnelMileages[tkey].max, mVal);
                }
            }

            works.push({
                id: i,
                line: line,
                tunnelNum: tunnelNum,
                tunnelName: cleanName,
                position: position,
                mileage: mileage,
                lng: lng,
                lat: lat,
                elevation: elevation,
                workshop: workshop,
                year: year,
                url: url
            });
        }

        // 隧道汇总
        var tunnelsSummary = [];
        var sortedKeys = Object.keys(tunnelMileages).sort();
        for (var sk = 0; sk < sortedKeys.length; sk++) {
            var info = tunnelMileages[sortedKeys[sk]];
            var tnum = 0;
            if (sortedKeys[sk].indexOf(":") >= 0) {
                tnum = parseInt(sortedKeys[sk].split(":")[1]) || 0;
            }
            tunnelsSummary.push({
                num: tnum,
                name: info.name,
                length: info.max - info.min
            });
        }

        return { works: works, tunnels: tunnelsSummary };
    }

    // ===== 工点分布附表解析 =====

    function parseWorkTypes(extracted) {
        var textValues = extracted.textValues;
        var numValues = extracted.numValues;
        var cells = extracted.cells;

        // 查找数字偏移量（C列=长度，值应 >= 100）
        var numOffset = null;
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            var ci = cell["3"] || {};
            var ctype = toNum(ci["1"]);
            var col = toNum(cell["2"]);

            if (ctype === 2 && col === 2) {
                var f2 = ci["2"] || {};
                var f2Val = toNum(f2["1"]);
                if (f2Val >= 100) {
                    numOffset = f2Val;
                    break;
                }
            }
        }
        if (numOffset === null) numOffset = 129;

        // 构建 (row, col) -> value
        var table = {};
        for (var i2 = 0; i2 < cells.length; i2++) {
            var c = cells[i2];
            var row = toNum(c["1"]);
            var col = toNum(c["2"]);
            var c2 = c["3"] || {};
            var ctype2 = toNum(c2["1"]);
            var f2b = c2["2"] || {};
            var f2Val2 = f2b["1"] !== undefined ? toNum(f2b["1"]) : null;

            var value = null;
            if (ctype2 === 4) {
                var idx = f2Val2 !== null ? f2Val2 : 0;
                value = idx < textValues.length ? textValues[idx] : "";
            } else if (ctype2 === 2) {
                if (f2Val2 !== null && f2Val2 >= numOffset) {
                    var numIdx = f2Val2 - numOffset;
                    value = (numIdx >= 0 && numIdx < numValues.length) ? numValues[numIdx] : 0.0;
                } else {
                    value = f2Val2 !== null ? parseFloat(f2Val2) : 0.0;
                }
            }

            if (value !== null) {
                table[row + "," + col] = value;
            }
        }

        // 解析数据行
        var workTypesData = {};
        var maxRow = 0;
        for (var k in table) {
            var r = parseInt(k.split(",")[0]);
            if (r > maxRow) maxRow = r;
        }

        for (var r2 = 1; r2 <= maxRow; r2++) {
            var lineShort = table[r2 + ",0"] !== undefined ? String(table[r2 + ",0"]).trim() : "";
            var workType = table[r2 + ",1"] !== undefined ? String(table[r2 + ",1"]).trim() : "";
            var lengthKm = table[r2 + ",2"] !== undefined ? table[r2 + ",2"] : null;

            if (!lineShort || !workType) continue;
            if (["桥梁", "路基", "隧道"].indexOf(workType) < 0) continue;

            var lineFull = LINE_NAME_MAP[lineShort] || lineShort;
            var lengthM = 0.0;
            if (lengthKm !== null) {
                lengthM = parseFloat(lengthKm) * 1000;
                if (isNaN(lengthM)) lengthM = 0.0;
            }

            if (!workTypesData[lineFull]) {
                workTypesData[lineFull] = { "桥梁": 0, "路基": 0, "隧道": 0 };
            }
            workTypesData[lineFull][workType] = lengthM;
        }

        return workTypesData;
    }

    // ===== 主同步函数 =====

    /**
     * 从腾讯文档同步数据
     * @param {function} onProgress - 进度回调 (msg, step)
     * @returns {Promise<object>} { works, tunnels, workTypes, lines }
     */
    async function sync(onProgress) {
        // 1. 获取主表数据
        if (onProgress) onProgress("正在获取主表数据...", 1);
        var apiData = await fetchSheetData();

        // 2. 解码主表
        if (onProgress) onProgress("正在解码 protobuf 数据...", 2);
        var extracted = await decodeApiData(apiData);

        // 3. 重建表格
        if (onProgress) onProgress("正在重建表格结构...", 3);
        var rows = reconstructTable(extracted);

        // 4. 解析 VR 作品数据
        if (onProgress) onProgress("正在解析 VR 作品数据...", 4);
        var parsed = parseWorkData(rows);

        // 5. 获取工点分布附表
        if (onProgress) onProgress("正在获取工点分布数据...", 5);
        var workTypesData = {};
        try {
            var wtApiData = await fetchSheetData(WORK_TYPE_TAB_ID);
            var wtExtracted = await decodeApiData(wtApiData);
            workTypesData = parseWorkTypes(wtExtracted);
        } catch (e) {
            console.log("[sync] 工点分布数据获取失败: " + e.message);
        }

        // 6. 补全所有线路的工点数据
        var fullWorkTypes = {};
        for (var i = 0; i < LINES_CONFIG.length; i++) {
            var lineName = LINES_CONFIG[i].name;
            fullWorkTypes[lineName] = workTypesData[lineName] || { "桥梁": 0, "路基": 0, "隧道": 0 };
        }

        if (onProgress) onProgress("同步完成！", 6);

        return {
            works: parsed.works,
            tunnels: parsed.tunnels,
            workTypes: fullWorkTypes,
            lines: LINES_CONFIG,
            syncTime: new Date()
        };
    }

    return {
        sync: sync
    };
})();
