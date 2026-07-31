/**
 * ============================================================
 *  金华高铁基础设施段管VR全景可视化大屏 - 交互逻辑
 *  适配高铁隧道VR全景数据（杭温铁路、杭昌高铁、衢九线、沪昆线等）
 * ============================================================
 */

(function () {
    "use strict";

    // ===== 全局状态 =====
    const STATE = {
        currentLine: null,          // 当前选中的线路（null=全部）
        currentYear: null,          // 当前选中的年份（null=全部）
        echartsMap: null,
        echartsPie: null,
        allWorks: VR_DATA.works,
        lineColors: {}              // 线路名 -> 颜色
    };

    // 初始化线路颜色映射
    VR_DATA.lines.forEach(function (l) {
        STATE.lineColors[l.name] = l.color;
    });

    // ===== 工具函数 =====
    function formatNumber(num) {
        if (num >= 10000) return (num / 10000).toFixed(1) + "万";
        return num.toLocaleString();
    }

    function parseMileage(mileageStr) {
        var match = mileageStr.match(/K0*(\d+)\+(\d+)/i);
        if (match) return parseInt(match[1]) * 1000 + parseInt(match[2]);
        return 0;
    }

    function getLineColor(lineName) {
        return STATE.lineColors[lineName] || "#00d4ff";
    }

    // 位置颜色映射
    var POSITION_COLORS = {
        "进口": "#00d4ff",
        "出口": "#f59e0b",
        "涵洞": "#10b981",
        "中心点": "#a855f7",
        "其他": "#94a3b8"
    };

    function getPositionColor(position) {
        return POSITION_COLORS[position] || "#94a3b8";
    }

    // 数字滚动动画
    function animateCounter(el, target, duration, suffix) {
        duration = duration || 1500;
        suffix = suffix || "";
        var start = 0;
        var startTime = performance.now();
        function update(now) {
            var elapsed = now - startTime;
            var progress = Math.min(elapsed / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = start + (target - start) * eased;
            if (suffix === "km") {
                el.textContent = current.toFixed(1);
            } else {
                el.textContent = formatNumber(Math.round(current));
            }
            if (progress < 1) requestAnimationFrame(update);
        }
        requestAnimationFrame(update);
    }

    // 获取筛选后的作品（线路 + 年份双重筛选）
    function getFilteredWorks() {
        return STATE.allWorks.filter(function (w) {
            if (STATE.currentLine && w.line !== STATE.currentLine) return false;
            if (STATE.currentYear && w.year !== STATE.currentYear) return false;
            return true;
        });
    }

    // 获取唯一隧道列表（用 线路+隧道名 作为唯一键）
    function getUniqueTunnels(works) {
        var seen = {};
        var tunnels = [];
        works.forEach(function (w) {
            var key = w.line + ":" + w.tunnelName;
            if (!seen[key]) {
                seen[key] = true;
                tunnels.push(w);
            }
        });
        return tunnels;
    }

    // ===== 屏幕自适应缩放 =====
    function adjustScale() {
        var wrapper = document.getElementById("screen-wrapper");
        var scaleX = window.innerWidth / 1920;
        var scaleY = window.innerHeight / 1080;
        var scale = Math.min(scaleX, scaleY);
        wrapper.style.setProperty("--scale", scale);
    }

    // ===== 实时时钟 =====
    function startClock() {
        var timeEl = document.getElementById("header-time");
        var dateEl = document.getElementById("header-date");
        var weekDays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

        function update() {
            var now = new Date();
            var h = String(now.getHours()).padStart(2, "0");
            var m = String(now.getMinutes()).padStart(2, "0");
            var s = String(now.getSeconds()).padStart(2, "0");
            timeEl.textContent = h + ":" + m + ":" + s;

            var y = now.getFullYear();
            var mo = String(now.getMonth() + 1).padStart(2, "0");
            var d = String(now.getDate()).padStart(2, "0");
            dateEl.textContent = y + "-" + mo + "-" + d + " " + weekDays[now.getDay()];
        }
        update();
        setInterval(update, 1000);
    }

    // ===== 统计面板 =====
    function renderStats() {
        var works = STATE.allWorks;
        var totalPoints = works.length;
        var tunnelCount = getUniqueTunnels(works).length;

        // 覆盖里程
        var allMileages = works.map(function (w) { return parseMileage(w.mileage); }).filter(function (m) { return m > 0; });
        var totalKm = 0;
        if (allMileages.length > 0) {
            totalKm = (Math.max.apply(null, allMileages) - Math.min.apply(null, allMileages)) / 1000;
        }

        // 线路数量
        var lineSet = {};
        works.forEach(function (w) { lineSet[w.line] = true; });
        var lineCount = Object.keys(lineSet).length;

        animateCounter(document.getElementById("stat-total"), totalPoints);
        animateCounter(document.getElementById("stat-tunnels"), tunnelCount);
        animateCounter(document.getElementById("stat-mileage"), totalKm, 1500, "km");
        animateCounter(document.getElementById("stat-lines"), lineCount);

        // 地图浮层统计
        var mapTotalEl = document.getElementById("map-stat-total");
        var mapTunnelEl = document.getElementById("map-stat-tunnels");
        if (mapTotalEl) mapTotalEl.innerHTML = totalPoints + '<span class="unit">个</span>';
        if (mapTunnelEl) mapTunnelEl.innerHTML = tunnelCount + '<span class="unit">座</span>';
    }

    // ===== 各线路VR作品数量统计 =====
    function renderLineStats() {
        var container = document.getElementById("line-stats");
        if (!container) return;

        var works = STATE.allWorks;

        // 按线路统计作品数
        var lineCounts = {};
        works.forEach(function (w) {
            lineCounts[w.line] = (lineCounts[w.line] || 0) + 1;
        });

        // 按配置中的线路顺序排列，过滤出有数据的线路
        var lines = VR_DATA.lines.filter(function (l) {
            return lineCounts[l.name] > 0;
        }).map(function (l) {
            return { name: l.name, color: l.color, count: lineCounts[l.name] };
        });

        // 按数量降序排列
        lines.sort(function (a, b) { return b.count - a.count; });

        var maxCount = Math.max.apply(null, lines.map(function (l) { return l.count; }));

        var html = '<div class="line-stat-header">各线路VR作品数量</div>';
        lines.forEach(function (l) {
            var percent = maxCount > 0 ? (l.count / maxCount * 100) : 0;
            html += '<div class="line-stat-row" data-line="' + l.name + '">' +
                '<span class="line-stat-dot" style="background:' + l.color + ';box-shadow:0 0 6px ' + l.color + ';"></span>' +
                '<span class="line-stat-name">' + l.name + '</span>' +
                '<div class="line-stat-bar-wrap">' +
                    '<div class="line-stat-bar" style="width:0%;background:linear-gradient(90deg,' + l.color + 'aa,' + l.color + ');box-shadow:0 0 8px ' + l.color + '40;" data-target="' + percent + '"></div>' +
                '</div>' +
                '<span class="line-stat-count" style="color:' + l.color + ';">' + l.count + '</span>' +
            '</div>';
        });

        container.innerHTML = html;

        // 动画填充进度条
        setTimeout(function () {
            var bars = container.querySelectorAll(".line-stat-bar");
            bars.forEach(function (bar) {
                bar.style.width = bar.getAttribute("data-target") + "%";
            });
        }, 100);

        // 点击行 → 筛选该线路
        var rows = container.querySelectorAll(".line-stat-row");
        rows.forEach(function (row) {
            row.addEventListener("click", function () {
                var lineName = this.getAttribute("data-line");
                // 切换线路筛选
                STATE.currentLine = (STATE.currentLine === lineName) ? null : lineName;
                // 更新线路选择器UI
                var selector = document.querySelector(".line-selector");
                if (selector) {
                    var items = selector.querySelectorAll(".city-item");
                    items.forEach(function (item) {
                        var isActive = item.getAttribute("data-line") === lineName && STATE.currentLine !== null;
                        if (isActive) {
                            item.classList.add("active");
                        } else {
                            item.classList.remove("active");
                        }
                    });
                }
                refreshAll();
            });
        });
    }

    // ===== 浙江省地图 =====
    async function initMap() {
        var chartDom = document.getElementById("map-chart");
        if (typeof echarts === "undefined") {
            chartDom.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#f59e0b;font-size:14px;">ECharts库加载失败，请检查网络连接</div>';
            return;
        }
        STATE.echartsMap = echarts.init(chartDom);

        // 优先加载本地GeoJSON（避免CORS问题），失败时回退到DataV API
        var geoSources = [
            "js/geo/zhejiang.json",
            "https://geo.datav.aliyun.com/areas_v3/bound/330000_full.json"
        ];
        var geoJson = null;
        var lastError = null;

        for (var i = 0; i < geoSources.length; i++) {
            try {
                var resp = await fetch(geoSources[i]);
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                geoJson = await resp.json();
                break;
            } catch (e) {
                lastError = e;
                console.warn("地图数据源加载失败: " + geoSources[i], e.message);
            }
        }

        if (!geoJson) {
            console.error("所有地图数据源均加载失败", lastError);
            chartDom.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#f59e0b;font-size:14px;text-align:center;">地图数据加载失败<br><span style="font-size:12px;color:#64748b;">请检查网络连接或刷新页面重试</span></div>';
            return;
        }

        echarts.registerMap("zhejiang", geoJson);
        renderMap();

        // 确保地图尺寸正确（处理容器初始化时尺寸为0的情况）
        setTimeout(function () {
            if (STATE.echartsMap) STATE.echartsMap.resize();
        }, 100);
    }

    function renderMap() {
        var works = getFilteredWorks();

        // 过滤掉无坐标的点（lng=0 或 lat=0）
        var geoWorks = works.filter(function (w) {
            return w.lng !== 0 && w.lat !== 0;
        });

        // 按线路和隧道号排序，用于绘制铁路线
        var sortedWorks = geoWorks.slice().sort(function (a, b) {
            if (a.line !== b.line) return a.line.localeCompare(b.line);
            if (a.tunnelNum !== b.tunnelNum) return a.tunnelNum - b.tunnelNum;
            return a.position === "进口" ? -1 : 1;
        });

        // 散点数据
        var scatterData = sortedWorks.map(function (w) {
            return {
                name: w.tunnelName + "（" + w.position + "）",
                value: [w.lng, w.lat, w.elevation, w]
            };
        });

        // 按线路分组路线
        var lineGroups = {};
        sortedWorks.forEach(function (w) {
            if (!lineGroups[w.line]) lineGroups[w.line] = [];
            lineGroups[w.line].push([w.lng, w.lat]);
        });

        var linesData = Object.keys(lineGroups).map(function (lineName) {
            return {
                name: lineName,
                coords: lineGroups[lineName]
            };
        });

        var option = {
            backgroundColor: "transparent",
            tooltip: {
                trigger: "item",
                backgroundColor: "rgba(6, 12, 31, 0.92)",
                borderColor: "rgba(0, 212, 255, 0.5)",
                borderWidth: 1,
                textStyle: { color: "#e2e8f0", fontSize: 13 },
                formatter: function (p) {
                    if (p.seriesType === "effectScatter") {
                        var w = p.data.value[3];
                        var posColor = getPositionColor(w.position);
                        return '<div style="font-weight:700;color:' + posColor + ';font-size:14px;margin-bottom:4px;">' +
                            w.tunnelName + '（' + w.position + '）</div>' +
                            '<div style="font-size:12px;line-height:1.8;">' +
                            '<span style="color:#64748b;">线路：</span><span style="color:#e2e8f0;">' + w.line + '</span><br>' +
                            (w.tunnelNum > 0 ? '<span style="color:#64748b;">隧道编号：</span><span style="color:#e2e8f0;">' + w.tunnelNum + '号</span><br>' : '') +
                            (w.mileage ? '<span style="color:#64748b;">里程桩号：</span><span style="color:#f59e0b;font-family:Consolas;">' + w.mileage + '</span><br>' : '') +
                            '<span style="color:#64748b;">高程：</span><span style="color:#e2e8f0;">' + w.elevation + ' m</span><br>' +
                            '<span style="color:#64748b;">维修车间：</span><span style="color:#e2e8f0;">' + w.workshop + '</span><br>' +
                            '<span style="color:#64748b;">拍摄年份：</span><span style="color:#10b981;font-weight:600;">' + w.year + '</span>' +
                            '</div>' +
                            '<div style="font-size:11px;color:#00d4ff;margin-top:6px;border-top:1px solid rgba(0,212,255,0.2);padding-top:4px;">点击查看VR全景</div>';
                    }
                    return p.name;
                }
            },
            geo: {
                map: "zhejiang",
                roam: false,
                zoom: 1.15,
                center: [120.3, 29.0],
                label: {
                    show: true,
                    color: "rgba(148, 163, 184, 0.5)",
                    fontSize: 10
                },
                itemStyle: {
                    areaColor: "#0a1738",
                    borderColor: "rgba(0, 212, 255, 0.2)",
                    borderWidth: 1
                },
                emphasis: {
                    label: { color: "#00d4ff" },
                    itemStyle: {
                        areaColor: "rgba(0, 212, 255, 0.08)",
                        borderColor: "rgba(0, 212, 255, 0.4)"
                    }
                }
            },
            series: [
                // 铁路路线（连线）- 按线路着色
                {
                    name: "铁路路线",
                    type: "lines",
                    coordinateSystem: "geo",
                    zlevel: 1,
                    polyline: true,
                    lineStyle: {
                        color: function (p) {
                            return getLineColor(p.data.name);
                        },
                        width: 2,
                        opacity: 0.3,
                        curveness: 0
                    },
                    effect: {
                        show: true,
                        period: 8,
                        trailLength: 0.5,
                        symbol: "circle",
                        symbolSize: 3,
                        color: "rgba(0, 212, 255, 0.6)"
                    },
                    data: linesData
                },
                // VR全景散点
                {
                    name: "VR全景",
                    type: "effectScatter",
                    coordinateSystem: "geo",
                    zlevel: 2,
                    rippleEffect: { brushType: "stroke", scale: 3, period: 4 },
                    symbolSize: 7,
                    itemStyle: {
                        color: function (p) {
                            var w = p.data.value[3];
                            return getPositionColor(w.position);
                        },
                        shadowBlur: 8,
                        shadowColor: "rgba(0, 212, 255, 0.4)"
                    },
                    data: scatterData
                }
            ]
        };

        STATE.echartsMap.setOption(option, true);

        // 点击事件
        STATE.echartsMap.off("click");
        STATE.echartsMap.on("click", function (params) {
            if (params.seriesType === "effectScatter") {
                var work = params.data.value[3];
                openVRModal(work);
            }
        });
    }

    // ===== 工点类型长度分布饼图 =====
    function initPieChart() {
        var dom = document.getElementById("chart-pie");
        if (STATE.echartsPie) {
            STATE.echartsPie.dispose();
        }
        STATE.echartsPie = echarts.init(dom);

        // 获取工点类型数据（按线路筛选）
        var typeData = getWorkTypeData();

        var typeColors = {
            "桥梁": "#00d4ff",
            "路基": "#10b981",
            "隧道": "#f59e0b"
        };

        var pieData = Object.keys(typeData).map(function (typeName) {
            return {
                name: typeName,
                value: typeData[typeName],
                itemStyle: { color: typeColors[typeName] || "#94a3b8" }
            };
        }).filter(function (d) { return d.value > 0; });

        var totalLength = pieData.reduce(function (sum, d) { return sum + d.value; }, 0);

        // 如果没有数据，显示空状态
        if (pieData.length === 0) {
            var option = {
                backgroundColor: "transparent",
                title: {
                    text: "暂无工点类型数据",
                    left: "center",
                    top: "center",
                    textStyle: {
                        color: "#64748b",
                        fontSize: 14,
                        fontWeight: "normal"
                    },
                    subtext: "请在在线表格中填写工点类型与长度",
                    subtextStyle: {
                        color: "#475569",
                        fontSize: 11
                    }
                }
            };
            STATE.echartsPie.setOption(option, true);
            return;
        }

        var option = {
            backgroundColor: "transparent",
            tooltip: {
                trigger: "item",
                backgroundColor: "rgba(6, 12, 31, 0.92)",
                borderColor: "rgba(0, 212, 255, 0.5)",
                textStyle: { color: "#e2e8f0", fontSize: 12 },
                formatter: function (p) {
                    var km = (p.value / 1000).toFixed(2);
                    var pct = totalLength > 0 ? ((p.value / totalLength) * 100).toFixed(1) : 0;
                    return p.name + '：<span style="color:#00d4ff;font-weight:600;">' +
                        p.value.toLocaleString() + ' m</span>（' + km + ' km）<br>' +
                        '占比：<span style="color:#f59e0b;">' + pct + '%</span>';
                }
            },
            legend: {
                orient: "horizontal",
                bottom: 8,
                itemWidth: 10,
                itemHeight: 10,
                textStyle: { color: "#94a3b8", fontSize: 11 },
                itemGap: 16,
                data: pieData.map(function (d) { return d.name; })
            },
            series: [{
                type: "pie",
                radius: ["38%", "62%"],
                center: ["50%", "42%"],
                avoidLabelOverlap: false,
                itemStyle: {
                    borderColor: "#060c1f",
                    borderWidth: 2
                },
                label: {
                    show: true,
                    position: "center",
                    formatter: function () {
                        var km = (totalLength / 1000).toFixed(1);
                        return "{total|" + km + "}\n{label|总长度(km)}";
                    },
                    rich: {
                        total: { fontSize: 26, fontWeight: 700, color: "#00d4ff", fontFamily: "Consolas", lineHeight: 32 },
                        label: { fontSize: 11, color: "#64748b" }
                    }
                },
                emphasis: {
                    label: { show: true, position: "center" },
                    itemStyle: { shadowBlur: 12, shadowColor: "rgba(0, 212, 255, 0.3)" }
                },
                data: pieData
            }]
        };

        STATE.echartsPie.setOption(option, true);
    }

    // ===== 获取工点类型数据（按线路筛选） =====
    function getWorkTypeData() {
        var workTypes = VR_DATA.workTypes || {};
        var result = { "桥梁": 0, "路基": 0, "隧道": 0 };

        if (STATE.currentLine) {
            // 选中了特定线路
            var lineData = workTypes[STATE.currentLine];
            if (lineData) {
                result["桥梁"] = lineData["桥梁"] || 0;
                result["路基"] = lineData["路基"] || 0;
                result["隧道"] = lineData["隧道"] || 0;
            }
        } else {
            // 全部线路
            Object.keys(workTypes).forEach(function (lineName) {
                var lineData = workTypes[lineName];
                if (lineData) {
                    result["桥梁"] += lineData["桥梁"] || 0;
                    result["路基"] += lineData["路基"] || 0;
                    result["隧道"] += lineData["隧道"] || 0;
                }
            });
        }

        return result;
    }

    // ===== 隧道VR列表 =====
    function renderTunnelList() {
        var container = document.getElementById("work-list");
        var works = getFilteredWorks().slice().sort(function (a, b) {
            if (a.line !== b.line) return a.line.localeCompare(b.line);
            if (a.tunnelNum !== b.tunnelNum) return a.tunnelNum - b.tunnelNum;
            return a.position === "进口" ? -1 : 1;
        });

        if (works.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:20px;color:#64748b;font-size:13px;">暂无数据</div>';
            return;
        }

        container.innerHTML = works.map(function (w) {
            var posColor = getPositionColor(w.position);
            var lineColor = getLineColor(w.line);
            var numLabel = w.tunnelNum > 0 ? (w.tunnelNum + "#") : "?";
            return '<div class="work-item" data-id="' + w.id + '">' +
                '<div class="work-rank" style="color:' + posColor + ';border:1px solid ' + posColor + '40;background:' + posColor + '15;font-size:11px;">' +
                    numLabel + '</div>' +
                '<div class="work-info">' +
                    '<div class="work-name">' + w.tunnelName + '（' + w.position + '）</div>' +
                    '<div class="work-sub">' +
                        '<span class="city-tag-text" style="color:' + lineColor + ';">' + w.line + '</span>' +
                        (w.mileage ? '<span>' + w.mileage + '</span>' : '') +
                        '<span>&#9878; ' + w.elevation + 'm</span>' +
                        '<span style="color:#10b981;">' + w.year + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="work-views">' +
                    '<div class="num" style="color:' + posColor + ';font-size:12px;">' + w.position + '</div>' +
                    '<div class="label">' + w.year + '</div>' +
                '</div>' +
            '</div>';
        }).join("");

        container.querySelectorAll(".work-item").forEach(function (el) {
            el.addEventListener("click", function () {
                var id = parseInt(this.dataset.id);
                var work = STATE.allWorks.find(function (w) { return w.id === id; });
                if (work) openVRModal(work);
            });
        });
    }

    // ===== VR预览卡片 =====
    function renderPreviewCards() {
        var container = document.getElementById("preview-scroll");
        var works = getFilteredWorks().slice().sort(function (a, b) {
            if (a.line !== b.line) return a.line.localeCompare(b.line);
            return a.tunnelNum - b.tunnelNum;
        });

        // 每个隧道取一个（进口优先）
        var uniqueTunnels = {};
        var cardWorks = [];
        works.forEach(function (w) {
            var key = w.line + ":" + w.tunnelName;
            if (!uniqueTunnels[key]) {
                uniqueTunnels[key] = true;
                cardWorks.push(w);
            }
        });

        if (cardWorks.length === 0) {
            container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;color:#64748b;font-size:13px;">暂无数据</div>';
            return;
        }

        container.innerHTML = cardWorks.map(function (w) {
            var lineColor = getLineColor(w.line);
            var gradient = "linear-gradient(135deg, " + lineColor + "20, " + lineColor + "05)";
            var numLabel = w.tunnelNum > 0 ? (w.tunnelNum + "号隧道") : (w.tunnelName + "");
            return '<div class="vr-card" data-id="' + w.id + '">' +
                '<div class="vr-card-thumb" style="background:' + gradient + '">' +
                    '<span class="thumb-icon">&#128679;</span>' +
                    '<div class="thumb-title">' + w.tunnelName + '</div>' +
                '</div>' +
                '<div class="vr-card-info">' +
                    '<span class="vr-card-cat" style="color:' + lineColor + ';border-color:' + lineColor + '40;">' + numLabel + '</span>' +
                    '<div class="vr-card-meta">' +
                        '<span class="city-name">' + w.line + '</span>' +
                        '<span class="view-count">&#9878; ' + w.elevation + 'm</span>' +
                        '<span style="color:#10b981;">' + w.year + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>';
        }).join("");

        container.querySelectorAll(".vr-card").forEach(function (el) {
            el.addEventListener("click", function () {
                var id = parseInt(this.dataset.id);
                var work = STATE.allWorks.find(function (w) { return w.id === id; });
                if (work) openVRModal(work);
            });
        });
    }

    // ===== 线路选择器 + 年份选择器 =====
    function renderLineSelector() {
        var container = document.querySelector(".line-selector");
        var lineCounts = {};
        STATE.allWorks.forEach(function (w) {
            lineCounts[w.line] = (lineCounts[w.line] || 0) + 1;
        });

        var html = '<span class="city-tag' + (!STATE.currentLine ? " active" : "") + '" data-line="">全部 <span style="color:#f59e0b;">' + STATE.allWorks.length + '</span></span>';
        VR_DATA.lines.forEach(function (l) {
            var count = lineCounts[l.name] || 0;
            if (count > 0) {
                html += '<span class="city-tag' + (STATE.currentLine === l.name ? " active" : "") + '" data-line="' + l.name + '" style="' +
                    (STATE.currentLine === l.name ? "border-color:" + l.color + ";box-shadow:0 0 8px " + l.color + "40;" : "") + '">' +
                    l.name + ' <span style="color:#f59e0b;">' + count + '</span>' +
                '</span>';
            }
        });
        container.innerHTML = html;

        container.querySelectorAll(".city-tag").forEach(function (tag) {
            tag.addEventListener("click", function () {
                selectLine(this.dataset.line || null);
            });
        });
    }

    function renderYearSelector() {
        var container = document.querySelector(".year-selector");
        if (!container) return;

        var yearCounts = {};
        STATE.allWorks.forEach(function (w) {
            if (w.year) {
                yearCounts[w.year] = (yearCounts[w.year] || 0) + 1;
            }
        });

        var years = Object.keys(yearCounts).sort().reverse();

        var html = '<span class="city-tag' + (!STATE.currentYear ? " active" : "") + '" data-year="">全部年份</span>';
        years.forEach(function (y) {
            html += '<span class="city-tag' + (STATE.currentYear === y ? " active" : "") + '" data-year="' + y + '">' +
                y + '年 <span style="color:#f59e0b;">' + yearCounts[y] + '</span>' +
            '</span>';
        });
        container.innerHTML = html;

        container.querySelectorAll(".city-tag").forEach(function (tag) {
            tag.addEventListener("click", function () {
                selectYear(this.dataset.year || null);
            });
        });
    }

    function selectLine(lineName) {
        if (STATE.currentLine === lineName) {
            STATE.currentLine = null;
        } else {
            STATE.currentLine = lineName;
        }
        refreshAll();
    }

    function selectYear(year) {
        if (STATE.currentYear === year) {
            STATE.currentYear = null;
        } else {
            STATE.currentYear = year;
        }
        refreshAll();
    }

    function refreshAll() {
        renderLineSelector();
        renderYearSelector();
        renderMap();
        initPieChart();
        renderTunnelList();
        renderPreviewCards();
        showFilterHint();
    }

    function showFilterHint() {
        var hint = document.getElementById("filter-hint");
        var parts = [];
        if (STATE.currentLine) parts.push(STATE.currentLine);
        if (STATE.currentYear) parts.push(STATE.currentYear + "年");
        if (parts.length > 0) {
            hint.textContent = "当前筛选：" + parts.join(" + ") + "（点击「全部」取消）";
            hint.classList.add("show");
            setTimeout(function () { hint.classList.remove("show"); }, 2500);
        } else {
            hint.textContent = "已显示全部数据";
            hint.classList.add("show");
            setTimeout(function () { hint.classList.remove("show"); }, 1500);
        }
    }

    // ===== VR预览弹窗（720云嵌入） =====
    function openVRModal(work) {
        var overlay = document.getElementById("modal-overlay");
        var titleEl = document.getElementById("modal-title-text");
        var lineBadge = document.getElementById("modal-city-badge");
        var body = document.getElementById("modal-body");
        var footer = document.getElementById("modal-footer");
        var openLink = document.getElementById("modal-open-link");

        titleEl.textContent = work.tunnelName + (work.position ? "（" + work.position + "）" : "") + " VR全景";
        lineBadge.textContent = work.line + " · " + work.year;

        // 底部信息
        footer.querySelector('[data-meta="tunnelNum"]').textContent = work.tunnelNum > 0 ? (work.tunnelNum + "号") : "无编号";
        footer.querySelector('[data-meta="position"]').textContent = work.position || "—";
        footer.querySelector('[data-meta="mileage"]').textContent = work.mileage || "无";
        footer.querySelector('[data-meta="elevation"]').textContent = work.elevation + " m";
        footer.querySelector('[data-meta="coords"]').textContent = (work.lng && work.lat) ? (work.lng.toFixed(6) + ", " + work.lat.toFixed(6)) : "无坐标";
        var yearMeta = footer.querySelector('[data-meta="year"]');
        if (yearMeta) yearMeta.textContent = work.year;

        // 检查URL是否为空
        if (!work.url || work.url.trim() === "") {
            openLink.href = "#";
            openLink.style.display = "none";
            body.innerHTML =
                '<div class="modal-placeholder" style="display:flex;">' +
                    '<div class="icon">&#128679;</div>' +
                    '<div class="text" style="font-size:16px;color:#ef4444;">该工点暂无VR全景链接</div>' +
                    '<div class="url-hint" style="color:#64748b;margin-top:8px;">请在腾讯文档中为该条目补充720云链接</div>' +
                '</div>';
            overlay.classList.add("active");
            return;
        }

        openLink.href = work.url;
        openLink.target = "_blank";
        openLink.style.display = "";

        // 构建720云iframe（移除sandbox限制，720云是可信站点需要完整JS执行环境）
        body.innerHTML =
            '<iframe class="modal-iframe" src="' + work.url + '" ' +
            'frameborder="0" ' +
            'allowfullscreen="allowfullscreen" ' +
            'allow="fullscreen; gyroscope; accelerometer; magnetometer; autoplay; clipboard-read; clipboard-write" ' +
            'referrerpolicy="no-referrer-when-downgrade"></iframe>' +
            '<div class="modal-placeholder" style="display:none;">' +
                '<div class="icon">&#127748;</div>' +
                '<div class="text">VR全景加载中，若长时间未显示请点击下方按钮在新窗口打开</div>' +
                '<div class="url-hint">' + work.url + '</div>' +
            '</div>';

        var iframe = body.querySelector(".modal-iframe");
        var placeholder = body.querySelector(".modal-placeholder");
        var loaded = false;

        iframe.addEventListener("load", function () {
            loaded = true;
        });

        // 12秒后检测是否加载成功
        setTimeout(function () {
            if (!loaded) {
                iframe.style.display = "none";
                placeholder.style.display = "flex";
            }
        }, 12000);

        overlay.classList.add("active");
    }

    function closeModal() {
        var overlay = document.getElementById("modal-overlay");
        var body = document.getElementById("modal-body");
        overlay.classList.remove("active");
        setTimeout(function () { body.innerHTML = ""; }, 300);
    }

    // ===== 事件绑定 =====
    function bindEvents() {
        document.getElementById("modal-close-btn").addEventListener("click", closeModal);
        document.getElementById("modal-overlay").addEventListener("click", function (e) {
            if (e.target === this) closeModal();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                closeModal();
                closeSearchDropdown();
            }
        });

        window.addEventListener("resize", function () {
            adjustScale();
            if (STATE.echartsMap) STATE.echartsMap.resize();
            if (STATE.echartsPie) STATE.echartsPie.resize();
        });
    }

    // ===== 搜索功能 =====
    var searchState = {
        query: "",
        results: [],
        highlightIndex: -1
    };

    function initSearch() {
        var input = document.getElementById("search-input");
        var clearBtn = document.getElementById("search-clear");
        var dropdown = document.getElementById("search-dropdown");

        // 输入事件（防抖）
        var debounceTimer = null;
        input.addEventListener("input", function () {
            var val = this.value.trim();
            searchState.query = val;

            if (val) {
                clearBtn.classList.add("show");
            } else {
                clearBtn.classList.remove("show");
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function () {
                performSearch(val);
            }, 200);
        });

        // 清除按钮
        clearBtn.addEventListener("click", function () {
            input.value = "";
            searchState.query = "";
            clearBtn.classList.remove("show");
            closeSearchDropdown();
            input.focus();
        });

        // 聚焦时如果有内容则显示结果
        input.addEventListener("focus", function () {
            if (searchState.query && searchState.results.length > 0) {
                dropdown.classList.add("show");
            }
        });

        // 键盘导航
        input.addEventListener("keydown", function (e) {
            if (!dropdown.classList.contains("show")) return;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                searchState.highlightIndex = Math.min(searchState.highlightIndex + 1, searchState.results.length - 1);
                renderSearchDropdown();
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                searchState.highlightIndex = Math.max(searchState.highlightIndex - 1, 0);
                renderSearchDropdown();
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (searchState.highlightIndex >= 0 && searchState.results[searchState.highlightIndex]) {
                    selectSearchResult(searchState.results[searchState.highlightIndex]);
                } else if (searchState.results.length > 0) {
                    selectSearchResult(searchState.results[0]);
                }
            }
        });

        // 点击外部关闭下拉
        document.addEventListener("click", function (e) {
            var searchBox = document.getElementById("search-box");
            if (!searchBox.contains(e.target)) {
                closeSearchDropdown();
            }
        });
    }

    function performSearch(query) {
        var dropdown = document.getElementById("search-dropdown");

        if (!query) {
            searchState.results = [];
            closeSearchDropdown();
            return;
        }

        var q = query.toLowerCase();

        // 从全部作品中搜索（不受线路/年份筛选限制）
        searchState.results = STATE.allWorks.filter(function (w) {
            if (w.tunnelName.toLowerCase().indexOf(q) !== -1) return true;
            if (String(w.tunnelNum).indexOf(q) !== -1) return true;
            if (w.position.indexOf(q) !== -1) return true;
            if (w.mileage.toLowerCase().indexOf(q) !== -1) return true;
            if (w.line.toLowerCase().indexOf(q) !== -1) return true;
            if (w.workshop.toLowerCase().indexOf(q) !== -1) return true;
            if (w.year.indexOf(q) !== -1) return true;
            return false;
        });

        // 按线路和隧道号排序
        searchState.results.sort(function (a, b) {
            if (a.line !== b.line) return a.line.localeCompare(b.line);
            if (a.tunnelNum !== b.tunnelNum) return a.tunnelNum - b.tunnelNum;
            return a.position === "进口" ? -1 : 1;
        });

        searchState.highlightIndex = -1;

        if (searchState.results.length > 0) {
            dropdown.classList.add("show");
            renderSearchDropdown();
        } else {
            dropdown.classList.add("show");
            dropdown.innerHTML = '<div class="search-empty">未找到匹配的隧道，请尝试其他关键词</div>';
        }
    }

    function renderSearchDropdown() {
        var dropdown = document.getElementById("search-dropdown");
        var results = searchState.results;
        var query = searchState.query;

        if (results.length === 0) {
            dropdown.innerHTML = '<div class="search-empty">未找到匹配的隧道，请尝试其他关键词</div>';
            return;
        }

        var html = '<div class="search-count-bar">找到 <span style="color:#00d4ff;font-weight:600;">' +
            results.length + '</span> 个匹配结果' +
            (results.length > 12 ? '（显示前12个）' : '') + '</div>';

        var displayCount = Math.min(results.length, 12);

        for (var i = 0; i < displayCount; i++) {
            var w = results[i];
            var posColor = getPositionColor(w.position);
            var lineColor = getLineColor(w.line);
            var highlighted = i === searchState.highlightIndex ? " highlighted" : "";
            var numLabel = w.tunnelNum > 0 ? w.tunnelNum : "?";

            html += '<div class="search-result-item' + highlighted + '" data-id="' + w.id + '">' +
                '<div class="search-result-num" style="color:' + posColor + ';border:1px solid ' + posColor + '50;background:' + posColor + '12;">' +
                    numLabel +
                '</div>' +
                '<div class="search-result-info">' +
                    '<div class="search-result-name">' +
                        highlightMatch(w.tunnelName, query) +
                    '</div>' +
                    '<div class="search-result-sub">' +
                        '<span style="color:' + lineColor + ';">' + w.line + '</span>' +
                        (w.mileage ? '<span>' + highlightMatch(w.mileage, query) + '</span>' : '') +
                        '<span>&#9878; ' + w.elevation + 'm</span>' +
                        '<span style="color:#10b981;">' + highlightMatch(w.year, query) + '年</span>' +
                    '</div>' +
                '</div>' +
                '<div class="search-result-pos" style="color:' + posColor + ';background:' + posColor + '15;border:1px solid ' + posColor + '40;">' +
                    w.position +
                '</div>' +
            '</div>';
        }

        dropdown.innerHTML = html;

        // 绑定点击事件
        dropdown.querySelectorAll(".search-result-item").forEach(function (el) {
            el.addEventListener("click", function () {
                var id = parseInt(this.dataset.id);
                var work = STATE.allWorks.find(function (w) { return w.id === id; });
                if (work) selectSearchResult(work);
            });
        });
    }

    function highlightMatch(text, query) {
        if (!query) return text;
        var escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var regex = new RegExp("(" + escaped + ")", "gi");
        return text.replace(regex, '<span style="color:#00d4ff;font-weight:600;background:rgba(0,212,255,0.15);">$1</span>');
    }

    function selectSearchResult(work) {
        closeSearchDropdown();
        document.getElementById("search-input").value = "";
        document.getElementById("search-clear").classList.remove("show");
        searchState.query = "";
        searchState.results = [];

        // 在地图上定位该点
        highlightMapPoint(work);

        // 打开VR弹窗
        openVRModal(work);
    }

    function highlightMapPoint(work) {
        if (!STATE.echartsMap || work.lng === 0 || work.lat === 0) return;

        // 找到该点在当前地图数据中的索引
        var works = getFilteredWorks().filter(function (w) {
            return w.lng !== 0 && w.lat !== 0;
        }).sort(function (a, b) {
            if (a.line !== b.line) return a.line.localeCompare(b.line);
            if (a.tunnelNum !== b.tunnelNum) return a.tunnelNum - b.tunnelNum;
            return a.position === "进口" ? -1 : 1;
        });

        var dataIndex = works.indexOf(work);
        if (dataIndex < 0) return;

        // 临时高亮目标点：通过dispatchAction触发tooltip
        STATE.echartsMap.dispatchAction({
            type: "showTip",
            seriesIndex: 1,
            dataIndex: dataIndex
        });

        // 闪烁高亮
        var count = 0;
        var flashTimer = setInterval(function () {
            count++;
            if (count > 6 || !STATE.echartsMap) {
                clearInterval(flashTimer);
                return;
            }
            if (count % 2 === 0) {
                STATE.echartsMap.dispatchAction({
                    type: "highlight",
                    seriesIndex: 1,
                    dataIndex: dataIndex
                });
            } else {
                STATE.echartsMap.dispatchAction({
                    type: "downplay",
                    seriesIndex: 1,
                    dataIndex: dataIndex
                });
            }
        }, 400);
    }

    function closeSearchDropdown() {
        var dropdown = document.getElementById("search-dropdown");
        if (dropdown) dropdown.classList.remove("show");
        searchState.highlightIndex = -1;
    }

    // ===== 初始化 =====
    async function init() {
        var loading = document.getElementById("loading-overlay");

        try {
            adjustScale();
            startClock();
            renderStats();
            renderLineStats();
            renderLineSelector();
            renderYearSelector();
            await initMap();
            initPieChart();
            renderTunnelList();
            renderPreviewCards();
            initSearch();
            bindEvents();

            setTimeout(function () {
                loading.classList.add("hidden");
            }, 600);

        } catch (e) {
            console.error("初始化失败", e);
            loading.classList.add("hidden");
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();
