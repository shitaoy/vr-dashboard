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
        leafletMap: null,
        markerLayer: null,
        lineLayer: null,
        labelLayer: null,
        markerIndex: {},
        echartsPie: null,
        allWorks: VR_DATA.works,
        lineColors: {},             // 线路名 -> 颜色
        mapZoom: 8,                 // 当前地图缩放级别（Leaflet 层级）
        currentDeviceWork: null     // 设备抽屉当前展示的隧道口
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

    // ===== 地图（天地图卫星影像 · Leaflet） =====
    // ★ 天地图 Key：请到 https://console.tianditu.gov.cn 申请「浏览器端」Key 后替换下方占位符
    var TIANDITU_KEY = "f14fd967b65effa0ffd2ffee4128ad82";
    var TD_SUBDOMAINS = ["0", "1", "2", "3", "4", "5", "6", "7"];
    var MAP_CENTER = [29.05, 120.35];   // [纬度, 经度]
    var MAP_INIT_ZOOM = 8;
    var MAP_MIN_ZOOM = 4;
    var MAP_MAX_ZOOM = 18;              // 天地图影像最大 18 级
    var LABEL_MIN_ZOOM = 10;            // 达到该级别后显示隧道口名称标注

    function hasTiandituKey() {
        return /^[0-9a-zA-Z]{32}$/.test(TIANDITU_KEY);
    }

    // 天地图 WMTS 瓦片地址（img=卫星影像，cia=影像注记，坐标系 EPSG:3857）
    function tiandituUrl(layer) {
        return "https://t{s}.tianditu.gov.cn/" + layer + "_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0" +
            "&LAYER=" + layer + "&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles" +
            "&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=" + TIANDITU_KEY;
    }

    function initMap() {
        var mapDom = document.getElementById("map-chart");
        if (typeof L === "undefined") {
            mapDom.innerHTML = '<div class="map-fallback-tip">地图组件加载失败，请检查网络连接后刷新</div>';
            return;
        }

        var map = L.map(mapDom, {
            center: MAP_CENTER,
            zoom: MAP_INIT_ZOOM,
            minZoom: MAP_MIN_ZOOM,
            maxZoom: MAP_MAX_ZOOM,
            zoomControl: false,
            attributionControl: false,
            zoomSnap: 0.5,
            wheelPxPerZoomLevel: 90,
            worldCopyJump: false
        });
        STATE.leafletMap = map;

        if (hasTiandituKey()) {
            // 卫星影像
            var imgLayer = L.tileLayer(tiandituUrl("img"), {
                subdomains: TD_SUBDOMAINS,
                maxZoom: MAP_MAX_ZOOM,
                maxNativeZoom: 18,
                crossOrigin: true
            }).addTo(map);
            // 影像注记（地名 / 道路）
            L.tileLayer(tiandituUrl("cia"), {
                subdomains: TD_SUBDOMAINS,
                maxZoom: MAP_MAX_ZOOM,
                maxNativeZoom: 18,
                crossOrigin: true
            }).addTo(map);

            var errCount = 0;
            imgLayer.on("tileerror", function () {
                if (++errCount === 3) {
                    var isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname);
                    showMapHint(
                        isLocal
                            ? "当前通过 IP/本地地址访问，不在 Key 的域名白名单内（天地图返回「域名不匹配」）。到控制台把 127.0.0.1 加入白名单即可本地预览，或直接访问 https://shitaoy.github.io/vr-dashboard/ 查看线上效果。"
                            : "瓦片被天地图拒绝，请检查 Key 是否过期/超额，以及当前域名是否已在 Key 的域名白名单中。",
                        "卫星影像加载失败"
                    );
                }
            });
        } else {
            showMapHint("请到 console.tianditu.gov.cn 申请「浏览器端」Key，替换 js/app.js 顶部的 TIANDITU_KEY 后即可显示卫星影像");
        }

        // 图层：铁路路线 / 全景点 / 隧道口名称标注
        STATE.lineLayer = L.layerGroup().addTo(map);
        STATE.markerLayer = L.layerGroup().addTo(map);
        STATE.labelLayer = L.layerGroup().addTo(map);
        STATE.markerIndex = {};

        map.on("zoomend", function () { STATE.mapZoom = map.getZoom(); });
        map.on("zoomend", updateLabelVisibility);
        updateLabelVisibility();
        map.whenReady(function () {
            setTimeout(function () { map.invalidateSize(); }, 120);
        });

        renderMap();
    }

    function showMapHint(text, title) {
        var dom = document.getElementById("map-chart");
        if (!dom || dom.querySelector(".map-key-hint")) return;
        var el = document.createElement("div");
        el.className = "map-key-hint";
        el.innerHTML = '<div class="map-key-hint-title">' + (title || "天地图 Key 未就绪") + '</div>' +
            '<div class="map-key-hint-text">' + text + '</div>';
        dom.appendChild(el);
    }

    function buildPointTooltip(w) {
        var posColor = getPositionColor(w.position);
        return '<div class="vr-tip-wrap">' +
            '<div class="vr-tip-title" style="color:' + posColor + ';">' + w.tunnelName + '（' + w.position + '）</div>' +
            '<div class="vr-tip-body">' +
            '<div><span class="k">线路</span><span class="v">' + w.line + '</span></div>' +
            (w.tunnelNum > 0 ? '<div><span class="k">隧道编号</span><span class="v">' + w.tunnelNum + '号</span></div>' : '') +
            (w.mileage ? '<div><span class="k">里程桩号</span><span class="v amber">' + w.mileage + '</span></div>' : '') +
            '<div><span class="k">高程</span><span class="v">' + w.elevation + ' m</span></div>' +
            '<div><span class="k">维修车间</span><span class="v">' + w.workshop + '</span></div>' +
            '<div><span class="k">拍摄年份</span><span class="v green">' + w.year + '</span></div>' +
            '</div>' +
            '<div class="vr-tip-foot vr-tip-link vr-tip-link-vr">' +
                '<span class="vr-tip-link-arrow">&#9654;</span> 点击查看VR全景' +
            '</div>' +
            '<div class="vr-tip-foot vr-tip-link vr-tip-link-dev">' +
                '<span class="vr-tip-link-arrow">&#9654;</span> 点击查看设备情况' +
            '</div>' +
            '</div>';
    }

    function renderMap() {
        var map = STATE.leafletMap;
        if (!map || !STATE.markerLayer) return;

        // 过滤无坐标点并按线路/隧道号排序
        var geoWorks = getFilteredWorks().filter(function (w) {
            return w.lng !== 0 && w.lat !== 0;
        }).sort(function (a, b) {
            if (a.line !== b.line) return a.line.localeCompare(b.line);
            if (a.tunnelNum !== b.tunnelNum) return a.tunnelNum - b.tunnelNum;
            return a.position === "进口" ? -1 : 1;
        });

        STATE.lineLayer.clearLayers();
        STATE.markerLayer.clearLayers();
        STATE.labelLayer.clearLayers();
        STATE.markerIndex = {};

        // ===== 铁路路线：按线路分组着色 =====
        var lineGroups = {}, lineOrder = [];
        geoWorks.forEach(function (w) {
            if (!lineGroups[w.line]) {
                lineGroups[w.line] = [];
                lineOrder.push(w.line);
            }
            lineGroups[w.line].push([w.lat, w.lng]);
        });

        lineOrder.forEach(function (lineName) {
            var coords = lineGroups[lineName];
            if (coords.length < 2) return;
            var color = getLineColor(lineName);
            // 外发光
            L.polyline(coords, {
                color: color, weight: 6, opacity: 0.14,
                lineCap: "round", interactive: false
            }).addTo(STATE.lineLayer);
            // 流动亮线
            L.polyline(coords, {
                color: color, weight: 1.8, opacity: 0.9,
                lineCap: "round", className: "rail-flow", interactive: false
            }).addTo(STATE.lineLayer);
        });

        // ===== 全景点：按位置类型着色 =====
        geoWorks.forEach(function (w) {
            var posColor = getPositionColor(w.position);
            var marker = L.circleMarker([w.lat, w.lng], {
                radius: 4.5,
                color: "#ffffff",
                weight: 1,
                opacity: 0.9,
                fillColor: posColor,
                fillOpacity: 0.95
            });
            marker.bindTooltip(buildPointTooltip(w), {
                direction: "top",
                offset: [0, -6],
                opacity: 1,
                interactive: true,
                className: "vr-tip"
            });
            // 气泡延迟关闭：鼠标从圆点移向气泡的间隙不会立即消失，
            // 悬停在气泡上时保持显示，离开气泡约 0.4s 后关闭
            marker.off("mouseout");     // 移除 Leaflet 默认的移出立即关闭
            var closeTimer = null;
            marker.on("mouseout", function () {
                if (closeTimer) clearTimeout(closeTimer);
                closeTimer = setTimeout(function () { marker.closeTooltip(); }, 600);
            });
            marker.on("mouseover", function () {
                if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
            });
            marker.on("click", function () { openVRModal(w); });
            // 气泡内两个跳转链接（事件委托：绑定一次，内容刷新也有效）
            marker.on("tooltipopen", function (e) {
                var el = e.tooltip && e.tooltip.getElement();
                if (!el) return;
                if (!e.tooltip._linkBound) {
                    e.tooltip._linkBound = true;
                    L.DomEvent.on(el, "click", function (ev) {
                        var t = ev.target && ev.target.closest ? ev.target.closest(".vr-tip-link") : null;
                        if (!t) return;
                        L.DomEvent.preventDefault(ev);
                        L.DomEvent.stopPropagation(ev);
                        if (t.classList.contains("vr-tip-link-dev")) {
                            openDeviceDrawer(w);
                        } else if (t.classList.contains("vr-tip-link-vr")) {
                            marker.closeTooltip();
                            openVRModal(w);
                        }
                    });
                }
                // 悬停气泡期间保持显示，移开气泡后延迟关闭
                L.DomEvent.on(el, "mouseenter", function () {
                    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
                });
                L.DomEvent.on(el, "mouseleave", function () {
                    if (closeTimer) clearTimeout(closeTimer);
                    closeTimer = setTimeout(function () { marker.closeTooltip(); }, 400);
                });
            });
            marker.addTo(STATE.markerLayer);
            STATE.markerIndex[w.id] = marker;

            // 常驻名称标注（达到 LABEL_MIN_ZOOM 后经 CSS 显示）
            var label = L.marker([w.lat, w.lng], {
                icon: L.divIcon({
                    className: "",
                    html: '<div class="portal-label-wrap">' +
                        '<div class="portal-label-name">' + w.tunnelName + '</div>' +
                        '<div class="portal-label-pos" style="color:' + posColor + ';">' + w.position + '</div>' +
                        '<div class="portal-label-line"></div>' +
                        '<div class="portal-label-dot"></div>' +
                        '</div>',
                    iconSize: [0, 0],
                    iconAnchor: [0, 0]
                }),
                interactive: false,
                keyboard: false
            });
            label.addTo(STATE.labelLayer);
        });
    }

    // 标注随缩放级别显隐
    function updateLabelVisibility() {
        var map = STATE.leafletMap;
        if (!map) return;
        var on = map.getZoom() >= LABEL_MIN_ZOOM;
        map.getContainer().classList.toggle("labels-on", on);
    }

    // ===== 地图缩放控制 =====
    function setMapZoom(target) {
        var map = STATE.leafletMap;
        if (!map) return;
        STATE.mapZoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, target));
        map.setZoom(STATE.mapZoom, { animate: true });
    }

    function bindMapZoomControls() {
        var inBtn = document.getElementById("map-zoom-in");
        var outBtn = document.getElementById("map-zoom-out");
        var resetBtn = document.getElementById("map-zoom-reset");
        if (inBtn) inBtn.addEventListener("click", function () {
            if (STATE.leafletMap) STATE.leafletMap.zoomIn(1);
        });
        if (outBtn) outBtn.addEventListener("click", function () {
            if (STATE.leafletMap) STATE.leafletMap.zoomOut(1);
        });
        if (resetBtn) resetBtn.addEventListener("click", function () {
            if (STATE.leafletMap) STATE.leafletMap.setView(MAP_CENTER, MAP_INIT_ZOOM, { animate: true });
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
            var hasDev = !!w.device;
            var statusColor = hasDev ? "#10b981" : "#64748b";
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
                    '<div class="num" style="color:' + statusColor + ';font-size:12px;">' + (hasDev ? "已录入" : "未录入") + '</div>' +
                    '<div class="label">设备数据</div>' +
                '</div>' +
            '</div>';
        }).join("");

        container.querySelectorAll(".work-item").forEach(function (el) {
            el.addEventListener("click", function () {
                var id = parseInt(this.dataset.id);
                var work = STATE.allWorks.find(function (w) { return w.id === id; });
                if (work) openDeviceDrawer(work);
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

    // ===== 隧道口设备情况抽屉 =====
    // 设备字段标签（对应腾讯文档K-O列；M/O列表头为空，按内容推断）
    var DEVICE_FIELDS = [
        { key: "civil",    label: "工务设备情况",  icon: "&#127956;" },
        { key: "elec",     label: "电务设备情况",  icon: "&#9889;" },
        { key: "signal",   label: "信号设备情况",  icon: "&#128667;" },
        { key: "power",    label: "供电设备情况",  icon: "&#128161;" },
        { key: "catenary", label: "接触网支柱",    icon: "&#9935;" }
    ];

    var PORTAL_ORDER = { "进口": 0, "出口": 1, "涵洞": 2, "中心点": 3, "其他": 4 };

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function renderDeviceText(text) {
        return escapeHtml(text).replace(/\n/g, "<br>");
    }

    // 获取同一座隧道的全部洞口（同线路 + 同隧道名）
    function getTunnelPortals(work) {
        return STATE.allWorks.filter(function (w) {
            return w.line === work.line && w.tunnelName === work.tunnelName;
        }).sort(function (a, b) {
            var oa = PORTAL_ORDER[a.position] !== undefined ? PORTAL_ORDER[a.position] : 9;
            var ob = PORTAL_ORDER[b.position] !== undefined ? PORTAL_ORDER[b.position] : 9;
            if (oa !== ob) return oa - ob;
            return parseMileage(a.mileage) - parseMileage(b.mileage);
        });
    }

    function openDeviceDrawer(work) {
        var drawer = document.getElementById("device-drawer");
        var nameEl = document.getElementById("device-drawer-name");
        var badgeEl = document.getElementById("device-drawer-badge");
        var body = document.getElementById("device-drawer-body");
        var sourceEl = document.getElementById("device-drawer-source");

        STATE.currentDeviceWork = work;

        nameEl.textContent = work.tunnelName + " · 隧道口设备情况";
        badgeEl.textContent = work.line + (work.tunnelNum > 0 ? " · " + work.tunnelNum + "号隧道" : "");

        var portals = getTunnelPortals(work);
        var hasAnyDevice = portals.some(function (w) { return w.device; });

        var html = "";
        portals.forEach(function (w) {
            var posColor = getPositionColor(w.position);
            html += '<div class="device-portal">';
            html += '<div class="device-portal-head">';
            html += '<span class="device-portal-dot" style="background:' + posColor + ';box-shadow:0 0 8px ' + posColor + ';"></span>';
            html += '<span class="device-portal-name" style="color:' + posColor + ';">' + escapeHtml(w.position) + '</span>';
            if (w.mileage) html += '<span class="device-portal-mileage">' + escapeHtml(w.mileage) + '</span>';
            html += '</div>';

            if (w.device) {
                html += '<div class="device-sections">';
                DEVICE_FIELDS.forEach(function (f) {
                    var txt = w.device[f.key];
                    if (!txt) return;
                    html += '<div class="device-section">';
                    html += '<div class="device-section-label">' + f.icon + ' ' + f.label + '</div>';
                    html += '<div class="device-section-content">' + renderDeviceText(txt) + '</div>';
                    html += '</div>';
                });
                html += '</div>';
            } else {
                html += '<div class="device-empty-portal">该隧道口暂无设备排查数据</div>';
            }
            html += '</div>';
        });

        if (!hasAnyDevice) {
            html += '<div class="device-empty-tip">该隧道暂未录入设备排查数据<br>' +
                '<span>数据来源：腾讯文档「作品集模板」K-O列（目前仅2座隧道录入测试数据）</span></div>';
        }

        body.innerHTML = html;
        body.scrollTop = 0;
        sourceEl.textContent = "数据来源：腾讯文档在线表格 K-O 列";
        drawer.classList.add("active");
    }

    function closeDeviceDrawer() {
        var drawer = document.getElementById("device-drawer");
        if (drawer) drawer.classList.remove("active");
        STATE.currentDeviceWork = null;
    }

    // ===== VR预览弹窗（720云嵌入） =====
    function openVRModal(work) {
        var overlay = document.getElementById("modal-overlay");
        var titleEl = document.getElementById("modal-title-text");
        var lineBadge = document.getElementById("modal-city-badge");
        var body = document.getElementById("modal-body");
        var footer = document.getElementById("modal-footer");
        var openLink = document.getElementById("modal-open-link");

        titleEl.textContent = work.tunnelName + "（" + work.position + "）VR全景";
        lineBadge.textContent = work.line + " · " + work.year;
        openLink.href = work.url;
        openLink.target = "_blank";

        // 底部信息
        footer.querySelector('[data-meta="tunnelNum"]').textContent = work.tunnelNum > 0 ? (work.tunnelNum + "号") : "无编号";
        footer.querySelector('[data-meta="position"]').textContent = work.position;
        footer.querySelector('[data-meta="mileage"]').textContent = work.mileage || "无";
        footer.querySelector('[data-meta="elevation"]').textContent = work.elevation + " m";
        footer.querySelector('[data-meta="coords"]').textContent = (work.lng && work.lat) ? (work.lng.toFixed(6) + ", " + work.lat.toFixed(6)) : "无坐标";
        var yearMeta = footer.querySelector('[data-meta="year"]');
        if (yearMeta) yearMeta.textContent = work.year;

        // 构建720云iframe
        body.innerHTML =
            '<iframe class="modal-iframe" src="' + work.url + '" ' +
            'frameborder="0" ' +
            'allowfullscreen="allowfullscreen" ' +
            'sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" ' +
            'referrerpolicy="no-referrer"></iframe>' +
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

        // 8秒后检测
        setTimeout(function () {
            if (!loaded) {
                iframe.style.display = "none";
                placeholder.style.display = "flex";
            }
        }, 8000);

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

        // 设备抽屉事件
        document.getElementById("device-drawer-close").addEventListener("click", closeDeviceDrawer);
        document.getElementById("device-drawer-mask").addEventListener("click", closeDeviceDrawer);
        document.getElementById("device-open-vr").addEventListener("click", function () {
            if (STATE.currentDeviceWork) {
                var work = STATE.currentDeviceWork;
                closeDeviceDrawer();
                openVRModal(work);
            }
        });

        bindMapZoomControls();

        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                closeModal();
                closeDeviceDrawer();
                closeSearchDropdown();
            }
        });

        window.addEventListener("resize", function () {
            adjustScale();
            if (STATE.leafletMap) STATE.leafletMap.invalidateSize();
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
        var map = STATE.leafletMap;
        if (!map || !work.lng || !work.lat) return;

        // 飞到目标点
        var targetZoom = Math.max(map.getZoom(), 14);
        map.flyTo([work.lat, work.lng], targetZoom, { duration: 0.9 });

        var marker = STATE.markerIndex[work.id];
        if (!marker) return;

        // 打开气泡
        setTimeout(function () {
            if (marker._map) marker.openTooltip();
        }, 950);

        // 脉冲高亮
        var count = 0;
        var timer = setInterval(function () {
            count++;
            if (count > 6 || !STATE.leafletMap || !marker._map) {
                clearInterval(timer);
                marker.setStyle({ radius: 4.5, weight: 1, color: "#ffffff", opacity: 0.9 });
                return;
            }
            if (count % 2) {
                marker.setStyle({ radius: 9, weight: 2, color: "#00d4ff", opacity: 1 });
            } else {
                marker.setStyle({ radius: 4.5, weight: 1, color: "#ffffff", opacity: 0.9 });
            }
        }, 380);
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
