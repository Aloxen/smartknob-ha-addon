#!/usr/bin/env python3
"""SmartKnob Studio Add-on Backend Server."""

from __future__ import annotations

import glob
import json
import logging
import os
import re
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
                        if domain in ("light", "switch", "sensor", "binary_sensor", "climate", "media_player"):
                            attrs = item.get("attributes", {})
                            result.append({
                                "entity_id": eid,
                                "domain": domain,
                                "friendly_name": attrs.get("friendly_name", eid),
                                "state": item.get("state", ""),
                                "unit": attrs.get("unit_of_measurement", ""),
                            })
                    return sorted(result, key=lambda x: (x["domain"], x["friendly_name"]))
                else:
                    logger.warning("Failed to fetch states from HA API, code: %d", resp.status)
    except Exception as ex:
        logger.error("Error communicating with Home Assistant: %s", ex)

    return []


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
        event_data = {
            "device_name": dev.get("name", "SmartKnob"),
            "device_ip": dev.get("ip", ""),
            "config": config_obj,
        }
        pushed = await fire_ha_event("smartknob_config", event_data)

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
    event_data = {
        "device_name": dev.get("name", "SmartKnob"),
        "device_ip": dev.get("ip", ""),
        "config": config_obj,
    }
    pushed = await fire_ha_event("smartknob_config", event_data)
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
    app.router.add_static("/", static_dir, show_index=True)

    return app


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host="0.0.0.0", port=8099)
