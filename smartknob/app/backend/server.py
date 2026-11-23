#!/usr/bin/env python3
"""SmartKnob Studio Add-on Backend Server."""

from __future__ import annotations

import base64
import glob
import json
import logging
import os
import re
import struct
from aiohttp import ClientSession, web
import yaml

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("smartknob_studio")

CONFIG_DIR = os.environ.get("CONFIG_DIR", "/config")
if not os.path.exists(CONFIG_DIR):
    CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mock_config")
    os.makedirs(CONFIG_DIR, exist_ok=True)

SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
HA_CORE_URL = "http://supervisor/core/api"

DEFAULT_TEMPLATE = """smartknob:
  device:
    name: "Wohnzimmer Knob"
    ip: "192.168.178.133"

  menu:
    - label: "Wohnzimmer"
      icon: lightbulb
      color: "#FFAA00"
      type: submenu
      children:
        - label: "WLED Decke"
          icon: brightness
          color: "#FFAA00"
          type: screen
          screen: brightness
          entity_id: light.wohnzimmer_wled
          options:
            presets:
              - { label: "Rainbow", preset: "1", color: "#FF00FF" }
              - { label: "Cozy",    preset: "2", color: "#FF6600" }

        - label: "Stehlampe"
          icon: power
          color: "#FFFFFF"
          type: screen
          screen: switch
          entity_id: switch.stehlampe
          options:
            power_sensor: sensor.stehlampe_power
            power_threshold: 60

    - label: "Energie"
      icon: info
      color: "#00CCFF"
      type: screen
      screen: info
      options:
        items:
          - { label: "Verbrauch", type: value, entity_id: sensor.stromverbrauch, unit: "W" }
          - { label: "Heute",     type: gauge, entity_id: sensor.energie_heute, unit: "kWh", min: 0, max: 20 }
          - { label: "Verlauf",   type: chart, entity_id: sensor.stromverbrauch, time_range_hours: 24 }
"""


async def get_entities_from_ha() -> list[dict]:
    """Fetch entities from Home Assistant Core API or return mock list."""
    if not SUPERVISOR_TOKEN:
        logger.info("SUPERVISOR_TOKEN not set, returning mock entity list")
        return [
            {"entity_id": "light.wohnzimmer_wled", "domain": "light", "friendly_name": "WLED Decke", "state": "on"},
            {"entity_id": "light.stehlampe", "domain": "light", "friendly_name": "Stehlampe Licht", "state": "off"},
            {"entity_id": "light.kueche_spot", "domain": "light", "friendly_name": "Küche Spots", "state": "on"},
            {"entity_id": "switch.stehlampe", "domain": "switch", "friendly_name": "Stehlampe Steckdose", "state": "on"},
            {"entity_id": "switch.schreibtisch_steckdose", "domain": "switch", "friendly_name": "Schreibtisch", "state": "on"},
            {"entity_id": "sensor.stromverbrauch", "domain": "sensor", "friendly_name": "Aktueller Verbrauch", "state": "142.5", "unit": "W"},
            {"entity_id": "sensor.energie_heute", "domain": "sensor", "friendly_name": "Energie Heute", "state": "4.8", "unit": "kWh"},
            {"entity_id": "sensor.stehlampe_power", "domain": "sensor", "friendly_name": "Stehlampe Leistung", "state": "24.0", "unit": "W"},
            {"entity_id": "sensor.schreibtisch_power", "domain": "sensor", "friendly_name": "Schreibtisch Leistung", "state": "85.2", "unit": "W"},
            {"entity_id": "select.gaming_preset", "domain": "select", "friendly_name": "Gaming Voreinstellung", "state": "Gaming", "options": ["2 Presets test", "Blue Android", "FaceCam", "PinkGaming", "Warm Pc Only", "Warm2 friendly"]},
            {"entity_id": "input_select.wohnzimmer_scene", "domain": "input_select", "friendly_name": "Wohnzimmer Szene", "state": "Entspannung", "options": ["Entspannung", "Film", "Party", "Hell"]},
        ]

    headers = {
        "Authorization": f"Bearer {SUPERVISOR_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        async with ClientSession() as session:
            async with session.get(f"{HA_CORE_URL}/states", headers=headers, timeout=5) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    result = []
                    for item in data:
                        eid = item.get("entity_id", "")
                        domain = eid.split(".")[0] if "." in eid else ""
                        if domain in ("light", "switch", "sensor", "binary_sensor", "climate", "media_player", "select", "input_select"):
                            attrs = item.get("attributes", {})
                            entry = {
                                "entity_id": eid,
                                "domain": domain,
                                "friendly_name": attrs.get("friendly_name", eid),
                                "state": item.get("state", ""),
                                "unit": attrs.get("unit_of_measurement", ""),
                            }
                            # Include options list for select / input_select entities
                            if domain in ("select", "input_select") and "options" in attrs:
                                entry["options"] = attrs["options"]
                            result.append(entry)
                    return sorted(result, key=lambda x: (x["domain"], x["friendly_name"]))
                else:
                    logger.warning("Failed to fetch states from HA API, code: %d", resp.status)
    except Exception as ex:
        logger.error("Error communicating with Home Assistant: %s", ex)

    return []


# ── Binary Config Encoding ──────────────────────────────────────────────────

SCREEN_MARKER = 0x01
TYPE_LIGHT  = 0x01
TYPE_SWITCH = 0x02
TYPE_ENERGY = 0x03
TYPE_INFO   = 0x04
TYPE_MENU   = 0x05
TYPE_PRESET = 0x06

ICON_MAP = {
    "lightbulb": 1, "power": 2, "dashboard": 3, "brightness": 4,
    "preset": 5, "plug": 6, "gear": 7, "home": 8, "circle": 9,
}

def _str_b(s: str) -> bytes:
    """Length-prefixed string: 1 byte len + UTF-8 bytes."""
    b = (s or "").encode("utf-8")[:255]
    return bytes([len(b)]) + b

def _rgb565(hex_color: str) -> bytes:
    """#RRGGBB → 2 bytes RGB565 Big-Endian."""
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) < 6:
        return b"\xFF\xFF"
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        return struct.pack(">H", rgb565)
    except Exception:
        return b"\xFF\xFF"

def _encode_screen(item: dict) -> bytes | None:
    """Encode one menu item into binary."""
    screen = item.get("screen", "")
    opts   = item.get("options") or {}
    color  = item.get("color", "#FFFFFF")
    entity = item.get("entity_id", "")

    if item.get("type") == "submenu":
        children = item.get("children", [])
        child_bytes = b""
        child_count = 0
        for child in children:
            enc = _encode_screen(child)
            if enc:
                child_bytes += enc
                child_count += 1
        icon = ICON_MAP.get(item.get("icon", "circle"), 9)
        return (bytes([SCREEN_MARKER, TYPE_MENU, icon])
                + _rgb565(color)
                + _str_b(item.get("label", ""))
                + bytes([child_count])
                + child_bytes)

    elif screen == "brightness":
        presets = opts.get("presets", [])
        flags = 0x01 if presets else 0x00
        payload = (bytes([SCREEN_MARKER, TYPE_LIGHT, flags])
                   + _rgb565(color)
                   + _str_b(entity)
                   + _str_b(item.get("label", "")))
        payload += bytes([len(presets)])
        for p in presets:
            payload += _str_b(p.get("label", ""))
            payload += _str_b(p.get("preset", p.get("label", "")))
            payload += _rgb565(p.get("color", "#FFFFFF"))
        return payload

    elif screen == "preset":
        icon = ICON_MAP.get(item.get("icon", "preset"), 5)
        return (bytes([SCREEN_MARKER, TYPE_PRESET, icon])
                + _rgb565(color)
                + _str_b(entity)
                + _str_b(item.get("label", "")))

    elif screen == "switch":
        icon = ICON_MAP.get(item.get("icon", "power"), 2)
        power_sensor = opts.get("power_sensor", "")
        threshold    = opts.get("power_threshold", 0)
        return (bytes([SCREEN_MARKER, TYPE_SWITCH, icon])
                + _rgb565(color)
                + _str_b(entity)
                + _str_b(power_sensor)
                + struct.pack(">H", int(threshold))
                + _str_b(item.get("label", "")))

    elif screen == "info":
        items = opts.get("items", [])
        payload = bytes([SCREEN_MARKER, TYPE_INFO]) + _rgb565(color) + bytes([len(items)])
        for it in items:
            it_type = {"value": 0, "gauge": 1, "chart": 2}.get(it.get("type", "value"), 0)
            payload += (bytes([it_type])
                        + _str_b(it.get("entity_id", ""))
                        + _str_b(it.get("label", ""))
                        + _str_b(it.get("unit", ""))
                        + struct.pack(">HH", int(it.get("min", 0)), int(it.get("max", 100))))
        return payload

    return None

def encode_binary_config(config_obj: dict) -> bytes:
    """Encode menu tree to binary format with magic header b'SK\\x02' and 16-bit length."""
    menu = config_obj.get("menu", [])
    payload = b""
    for item in menu:
        enc = _encode_screen(item)
        if enc:
            payload += enc
    # Magic header: b'SK' + version 0x02 + uint16 big-endian payload length
    header = b"SK\x02" + struct.pack(">H", len(payload))
    return header + payload


async def push_binary_config(config_obj: dict, device_ip: str, device_name: str) -> bool:
    try:
        binary = encode_binary_config(config_obj)
        b64 = base64.b64encode(binary).decode("ascii")
        event_data = {
            "device_name": device_name,
            "device_ip": device_ip,
            "config_b64": b64,
            "config_len": len(binary),
        }
        return await fire_ha_event("smartknob_config_bin", event_data)
    except Exception as ex:
        logger.error("Failed to encode/push binary config: %s", ex)
        return False


def transform_menu_for_firmware(menu: list) -> list:
    """Convert Studio's nested options format to firmware-ready flat format.

    Studio stores:  item.options.power_sensor, item.options.power_threshold
    Firmware reads: item.power_sensor_id,       item.power_threshold_watts

    Also flattens preset options list to a simple string array.
    """
    out = []
    for item in (menu or []):
        it = dict(item)
        opts = it.get("options") or {}

        if it.get("screen") == "switch":
            power_sensor = opts.get("power_sensor") or opts.get("power_sensor_id") or ""
            power_threshold = opts.get("power_threshold") or opts.get("power_threshold_watts") or 0
            if power_sensor:
                it["power_sensor_id"] = power_sensor
            it["power_threshold_watts"] = float(power_threshold)
            it.pop("options", None)

        elif it.get("screen") == "preset":
            # Keep options as a flat list of label strings
            preset_opts = opts.get("options", [])
            if isinstance(preset_opts, list) and preset_opts:
                it["options"] = [
                    o if isinstance(o, str) else o.get("label", str(o))
                    for o in preset_opts
                ]
            # else leave options as-is (may already be a list of strings)

        elif it.get("screen") == "info":
            # Pass through as-is (firmware reads nested items directly)
            pass

        # Recurse into submenus
        if it.get("type") == "submenu" and it.get("children"):
            it["children"] = transform_menu_for_firmware(it["children"])

        out.append(it)
    return out


async def fire_ha_event(event_type: str, data: dict) -> bool:
    """Fire event into Home Assistant Core event bus."""
    if not SUPERVISOR_TOKEN:
        logger.info("Mock push: Fired event %s with %d bytes", event_type, len(str(data)))
        return True

    headers = {
        "Authorization": f"Bearer {SUPERVISOR_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        async with ClientSession() as session:
            async with session.post(f"{HA_CORE_URL}/events/{event_type}", headers=headers, json=data, timeout=5) as resp:
                return resp.status in (200, 201)
    except Exception as ex:
        logger.error("Failed to fire event %s: %s", event_type, ex)
        return False


# ── REST API Handlers ────────────────────────────────────────────────────────


async def api_info(request: web.Request) -> web.Response:
    ingress_path = request.headers.get("X-Ingress-Path", "")
    return web.json_response({
        "status": "ok",
        "ingress_path": ingress_path,
        "config_dir": CONFIG_DIR,
    })


async def api_devices(request: web.Request) -> web.Response:
    """List available SmartKnob config files."""
    pattern = os.path.join(CONFIG_DIR, "smartknob*.yaml")
    files = glob.glob(pattern)

    devices = []
    for f in sorted(files):
        fname = os.path.basename(f)
        try:
            with open(f, "r", encoding="utf-8") as fp:
                data = yaml.safe_load(fp) or {}
                sk = data.get("smartknob", {})
                dev = sk.get("device", {})
                devices.append({
                    "filename": fname,
                    "name": dev.get("name", fname.replace(".yaml", "")),
                    "ip": dev.get("ip", ""),
                })
        except Exception:
            devices.append({"filename": fname, "name": fname, "ip": ""})

    if not devices:
        # Create default file
        default_file = os.path.join(CONFIG_DIR, "smartknob_wohnzimmer_knob.yaml")
        try:
            with open(default_file, "w", encoding="utf-8") as fp:
                fp.write(DEFAULT_TEMPLATE)
            devices.append({
                "filename": "smartknob_wohnzimmer_knob.yaml",
                "name": "Wohnzimmer Knob",
                "ip": "192.168.178.133",
            })
        except Exception as ex:
            logger.error("Failed to write default template: %s", ex)

    return web.json_response({"devices": devices})


async def api_get_config(request: web.Request) -> web.Response:
    filename = request.query.get("file", "smartknob_wohnzimmer_knob.yaml")
    filename = os.path.basename(filename)
    filepath = os.path.join(CONFIG_DIR, filename)

    if not os.path.exists(filepath):
        # Create initial file
        with open(filepath, "w", encoding="utf-8") as fp:
            fp.write(DEFAULT_TEMPLATE)

    with open(filepath, "r", encoding="utf-8") as fp:
        raw_yaml = fp.read()

    try:
        parsed = yaml.safe_load(raw_yaml) or {}
    except Exception as ex:
        parsed = {}

    return web.json_response({
        "filename": filename,
        "yaml": raw_yaml,
        "config": parsed.get("smartknob", parsed),
    })


async def api_save_config(request: web.Request) -> web.Response:
    body = await request.json()
    filename = body.get("filename", "smartknob_wohnzimmer_knob.yaml")
    filename = os.path.basename(filename)
    filepath = os.path.join(CONFIG_DIR, filename)

    config_obj = body.get("config")
    yaml_str = body.get("yaml")
    push = body.get("push", True)

    if yaml_str is None and config_obj is not None:
        yaml_str = yaml.dump({"smartknob": config_obj}, sort_keys=False, allow_unicode=True)

    with open(filepath, "w", encoding="utf-8") as fp:
        fp.write(yaml_str)

    pushed = False
    if push and config_obj:
        dev = config_obj.get("device", {})
        device_name = dev.get("name", "SmartKnob")
        device_ip = dev.get("ip", "")

        # 1. Push binary format
        pushed_bin = await push_binary_config(config_obj, device_ip, device_name)

        # 2. Also push legacy JSON format for backwards compatibility
        fw_config = dict(config_obj)
        fw_config["menu"] = transform_menu_for_firmware(config_obj.get("menu", []))
        event_data = {
            "device_name": device_name,
            "device_ip": device_ip,
            "config": fw_config,
        }
        pushed_json = await fire_ha_event("smartknob_config", event_data)
        pushed = pushed_bin or pushed_json

    return web.json_response({
        "status": "saved",
        "filename": filename,
        "pushed": pushed,
    })


async def api_push_config(request: web.Request) -> web.Response:
    body = await request.json()
    filename = body.get("filename", "smartknob_wohnzimmer_knob.yaml")
    filename = os.path.basename(filename)
    filepath = os.path.join(CONFIG_DIR, filename)

    if not os.path.exists(filepath):
        return web.json_response({"error": "File not found"}, status=404)

    with open(filepath, "r", encoding="utf-8") as fp:
        data = yaml.safe_load(fp) or {}

    config_obj = data.get("smartknob", data)
    dev = config_obj.get("device", {})
    device_name = dev.get("name", "SmartKnob")
    device_ip = dev.get("ip", "")

    # Push both binary and JSON
    pushed_bin = await push_binary_config(config_obj, device_ip, device_name)
    fw_config = dict(config_obj)
    fw_config["menu"] = transform_menu_for_firmware(config_obj.get("menu", []))
    event_data = {
        "device_name": device_name,
        "device_ip": device_ip,
        "config": fw_config,
    }
    pushed_json = await fire_ha_event("smartknob_config", event_data)
    pushed = pushed_bin or pushed_json
    return web.json_response({"status": "ok", "pushed": pushed})


async def api_entities(request: web.Request) -> web.Response:
    entities = await get_entities_from_ha()
    return web.json_response({"entities": entities})


def create_app() -> web.Application:
    app = web.Application()

    # API routes
    app.router.add_get("/api/info", api_info)
    app.router.add_get("/api/devices", api_devices)
    app.router.add_get("/api/config", api_get_config)
    app.router.add_post("/api/config", api_save_config)
    app.router.add_post("/api/push", api_push_config)
    app.router.add_get("/api/entities", api_entities)

    # Static frontend files
    static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static")
    os.makedirs(static_dir, exist_ok=True)

    async def index_handler(request: web.Request) -> web.Response:
        ingress_path = request.headers.get("X-Ingress-Path", "").rstrip("/")
        index_file = os.path.join(static_dir, "index.html")
        with open(index_file, "r", encoding="utf-8") as f:
            html = f.read()

        if ingress_path:
            base_tag = f'<base href="{ingress_path}/">'
            if "<head>" in html:
                html = html.replace("<head>", f"<head>\n  {base_tag}")

        return web.Response(text=html, content_type="text/html")

    async def style_handler(request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(static_dir, "style.css"))

    async def app_js_handler(request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(static_dir, "app.js"))

    async def favicon_handler(request: web.Request) -> web.Response:
        return web.Response(status=204)

    async def catch_all_handler(request: web.Request) -> web.StreamResponse:
        path = request.match_info.get("tail", "")
        filepath = os.path.join(static_dir, path)
        if path and os.path.isfile(filepath):
            return web.FileResponse(filepath)
        return await index_handler(request)

    app.router.add_get("/", index_handler)
    app.router.add_get("/index.html", index_handler)
    app.router.add_get("/style.css", style_handler)
    app.router.add_get("/app.js", app_js_handler)
    app.router.add_get("/favicon.ico", favicon_handler)
    app.router.add_get("/{tail:.*}", catch_all_handler)

    return app


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host="0.0.0.0", port=8099)
