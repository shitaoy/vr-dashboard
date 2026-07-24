#!/usr/bin/env python3
"""
sync_tencent_docs.py - 从腾讯文档在线表格同步数据并生成 data.js

用法:
    python sync_tencent_docs.py

流程:
    1. 从腾讯文档 API 获取表格数据
    2. 解码 base64 + zlib 解压
    3. 用 blackboxprotobuf 解析 protobuf
    4. 提取单元格文本和数字值
    5. 按 (行,列) 重建完整表格
    6. 生成 js/data.js
"""

import urllib.request
import json
import base64
import zlib
import struct
import re
import os
import datetime

# ===== 配置 =====
DOC_ID = "DYk1EZUJBQmR0dmJa"
DOC_URL = f"https://docs.qq.com/sheet/{DOC_ID}"
API_URL = f"https://docs.qq.com/dop-api/opendoc?id={DOC_ID}&normal=1&outformat=1"

# 线路颜色定义
LINES_CONFIG = [
    {"name": "杭温铁路", "code": "hw", "color": "#00d4ff"},
    {"name": "杭昌高铁", "code": "hc", "color": "#f59e0b"},
    {"name": "沪昆高铁", "code": "hk", "color": "#10b981"},
    {"name": "沪昆线", "code": "hkx", "color": "#84cc16"},
    {"name": "衢九线", "code": "qj", "color": "#a855f7"},
    {"name": "杭衢高铁", "code": "hq", "color": "#ef4444"},
]

OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js", "data.js")

# 表头定义（10列）
HEADERS = ["线名", "隧道号", "隧道名", "里程桩号", "全景点经度",
           "全景点纬度", "全景点高程", "所在维修车间", "拍摄时间", "720云链接"]
NUM_COLS = len(HEADERS)

# 数字列（0-based列号）：隧道号(1), 经度(4), 纬度(5), 高程(6), 拍摄时间(8)
NUMERIC_COLS = {1, 4, 5, 6, 8}
# 隧道号列直接使用 f2.1 作为整数值
DIRECT_INT_COLS = {1}
# 其他数字列使用 f2.1 作为 num_values 的索引（需要减去偏移量）
INDEXED_NUM_COLS = {4, 5, 6, 8}

# ===== 工点分布附表配置 =====
WORK_TYPE_TAB_ID = "dv5mdr"  # "工点分布"附表的 tab ID
WORK_TYPE_SHEET_COLS = 3  # A列=线名, B列=工点类型, C列=长度(km)

# 线名映射：附表中的简称 → VR数据中的全称
LINE_NAME_MAP = {
    "杭温": "杭温铁路",
    "杭昌": "杭昌高铁",
    "沪昆高铁": "沪昆高铁",
    "沪昆": "沪昆线",
    "衢九": "衢九线",
    "杭衢": "杭衢高铁",
}


def fetch_sheet_data(tab_id=None):
    """从腾讯文档 API 获取表格数据，可指定 tab_id 获取不同附表"""
    url = API_URL
    if tab_id:
        url = f"https://docs.qq.com/dop-api/opendoc?id={DOC_ID}&tab={tab_id}&normal=1&outformat=1"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": DOC_URL,
    })
    resp = urllib.request.urlopen(req, timeout=20)
    return json.loads(resp.read())


def decode_protobuf_data(api_data):
    """解码 API 数据，返回 text_values 和 num_values 以及单元格位置列表"""
    import blackboxprotobuf

    cv = api_data.get("clientVars", {})
    ccv = cv.get("collab_client_vars", {})
    iat = ccv.get("initialAttributedText", {})
    text_list = iat.get("text", [])

    if not text_list:
        raise ValueError("未找到表格数据 (initialAttributedText.text 为空)")

    related_sheet = text_list[0].get("related_sheet", "")
    if not related_sheet:
        raise ValueError("related_sheet 字段为空")

    # 解码 base64 + zlib
    raw = base64.b64decode(related_sheet)
    decompressed = zlib.decompress(raw)

    # 用 blackboxprotobuf 解析
    decoded, typedef = blackboxprotobuf.decode_message(decompressed)

    # 动态查找包含实际数据的 sheet（遍历 decoded["1"]["5"] 列表）
    # 每个item有一个递增的key（"5", "14", "19", ...），其中包含 cells 数据
    # 我们需要找到包含非空 text_values 的那个
    sheet_data = None
    items = decoded["1"]["5"]
    for item in items:
        for key in item:
            if key == "1":
                continue
            data = item[key]
            if isinstance(data, dict) and "5" in data and "6" in data:
                inner = data["5"]
                if isinstance(inner, dict) and inner.get("1"):
                    # 找到了有文本数据的 sheet
                    sheet_data = data
                    break
        if sheet_data:
            break

    if sheet_data is None:
        raise ValueError("未找到包含数据的 sheet")

    # 提取文本值
    text_values = []
    for item in sheet_data["5"]["1"]:
        val = item.get("1", b"")
        if isinstance(val, bytes):
            text_values.append(val.decode("utf-8", errors="replace"))
        else:
            text_values.append(str(val))

    # 提取数字值（int64 → double）
    num_values = []
    for item in sheet_data["5"]["3"]:
        val = item.get("1", 0)
        try:
            packed = struct.pack("<q", val)
            dval = struct.unpack("<d", packed)[0]
            num_values.append(dval)
        except Exception:
            num_values.append(0.0)

    # 提取单元格位置
    cells = sheet_data["6"]

    return text_values, num_values, cells


def reconstruct_table(text_values, num_values, cells):
    """根据单元格位置信息重建完整表格"""

    # 找到数字索引的偏移量
    # 通过第一个 type=2 的索引数字列来确定
    num_offset = None
    for cell in cells:
        ci = cell.get("3", {})
        ctype = ci.get("1", 0)
        col = cell.get("2", 0)
        if ctype == 2 and col in INDEXED_NUM_COLS:
            f2 = ci.get("2", {})
            f2_val = f2.get("1", None) if isinstance(f2, dict) else None
            if f2_val is not None and f2_val > 0:
                # 第一个索引数字列的值应该是 lng (约119-122)
                # 对应 num_values[0]
                num_offset = f2_val
                break

    if num_offset is None:
        num_offset = 0
    print(f"  数字索引偏移量: {num_offset}")

    # 构建 (row, col) -> value 映射
    table = {}  # {(row, col): value}

    for cell in cells:
        row = cell.get("1", 0)
        col = cell.get("2", 0)
        ci = cell.get("3", {})
        ctype = ci.get("1", 0)
        f2 = ci.get("2", {})
        f2_val = f2.get("1", None) if isinstance(f2, dict) else None

        value = None

        if ctype == 4:
            # 文本单元格：f2.1 是 text_values 的索引
            idx = f2_val if f2_val is not None else 0
            if idx < len(text_values):
                value = text_values[idx]
            else:
                value = ""

        elif ctype == 2:
            # 数字单元格
            if col in DIRECT_INT_COLS:
                # 隧道号：f2.1 是直接整数值
                value = f2_val if f2_val is not None else 0
            elif col in INDEXED_NUM_COLS and f2_val is not None:
                # 经度/纬度/高程/年份：f2.1 是 num_values 的索引
                idx = f2_val - num_offset
                if 0 <= idx < len(num_values):
                    value = num_values[idx]
                else:
                    value = 0.0
            else:
                value = f2_val if f2_val is not None else 0

        if value is not None:
            table[(row, col)] = value

    # 找到最大行列
    max_row = max(r for r, c in table.keys()) if table else 0
    max_col = max(c for r, c in table.keys()) if table else 0

    # 重建二维表格
    rows = []
    for r in range(max_row + 1):
        row_data = []
        for c in range(NUM_COLS):
            val = table.get((r, c), None)
            row_data.append(val)
        rows.append(row_data)

    return rows


def parse_work_data(rows):
    """将原始行数据解析为结构化的VR作品数据"""
    works = []
    tunnel_mileages = {}

    # 跳过表头行（row 0）
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < NUM_COLS:
            continue

        line = str(row[0]).strip() if row[0] is not None else ""
        tunnel_num_raw = row[1]
        tunnel_name_raw = str(row[2]).strip() if row[2] is not None else ""
        mileage_raw = str(row[3]).strip() if row[3] is not None else ""
        lng_raw = row[4]
        lat_raw = row[5]
        elev_raw = row[6]
        workshop = str(row[7]).strip() if row[7] is not None else ""
        year_raw = row[8]
        url = str(row[9]).strip() if row[9] is not None else ""

        # 跳过空行
        if not line and not tunnel_name_raw and not url:
            continue

        # 解析隧道编号
        try:
            tunnel_num = int(tunnel_num_raw) if tunnel_num_raw is not None else 0
        except (ValueError, TypeError):
            tunnel_num = 0

        # 解析进出口位置
        if "进口" in tunnel_name_raw:
            position = "进口"
        elif "出口" in tunnel_name_raw:
            position = "出口"
        elif "涵洞" in tunnel_name_raw:
            position = "涵洞"
        elif "中心" in tunnel_name_raw:
            position = "中心点"
        else:
            position = ""

        # 清理隧道名
        clean_name = tunnel_name_raw
        for suffix in ["（进口）", "（出口）", "(进口)", "(出口)", "（涵洞）", "(涵洞)", "（中心点）", "(中心点)"]:
            clean_name = clean_name.replace(suffix, "")
        clean_name = clean_name.strip()

        # 清理里程
        mileage = mileage_raw
        for suffix in ["（进口）", "（出口）", "(进口)", "(出口)"]:
            mileage = mileage.replace(suffix, "")
        mileage = mileage.strip()

        # 解析经纬度
        try:
            lng = round(float(lng_raw), 6) if lng_raw is not None else 0.0
        except (ValueError, TypeError):
            lng = 0.0
        try:
            lat = round(float(lat_raw), 6) if lat_raw is not None else 0.0
        except (ValueError, TypeError):
            lat = 0.0

        # 解析高程
        try:
            elevation = round(float(elev_raw), 1) if elev_raw is not None else 0.0
        except (ValueError, TypeError):
            elevation = 0.0

        # 解析年份
        if year_raw is not None:
            year = str(int(year_raw)) if isinstance(year_raw, (int, float)) and year_raw > 0 else str(year_raw).strip()
        else:
            year = ""

        # 追踪隧道里程范围
        m_match = re.search(r"K(\d+)\+(\d+)", mileage)
        if m_match:
            m_val = int(m_match.group(1)) * 1000 + int(m_match.group(2))
            key = f"{line}:{tunnel_num}"
            if key not in tunnel_mileages:
                tunnel_mileages[key] = {"min": m_val, "max": m_val, "name": clean_name}
            else:
                tunnel_mileages[key]["min"] = min(tunnel_mileages[key]["min"], m_val)
                tunnel_mileages[key]["max"] = max(tunnel_mileages[key]["max"], m_val)

        works.append({
            "id": i,
            "line": line,
            "tunnelNum": tunnel_num,
            "tunnelName": clean_name,
            "position": position,
            "mileage": mileage,
            "lng": lng,
            "lat": lat,
            "elevation": elevation,
            "workshop": workshop,
            "year": year,
            "url": url,
        })

    # 构建隧道汇总
    tunnels_summary = []
    for key in sorted(tunnel_mileages.keys()):
        info = tunnel_mileages[key]
        tnum = int(key.split(":")[1]) if ":" in key else 0
        length = info["max"] - info["min"]
        tunnels_summary.append({
            "num": tnum,
            "name": info["name"],
            "length": length,
        })

    return works, tunnels_summary


def fetch_and_parse_work_types():
    """从腾讯文档'工点分布'附表获取并解析工点类型长度数据
    
    附表结构：A列=线名, B列=工点类型, C列=长度(km)
    返回：{line_full_name: {"桥梁": meters, "路基": meters, "隧道": meters}}
    """
    import blackboxprotobuf
    
    print("  [工点分布] 获取附表数据...")
    api_data = fetch_sheet_data(tab_id=WORK_TYPE_TAB_ID)
    
    cv = api_data.get("clientVars", {})
    ccv = cv.get("collab_client_vars", {})
    iat = ccv.get("initialAttributedText", {})
    text_list = iat.get("text", [])
    
    if not text_list or "related_sheet" not in text_list[0]:
        print("  [工点分布] ⚠ 未找到附表数据")
        return {}
    
    # 解码 protobuf
    raw = base64.b64decode(text_list[0]["related_sheet"])
    decompressed = zlib.decompress(raw)
    decoded, typedef = blackboxprotobuf.decode_message(decompressed)
    
    # 动态查找包含实际数据的 sheet
    sheet_data = None
    items = decoded["1"]["5"]
    for item in items:
        for key in item:
            if key == "1":
                continue
            data = item[key]
            if isinstance(data, dict) and "5" in data and "6" in data:
                inner = data["5"]
                if isinstance(inner, dict) and inner.get("1"):
                    sheet_data = data
                    break
        if sheet_data:
            break
    
    if sheet_data is None:
        print("  [工点分布] ⚠ 未找到包含数据的 sheet")
        return {}
    
    # 提取文本值
    text_values = []
    for item in sheet_data["5"]["1"]:
        val = item.get("1", b"")
        if isinstance(val, bytes):
            text_values.append(val.decode("utf-8", errors="replace"))
        else:
            text_values.append(str(val))
    
    # 提取数字值（int64 → double）
    num_values = []
    for item in sheet_data["5"]["3"]:
        val = item.get("1", 0)
        try:
            packed = struct.pack("<q", val)
            dval = struct.unpack("<d", packed)[0]
            num_values.append(dval)
        except Exception:
            num_values.append(0.0)
    
    # 提取单元格
    cells = sheet_data["6"]
    print(f"  [工点分布] 文本值: {len(text_values)} 个, 数字值: {len(num_values)} 个, 单元格: {len(cells)} 个")
    
    # 确定数字索引偏移量
    num_offset = None
    for cell in cells:
        ci = cell.get("3", {})
        ctype = ci.get("1", 0)
        col = cell.get("2", 0)
        if ctype == 2 and col == 2:  # C列（长度）是数字列
            f2 = ci.get("2", {})
            f2_val = f2.get("1", None) if isinstance(f2, dict) else None
            if f2_val is not None and f2_val >= 100:
                num_offset = f2_val
                break
    if num_offset is None:
        num_offset = 129  # 默认偏移量
    print(f"  [工点分布] 数字索引偏移量: {num_offset}")
    
    # 构建 (row, col) -> value 映射
    table = {}
    for cell in cells:
        row = cell.get("1", 0)
        col = cell.get("2", 0)
        ci = cell.get("3", {})
        ctype = ci.get("1", 0)
        f2 = ci.get("2", {})
        f2_val = f2.get("1", None) if isinstance(f2, dict) else None
        
        value = None
        if ctype == 4:
            # 文本单元格
            idx = f2_val if f2_val is not None else 0
            if idx < len(text_values):
                value = text_values[idx]
            else:
                value = ""
        elif ctype == 2:
            # 数字单元格：判断是索引还是直接值
            if f2_val is not None and f2_val >= num_offset:
                idx = f2_val - num_offset
                if 0 <= idx < len(num_values):
                    value = num_values[idx]
                else:
                    value = 0.0
            else:
                # 直接值
                value = float(f2_val) if f2_val is not None else 0.0
        
        if value is not None:
            table[(row, col)] = value
    
    # 解析数据行（跳过表头 row 0）
    work_types_data = {}
    for r in range(1, max(row for row, col in table.keys()) + 1 if table else 1):
        line_short = str(table.get((r, 0), "")).strip()
        work_type = str(table.get((r, 1), "")).strip()
        length_km = table.get((r, 2), None)
        
        if not line_short or not work_type:
            continue
        if work_type not in ("桥梁", "路基", "隧道"):
            continue
        
        # 线名映射
        line_full = LINE_NAME_MAP.get(line_short, line_short)
        
        # km → m
        try:
            length_m = float(length_km) * 1000 if length_km is not None else 0.0
        except (ValueError, TypeError):
            length_m = 0.0
        
        if line_full not in work_types_data:
            work_types_data[line_full] = {"桥梁": 0, "路基": 0, "隧道": 0}
        work_types_data[line_full][work_type] = length_m
        
        print(f"    {line_short}({line_full}) - {work_type}: {length_km} km → {length_m} m")
    
    return work_types_data


def generate_data_js(works, tunnels_summary, work_types_data):
    """生成 js/data.js 文件"""
    js_lines = []
    js_lines.append("/**")
    js_lines.append(" * ============================================================")
    js_lines.append(" *  金华高铁基础设施段管VR全景 - 数据配置文件")
    js_lines.append(" * ============================================================")
    js_lines.append(" *  数据来源：腾讯文档在线表格（自动同步）")
    js_lines.append(f" *  文档链接：{DOC_URL}")
    js_lines.append(f" *  同步时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    js_lines.append(f" *  作品总数：{len(works)} 条")
    js_lines.append(f" *  隧道总数：{len(tunnels_summary)} 座")
    js_lines.append(" * ============================================================")
    js_lines.append(" */")
    js_lines.append("")
    js_lines.append("const VR_DATA = {")
    js_lines.append("")
    js_lines.append("  // ===== 铁路线路定义（颜色用于地图标注区分） =====")
    js_lines.append("  lines: " + json.dumps(LINES_CONFIG, ensure_ascii=False, indent=4) + ",")
    js_lines.append("")
    js_lines.append("  // ===== VR全景类型 =====")
    js_lines.append('  categories: ["隧道进口", "隧道出口", "涵洞", "中心点"],')
    js_lines.append("")
    js_lines.append("  // ===== 隧道汇总（编号、名称、长度米） =====")
    js_lines.append("  tunnels: " + json.dumps(tunnels_summary, ensure_ascii=False, indent=4) + ",")
    js_lines.append("")

    # 生成工点类型长度数据（确保所有线路都有数据，即使为0）
    js_lines.append("  // ===== 工点类型长度数据（桥梁/路基/隧道，按线路区分） =====")
    js_lines.append("  // 数据来源：腾讯文档在线表格「工点分布」附表（A列=线名, B列=工点类型, C列=长度km）")
    js_lines.append("  // 单位：米（m），附表原始数据为km，已自动×1000转换")
    full_work_types = {}
    for line_cfg in LINES_CONFIG:
        line_name = line_cfg["name"]
        if line_name in work_types_data:
            full_work_types[line_name] = work_types_data[line_name]
        else:
            full_work_types[line_name] = {"桥梁": 0, "路基": 0, "隧道": 0}
    js_lines.append("  workTypes: " + json.dumps(full_work_types, ensure_ascii=False, indent=4) + ",")
    js_lines.append("")

    js_lines.append(f"  // ===== VR全景作品列表（共 {len(works)} 条） =====")
    js_lines.append("  works: [")

    for w in works:
        js_lines.append("    {" +
            "id: " + str(w["id"]) + ", " +
            'line: "' + w["line"] + '", ' +
            "tunnelNum: " + str(w["tunnelNum"]) + ", " +
            'tunnelName: "' + w["tunnelName"] + '", ' +
            'position: "' + w["position"] + '", ' +
            'mileage: "' + w["mileage"] + '", ' +
            "lng: " + str(w["lng"]) + ", " +
            "lat: " + str(w["lat"]) + ", " +
            "elevation: " + str(w["elevation"]) + ", " +
            'workshop: "' + w["workshop"] + '", ' +
            'year: "' + w["year"] + '", ' +
            'url: "' + w["url"] + '"' +
            "},")

    js_lines.append("  ]")
    js_lines.append("};")

    return "\n".join(js_lines)


def main():
    print("=" * 60)
    print("  腾讯文档在线表格 → data.js 同步工具")
    print("=" * 60)
    print(f"  文档链接: {DOC_URL}")
    print()

    # 1. 获取主表数据
    print("[1/6] 从腾讯文档 API 获取主表数据...")
    api_data = fetch_sheet_data()
    print("      ✓ API 响应成功")

    # 2. 解码 protobuf
    print("[2/6] 解码 protobuf 数据...")
    text_values, num_values, cells = decode_protobuf_data(api_data)
    print(f"      ✓ 文本值: {len(text_values)} 个")
    print(f"      ✓ 数字值: {len(num_values)} 个")
    print(f"      ✓ 单元格: {len(cells)} 个")

    # 3. 重建表格
    print("[3/6] 重建表格结构...")
    rows = reconstruct_table(text_values, num_values, cells)
    print(f"      ✓ 表格: {len(rows)} 行 × {NUM_COLS} 列")
    print(f"      ✓ 数据行（不含表头）: {len(rows) - 1} 行")

    # 显示前3行验证
    for i, row in enumerate(rows[1:4]):
        print(f"      预览行{i+1}: {row[0]} | {row[1]} | {row[2]} | {row[3]} | lng={row[4]} | lat={row[5]} | elev={row[6]} | {row[7]} | year={row[8]} | {str(row[9])[:40]}")

    # 4. 解析VR作品数据
    print("[4/6] 解析VR作品数据...")
    works, tunnels = parse_work_data(rows)
    print(f"      ✓ 作品总数: {len(works)} 条")
    print(f"      ✓ 隧道总数: {len(tunnels)} 座")

    # 5. 获取工点分布附表数据
    print("[5/6] 获取「工点分布」附表数据...")
    work_types_data = fetch_and_parse_work_types()
    if work_types_data:
        print(f"      ✓ 工点类型数据:")
        for line_name, type_data in work_types_data.items():
            total = sum(type_data.values())
            if total > 0:
                print(f"        {line_name}: 桥梁={type_data['桥梁']/1000:.1f}km, 路基={type_data['路基']/1000:.1f}km, 隧道={type_data['隧道']/1000:.1f}km")
    else:
        print(f"      ⚠ 未获取到工点类型数据")

    # 6. 生成 data.js
    print("[6/6] 生成 data.js...")
    js_content = generate_data_js(works, tunnels, work_types_data)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(js_content)

    print(f"      ✓ 已写入: {OUTPUT_PATH}")

    # 统计线路分布
    line_counts = {}
    for w in works:
        line_counts[w["line"]] = line_counts.get(w["line"], 0) + 1
    print(f"      ✓ 线路分布: {line_counts}")

    # 统计年份分布
    year_counts = {}
    for w in works:
        year_counts[w["year"]] = year_counts.get(w["year"], 0) + 1
    print(f"      ✓ 年份分布: {year_counts}")

    print()
    print("=" * 60)
    print("  同步完成！")
    print("=" * 60)


if __name__ == "__main__":
    main()
