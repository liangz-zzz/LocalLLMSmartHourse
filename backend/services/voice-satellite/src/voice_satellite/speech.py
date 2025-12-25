from __future__ import annotations

from typing import Any, Dict, List, Tuple


def compose_speech(agent_out: Dict[str, Any], devices_by_id: Dict[str, Dict[str, Any]]) -> str:
    t = str(agent_out.get("type") or "").strip()
    message = clean_text(str(agent_out.get("message") or ""))
    actions = agent_out.get("actions") if isinstance(agent_out.get("actions"), list) else []

    if t == "executed" and actions:
        summary = summarize_actions(actions, devices_by_id)
        ok, total, failures = summarize_results(agent_out.get("result"), actions)
        if total and ok == total:
            prefix = "已提交执行："
        elif total:
            prefix = f"部分失败（成功 {ok}，失败 {total - ok}）："
        else:
            prefix = "已提交执行："

        parts = [prefix + summary]
        if failures:
            parts.append("；".join(failures))
        # If upstream message contains extra hints/errors, keep it as tail.
        if message and message not in parts[0]:
            parts.append(message)
        return "。".join([p.rstrip("。") for p in parts if p])

    if t == "propose" and actions:
        summary = summarize_actions(actions, devices_by_id)
        if not message:
            return f"我准备执行：{summary}。请说确认或取消。"
        # Ensure actions are spoken even if message is generic.
        if summary and summary not in message:
            return f"{message}。我准备执行：{summary}。请说确认或取消。"
        return message

    # clarify/answer/error/canceled: speak agent message as-is
    return message or "好的。"


def summarize_actions(actions: List[dict], devices_by_id: Dict[str, Dict[str, Any]]) -> str:
    parts = []
    for a in actions:
        if not isinstance(a, dict):
            continue
        did = str(a.get("deviceId") or a.get("id") or "").strip()
        action = str(a.get("action") or "").strip()
        params = a.get("params") if isinstance(a.get("params"), dict) else {}
        if not did or not action:
            continue
        name = devices_by_id.get(did, {}).get("name") or did
        parts.append(action_to_phrase(action, name, params))
    return "，".join([p for p in parts if p]) or "执行设备操作"


def summarize_results(result: Any, actions: List[dict]) -> Tuple[int, int, List[str]]:
    if not isinstance(result, dict):
        return (0, len(actions), [])
    items = result.get("results")
    if not isinstance(items, list):
        return (0, len(actions), [])
    ok = 0
    failures: List[str] = []
    for r in items:
        if not isinstance(r, dict):
            continue
        if r.get("ok") is True:
            ok += 1
            continue
        device_id = str(r.get("deviceId") or "").strip()
        action = str(r.get("action") or "").strip()
        err = ""
        inner = r.get("result")
        if isinstance(inner, dict):
            err = str(inner.get("error") or inner.get("message") or "").strip()
        err = err or str(r.get("error") or r.get("message") or "").strip()
        failures.append("失败" + (f"（{device_id} {action} {err}）" if (device_id or action or err) else ""))
    return (ok, len(items), failures)


def action_to_phrase(action: str, device_name: str, params: Dict[str, Any]) -> str:
    if action == "turn_on":
        return f"打开{device_name}"
    if action == "turn_off":
        return f"关闭{device_name}"
    if action == "toggle":
        return f"切换{device_name}"
    if action == "set_brightness":
        v = params.get("brightness")
        if isinstance(v, (int, float)):
            return f"把{device_name}亮度调到{int(v)}%"
        return f"调整{device_name}亮度"
    if action == "set_cover_position":
        v = params.get("position")
        if isinstance(v, (int, float)):
            return f"把{device_name}窗帘调到{int(v)}%"
        return f"调整{device_name}窗帘位置"
    if action == "set_temperature":
        v = params.get("temperature")
        if isinstance(v, (int, float)):
            return f"把{device_name}温度设为{int(v)}度"
        return f"调整{device_name}温度"
    if action == "set_hvac_mode":
        v = params.get("mode")
        if isinstance(v, str) and v:
            return f"把{device_name}模式设为{v}"
        return f"调整{device_name}模式"
    return f"对{device_name}执行{action}"


def clean_text(text: str) -> str:
    t = (text or "").strip()
    t = t.replace("\n", " ").replace("\r", " ")
    while "  " in t:
        t = t.replace("  ", " ")
    return t.strip()

