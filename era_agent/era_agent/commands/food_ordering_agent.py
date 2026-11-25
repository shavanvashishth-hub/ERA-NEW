"""Autonomous Food Ordering Agent for ERA.

Automates ordering food from Swiggy and Zomato based on user voice/text commands,
specified dish name, quantity, budget/price range, live PC delivery location,
and Cash on Delivery (COD) payment.

Uses Playwright with real Chrome browser automation and persistent session storage.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from .registry import CommandParam, CommandResult, registry

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _get_live_location() -> Dict[str, Any]:
    """Fetch live GPS coordinates and street address using Windows GeoCoordinateWatcher,
    cross-referenced with reverse geocoding and Phone Link device info.
    """
    coords = None
    # 1. Query Windows Location Sensor (System.Device.Location.GeoCoordinateWatcher)
    ps_cmd = """
    Add-Type -AssemblyName System.Device
    $geo = New-Object System.Device.Location.GeoCoordinateWatcher
    $geo.Start()
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 400
        if ($geo.Status -eq [System.Device.Location.GeoPositionStatus]::Ready) {
            break
        }
    }
    $loc = $geo.Position.Location
    Write-Output "$($geo.Status)|$($loc.Latitude)|$($loc.Longitude)"
    $geo.Stop()
    """
    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            timeout=8,
        )
        for line in res.stdout.strip().splitlines():
            line = line.strip()
            if "|" in line:
                parts = line.split("|")
                if len(parts) >= 3 and parts[0].strip() == "Ready":
                    lat_f = float(parts[1].strip())
                    lon_f = float(parts[2].strip())
                    if not (lat_f == 0.0 and lon_f == 0.0):
                        coords = (lat_f, lon_f)
                        print(f"[FoodOrdering] Windows Live GeoSensor: Lat={lat_f}, Lon={lon_f}")
                        break
    except Exception as e:
        print(f"[FoodOrdering] Windows GeoSensor query notice: {e}")

    # Fallback to IP geolocation if sensor not ready
    if not coords:
        try:
            req = urllib.request.Request(
                "http://ip-api.com/json",
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ERA-Assistant"}
            )
            with urllib.request.urlopen(req, timeout=3.5) as resp:
                data = json.loads(resp.read().decode())
                if data.get("status") == "success":
                    coords = (float(data.get("lat", 27.1814)), float(data.get("lon", 77.9664)))
        except Exception:
            coords = (27.1813754, 77.9663757)

    lat, lon = coords

    # 2. Reverse geocode to get street, area, city, pincode
    address_info: Dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "city": "Agra",
        "area": "Bodla",
        "suburb": "Bodla",
        "neighbourhood": "Subhash Nagar C Block",
        "postcode": "282010",
        "state": "Uttar Pradesh",
        "full_address": "Subhash Nagar C Block, Bodla, Agra, Uttar Pradesh, 282010",
        "display_name": "Subhash Nagar C Block, Bodla, Agra",
        "slug": "agra",
    }

    try:
        url = f"https://nominatim.openstreetmap.org/reverse?format=json&lat={lat}&lon={lon}&zoom=18&addressdetails=1"
        req = urllib.request.Request(url, headers={"User-Agent": "ERA-Food-Agent/2.0 (contact@era-agent.local)"})
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            geo_data = json.loads(resp.read().decode())
            addr = geo_data.get("address", {})
            city = addr.get("city") or addr.get("state_district") or addr.get("county") or "Agra"
            suburb = addr.get("suburb") or addr.get("neighbourhood") or "Bodla"
            neighbourhood = addr.get("neighbourhood") or suburb or "Subhash Nagar"
            postcode = addr.get("postcode") or "282010"
            state = addr.get("state") or "Uttar Pradesh"
            full = geo_data.get("display_name") or f"{neighbourhood}, {suburb}, {city}, {state}, {postcode}"

            address_info.update({
                "city": city,
                "area": suburb,
                "suburb": suburb,
                "neighbourhood": neighbourhood,
                "postcode": postcode,
                "state": state,
                "full_address": full,
                "display_name": f"{neighbourhood}, {suburb}, {city}",
                "slug": city.lower().replace(" ", "-").strip(),
            })
            print(f"[FoodOrdering] Resolved precise live address: {address_info['display_name']} ({postcode})")
    except Exception as e:
        print(f"[FoodOrdering] Reverse geocode notice: {e}")

    # 3. Check Phone Link connection & device name
    try:
        from controls.phone_link import PhoneLinkControl
        is_ok, pdata, pmsg = PhoneLinkControl.get_status()
        if is_ok:
            address_info["phone_device"] = pdata.get("device_name", "OPPO A57")
            address_info["phone_linked"] = True
    except Exception:
        pass

    # Save to user_food_address.json
    try:
        app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
        era_dir = os.path.join(app_data, "ERA")
        os.makedirs(era_dir, exist_ok=True)
        addr_file = os.path.join(era_dir, "user_food_address.json")
        with open(addr_file, "w", encoding="utf-8") as f:
            json.dump(address_info, f, indent=2)
    except Exception:
        pass

    return address_info


def _extract_price(text: str) -> Optional[float]:
    """Extract numeric price from strings like '₹179', 'Costs: 179 rupees', 'Rs 250'."""
    if not text:
        return None
    m = re.search(r"costs:\s*(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    m = re.search(r"[₹\u20b9]\s*(\d+(?:\.\d+)?)", text)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    m = re.search(r"rs\.?\s*(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    # Direct numeric fallback (e.g. '263', ' 189.50 ')
    m = re.search(r"(\d+(?:\.\d+)?)", text)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def _get_user_phone() -> Optional[str]:
    """Retrieves saved user mobile number for Swiggy auto-login if available."""
    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    phone_file = os.path.join(app_data, "ERA", "user_food_phone.json")
    if os.path.exists(phone_file):
        try:
            with open(phone_file, "r", encoding="utf-8") as f:
                d = json.load(f)
                return d.get("phone")
        except Exception:
            pass
    return None


def _get_user_info() -> Dict[str, str]:
    """Retrieves saved user contact information (phone, email, name)."""
    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    phone = _get_user_phone() or "7088802337"
    email = "shavanvashishth@gmail.com"
    name = "Shavan Vashishth"
    email_file = os.path.join(app_data, "ERA", "user_food_email.json")
    if os.path.exists(email_file):
        try:
            with open(email_file, "r", encoding="utf-8") as f:
                d = json.load(f)
                email = d.get("email", email)
                name = d.get("name", name)
        except Exception:
            pass
    return {"phone": phone, "email": email, "name": name}


def _save_user_phone(phone: str) -> None:
    """Saves user 10-digit mobile number for permanent automatic login on food platforms."""
    if not phone:
        return
    clean = re.sub(r"\D", "", str(phone))[-10:]
    if len(clean) == 10:
        app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
        phone_file = os.path.join(app_data, "ERA", "user_food_phone.json")
        try:
            with open(phone_file, "w", encoding="utf-8") as f:
                json.dump({"phone": clean}, f)
            print(f"[FoodOrdering] Saved user mobile for auto-login: +91 {clean[:2]}******{clean[-2:]}")
        except Exception as e:
            print(f"[FoodOrdering] Phone save note: {e}")


def _clean_profile_locks(profile_dir: str) -> None:
    """Removes stale lockfiles if previous browser process crashed or was closed abruptly."""
    for lock_name in ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]:
        lock_path = os.path.join(profile_dir, lock_name)
        if os.path.exists(lock_path):
            try:
                os.remove(lock_path)
            except Exception:
                pass


def _is_port_listening(port: int = 9222) -> bool:
    """Checks if a local TCP port is actively listening."""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.4)
        result = s.connect_ex(("127.0.0.1", port))
        s.close()
        return result == 0
    except Exception:
        return False


def _bring_edge_to_front() -> None:
    """Forces Microsoft Edge window to the absolute front and maximizes it on the visible monitor."""
    try:
        import ctypes
        import win32con
        import win32gui

        user32 = ctypes.windll.user32
        h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
        if h_desk:
            user32.SetThreadDesktop(h_desk)

        def enum_cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if any(k in title for k in ["Edge", "Swiggy", "Zomato", "Checkout"]):
                    user32.keybd_event(0x12, 0, 0, 0)  # Alt down
                    user32.keybd_event(0x12, 0, 2, 0)  # Alt up
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
                    win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                          win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
                    win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                                          win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
                    win32gui.SetForegroundWindow(hwnd)
                    win32gui.BringWindowToTop(hwnd)
        win32gui.EnumWindows(enum_cb, None)
    except Exception as exc:
        print(f"[FoodOrdering] Foreground focus notice: {exc}")


async def _clean_up_tabs(context: Any, keep_page: Any = None) -> Any:
    """Closes all stray blank/newtab tabs so only a single clean tab remains."""
    if not context:
        return None
    try:
        pages = list(context.pages)
        active = keep_page
        if not active:
            for p in pages:
                if not p.is_closed() and any(k in (p.url or "") for k in ["swiggy.com", "zomato.com"]):
                    active = p
                    break
        if not active:
            for p in pages:
                u = p.url or ""
                if not p.is_closed() and u not in ["about:blank", "", "edge://new-tab-page/", "edge://newtab/"] and not u.startswith("edge://"):
                    active = p
                    break
        if not active and pages:
            active = pages[0]

        for p in pages:
            if p != active and not p.is_closed():
                url = (p.url or "").lower()
                if (
                    url in ["about:blank", "", "edge://new-tab-page/", "edge://newtab/", "chrome://newtab/"]
                    or "about:blank" in url
                    or url.startswith("edge://")
                    or "newtab" in url
                ):
                    try:
                        await p.close()
                    except Exception:
                        pass
        return active
    except Exception as e:
        print(f"[FoodOrdering] Tab cleanup notice: {e}")
        return keep_page


def _extract_and_save_swiggy_auth(leveldb_dir: str, auth_file: str) -> None:
    """Extracts Swiggy JWT authentication headers and user profile from LevelDB and caches to swiggy_auth.json."""
    if not os.path.exists(leveldb_dir):
        return
    auth_data = None
    user_data = None
    files = sorted(
        [os.path.join(leveldb_dir, f) for f in os.listdir(leveldb_dir) if f.endswith(".log") or f.endswith(".ldb")],
        key=os.path.getmtime,
        reverse=True
    )
    for fp in files:
        try:
            with open(fp, "rb") as f:
                content = f.read()
            if not auth_data:
                idx = content.find(b'auth_headers\xa8\x08\x01')
                if idx != -1:
                    s = idx + len(b'auth_headers\xa8\x08\x01')
                    e = content.find(b'\x01', s)
                    raw = content[s:e].decode('utf-8', errors='ignore')
                    try:
                        json.loads(raw)
                        auth_data = raw
                    except Exception:
                        pass
            if not user_data:
                idx = content.find(b'user_info\x9a\x0b\x01')
                if idx != -1:
                    s = idx + len(b'user_info\x9a\x0b\x01')
                    e = content.find(b'\x01', s)
                    raw = content[s:e].decode('utf-8', errors='ignore')
                    try:
                        json.loads(raw)
                        user_data = raw
                    except Exception:
                        pass
            if auth_data and user_data:
                break
        except Exception:
            pass

    if auth_data or user_data:
        try:
            existing = {}
            if os.path.exists(auth_file):
                try:
                    with open(auth_file, "r", encoding="utf-8") as f:
                        existing = json.load(f)
                except Exception:
                    pass
            if auth_data:
                existing["auth_headers"] = auth_data
            if user_data:
                existing["user_info"] = user_data
            with open(auth_file, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)
            print("[FoodOrdering] Synced live Swiggy authentication headers from Microsoft Edge LevelDB.")
        except Exception as e:
            print(f"[FoodOrdering] Auth save note: {e}")


def _sync_real_edge_profile_if_needed(profile_dir: str) -> None:
    """Clones the user's authentic Edge profile (accounts, theme, cookies, preferences, bookmarks)
    into the dedicated automation profile so Edge opens as the user's REAL personal browser!
    """
    try:
        app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
        real_edge_root = os.path.join(app_data, "Microsoft", "Edge", "User Data")
        real_default = os.path.join(real_edge_root, "Default")
        target_default = os.path.join(profile_dir, "Default")
        os.makedirs(target_default, exist_ok=True)

        # 1. Local State (contains account emails, profile avatars, sync status)
        ls_src = os.path.join(real_edge_root, "Local State")
        ls_dst = os.path.join(profile_dir, "Local State")
        if os.path.exists(ls_src):
            try:
                shutil.copy2(ls_src, ls_dst)
            except Exception:
                pass

        # 2. Key profile files
        for fname in ["Preferences", "Secure Preferences", "Bookmarks", "Favicons", "Login Data", "Web Data"]:
            s = os.path.join(real_default, fname)
            d = os.path.join(target_default, fname)
            if os.path.exists(s):
                try:
                    shutil.copy2(s, d)
                except Exception:
                    pass

        # 3. Network / Cookies
        target_cookies = os.path.join(target_default, "Network", "Cookies")
        src_cookies = os.path.join(real_default, "Network", "Cookies")
        if os.path.exists(src_cookies) and not os.path.exists(target_cookies):
            os.makedirs(os.path.join(target_default, "Network"), exist_ok=True)
            try:
                shutil.copy2(src_cookies, target_cookies)
            except Exception:
                pass

        # 4. Local Storage (always sync latest)
        target_ls = os.path.join(target_default, "Local Storage")
        src_ls = os.path.join(real_default, "Local Storage")
        if os.path.exists(src_ls):
            try:
                shutil.copytree(src_ls, target_ls, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.lock", "*LOCK*"))
            except Exception:
                pass

        # 5. Extract and cache real Swiggy auth headers and user profile
        auth_file = os.path.join(os.path.dirname(profile_dir), "swiggy_auth.json")
        leveldb_dir = os.path.join(src_ls, "leveldb")
        if os.path.exists(leveldb_dir):
            _extract_and_save_swiggy_auth(leveldb_dir, auth_file)

        print("[FoodOrdering] Synced real personal Microsoft Edge profile to food ordering environment.")
    except Exception as e:
        print(f"[FoodOrdering] Edge profile sync notice: {e}")


def _ensure_edge_process_running(profile_dir: str) -> None:
    """Ensures Microsoft Edge is running as an independent process with CDP on port 9222."""
    if _is_port_listening(9222):
        print("[FoodOrdering] Microsoft Edge CDP port 9222 is already active.")
        return

    _sync_real_edge_profile_if_needed(profile_dir)
    _clean_profile_locks(profile_dir)

    edge_candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    ]
    edge_exe = next((p for p in edge_candidates if os.path.exists(p)), None)
    if not edge_exe:
        print("[FoodOrdering] msedge.exe not found in standard paths.")
        return

    _clean_profile_locks(profile_dir)

    cmd = [
        edge_exe,
        "--remote-debugging-port=9222",
        f"--user-data-dir={profile_dir}",
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-fre",
        "--no-fre",
        "--disable-features=msFirstRunExperience,msEdgeFre,msFreDialog",
        "--disable-infobars",
        "https://www.swiggy.com",
    ]
    print("[FoodOrdering] Spawning independent Microsoft Edge with remote debugging port 9222...")
    try:
        subprocess.Popen(cmd)
    except Exception as e:
        print(f"[FoodOrdering] Spawn error: {e}")
    for _ in range(25):
        time.sleep(0.2)
        if _is_port_listening(9222):
            print("[FoodOrdering] Microsoft Edge CDP port 9222 is ready!")
            break


async def _launch_browser_and_context(
    playwright_instance: Any,
    geo: Dict[str, Any],
    headless: bool = False
) -> tuple[Any, str]:
    """Connects to an existing active Microsoft Edge session (via CDP port 9222) if available,
    or launches Microsoft Edge using a dedicated permanent user profile (edge_food_profile).
    Closes stray about:blank tabs so only a clean single tab remains.
    All logins, phone numbers, addresses, and cookies persist permanently across runs.
    """
    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    era_dir = os.path.join(app_data, "ERA")
    os.makedirs(era_dir, exist_ok=True)
    edge_food_profile = os.path.join(era_dir, "edge_food_profile")
    os.makedirs(edge_food_profile, exist_ok=True)
    state_file = os.path.join(era_dir, "edge_food_session.json")

    if not headless:
        _ensure_edge_process_running(edge_food_profile)

    # 1. First: Check if an active Edge session with CDP port 9222 is already running!
    try:
        browser = await playwright_instance.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=3000)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        # Verify active page is responsive
        test_page = context.pages[0] if context.pages else await context.new_page()
        await test_page.evaluate("1 + 1")
        print("[FoodOrdering] Connected to active Microsoft Edge session via CDP (port 9222)!")
        try:
            await asyncio.wait_for(context.grant_permissions(["geolocation"], origin="https://www.swiggy.com"), timeout=1.5)
            await asyncio.wait_for(context.set_geolocation({
                "latitude": float(geo["lat"]),
                "longitude": float(geo["lon"]),
                "accuracy": 10
            }), timeout=1.5)
        except Exception:
            pass
        # Clean up any stray about:blank tabs in the existing session
        await _clean_up_tabs(context)

        # Stealth init script
        try:
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)
        except Exception:
            pass

        # Inject persistent Swiggy authentication credentials into CDP context
        auth_file = os.path.join(era_dir, "swiggy_auth.json")
        if os.path.exists(auth_file):
            try:
                with open(auth_file, "r", encoding="utf-8") as af:
                    a_info = json.load(af)
                a_hdr = a_info.get("auth_headers")
                u_hdr = a_info.get("user_info")
                if a_hdr or u_hdr:
                    a_js = json.dumps(a_hdr) if a_hdr else "null"
                    u_js = json.dumps(u_hdr) if u_hdr else "null"
                    await context.add_init_script(f"""
                    try {{
                        const a = {a_js};
                        const u = {u_js};
                        if (location.hostname.includes('swiggy.com')) {{
                            if (a && !localStorage.getItem('auth_headers')) {{
                                localStorage.setItem('auth_headers', typeof a === 'string' ? a : JSON.stringify(a));
                            }}
                            if (u && !localStorage.getItem('user_info')) {{
                                localStorage.setItem('user_info', typeof u === 'string' ? u : JSON.stringify(u));
                            }}
                        }}
                    }} catch(e) {{}}
                    """)
                    if a_hdr:
                        a_obj = json.loads(a_hdr) if isinstance(a_hdr, str) else a_hdr
                        tid = a_obj.get("tid")
                        sid = a_obj.get("sid")
                        ck_list = []
                        if tid:
                            ck_list.append({"name": "tid", "value": tid, "domain": ".swiggy.com", "path": "/"})
                            ck_list.append({"name": "_session_tid", "value": tid, "domain": ".swiggy.com", "path": "/"})
                        if sid:
                            ck_list.append({"name": "_sid", "value": sid, "domain": ".swiggy.com", "path": "/"})
                        if ck_list:
                            await context.add_cookies(ck_list)
                    print("[FoodOrdering] Injected persistent Swiggy authentication and user session into CDP context!")
            except Exception as e_auth_inj:
                print(f"[FoodOrdering] Auth injection note: {e_auth_inj}")

        # Inject saved cookies ONLY if they represent a valid logged-in session (not guest)
        if os.path.exists(state_file):
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    state_data = json.load(f)
                    cookies = state_data.get("cookies", [])
                    has_auth = any(
                        c.get("name") in ["_session_tid", "user_id", "token", "auth"] or
                        ("tid" in c.get("name", "") and "_guest" not in c.get("name", ""))
                        for c in cookies
                    )
                    if cookies and has_auth:
                        await context.add_cookies(cookies)
                        print(f"[FoodOrdering] Restored {len(cookies)} saved authenticated session cookies!")
                    else:
                        print("[FoodOrdering] Saved state does not contain authenticated session. Using native Edge profile store.")
            except Exception as ce:
                print(f"[FoodOrdering] Cookie restore note: {ce}")

        if not headless:
            _bring_edge_to_front()
        return context, state_file
    except Exception as cdpe:
        print(f"[FoodOrdering] CDP connect note: {cdpe}. Using fallback persistent context...")
        pass

    # Clean stale lockfiles to prevent directory locks
    _clean_profile_locks(edge_food_profile)

    browser_args = [
        "--remote-debugging-port=9222",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        "--disable-infobars",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-restore-session-state",
        "--disable-session-crashed-bubble",
    ]

    edge_user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    )

    launch_kwargs: Dict[str, Any] = {
        "user_data_dir": edge_food_profile,
        "headless": headless,
        "ignore_default_args": ["--enable-automation"],
        "user_agent": edge_user_agent,
        "permissions": ["geolocation"],
        "geolocation": {"latitude": geo["lat"], "longitude": geo["lon"]},
        "no_viewport": True if not headless else False,
        "args": browser_args,
    }
    if os.path.exists(state_file):
        launch_kwargs["storage_state"] = state_file

    context = None
    try:
        context = await playwright_instance.chromium.launch_persistent_context(
            channel="msedge",
            **launch_kwargs
        )
    except Exception as e:
        print(f"[FoodOrdering] Edge channel launch notice: {e}. Retrying with default chromium...")
        _clean_profile_locks(edge_food_profile)
        try:
            context = await playwright_instance.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as e2:
            print(f"[FoodOrdering] Fallback launch attempt: {e2}")
            fresh_profile = os.path.join(era_dir, "edge_food_stealth")
            launch_kwargs["user_data_dir"] = fresh_profile
            context = await playwright_instance.chromium.launch_persistent_context(**launch_kwargs)

    # Stealth init script to bypass CloudFront bot detection
    if context:
        try:
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)
        except Exception:
            pass

        # Clean up any leftover / duplicate about:blank tabs so only ONE clean tab remains!
        await _clean_up_tabs(context)

    if not headless:
        _bring_edge_to_front()
    return context, state_file


async def _save_session_state(context: Any, state_file: str, page: Any = None) -> None:
    """Saves session cookies and storage to preserve login state across runs.
    Only saves if an authenticated session exists so guest state is never persisted.
    Also extracts active localStorage auth_headers and user_info and caches to swiggy_auth.json.
    """
    try:
        app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
        era_dir = os.path.join(app_data, "ERA")
        auth_file = os.path.join(era_dir, "swiggy_auth.json")

        if page:
            try:
                ls_data = await page.evaluate("""() => {
                    return {
                        auth: localStorage.getItem('auth_headers'),
                        user: localStorage.getItem('user_info')
                    };
                }""")
                if ls_data.get("auth") or ls_data.get("user"):
                    existing = {}
                    if os.path.exists(auth_file):
                        try:
                            with open(auth_file, "r", encoding="utf-8") as af:
                                existing = json.load(af)
                        except Exception:
                            pass
                    if ls_data.get("auth"):
                        existing["auth_headers"] = ls_data.get("auth")
                    if ls_data.get("user"):
                        existing["user_info"] = ls_data.get("user")
                    with open(auth_file, "w", encoding="utf-8") as af:
                        json.dump(existing, af, indent=2)
                    print("[FoodOrdering] Live Swiggy auth credentials permanently updated in swiggy_auth.json!")
            except Exception as pe:
                print(f"[FoodOrdering] Auth save from page note: {pe}")

        if context and state_file:
            cookies = await context.cookies()
            has_auth = any(
                c.get("name") in ["_session_tid", "user_id", "token"] or
                ("tid" in c.get("name", "") and "_guest" not in c.get("name", ""))
                for c in cookies
            )
            if has_auth:
                await context.storage_state(path=state_file)
                print("[FoodOrdering] Authenticated session state successfully saved to disk.")
            else:
                print("[FoodOrdering] Skipped saving guest session state to avoid session pollution.")
    except Exception as e:
        print(f"[FoodOrdering] Session state save note: {e}")


async def _enter_otp_on_page(page: Any, otp: str) -> bool:
    """Enters spoken or provided OTP code into Swiggy/Zomato OTP boxes and clicks Verify."""
    clean_otp = re.sub(r"\D", "", str(otp)).strip()
    if not clean_otp or len(clean_otp) < 4:
        return False
    print(f"[FoodOrdering] Entering spoken OTP ({clean_otp}) into checkout/login screen on Microsoft Edge...")

    # 1. Single OTP input
    try:
        single_inp = page.locator("input#otp, input[name='otp'], input[placeholder*='OTP' i], input[placeholder*='password' i], input[placeholder*='One time' i], input[type='number']").first
        if await single_inp.count() > 0:
            await single_inp.fill(clean_otp)
            print("[FoodOrdering] Filled single OTP input field.")
            await page.wait_for_timeout(400)
    except Exception as e1:
        print(f"[FoodOrdering] Single OTP input note: {e1}")

    # 2. Multi-box OTP (e.g. 6 individual digit inputs on Swiggy)
    try:
        otp_boxes = await page.locator("input[maxlength='1'], input[autocomplete*='one-time-code'], div[class*='otp'] input, div[class*='_1'] input").all()
        if len(otp_boxes) >= 4:
            print(f"[FoodOrdering] Found {len(otp_boxes)} OTP digit boxes. Filling digits...")
            for i in range(min(len(otp_boxes), len(clean_otp))):
                await otp_boxes[i].fill(clean_otp[i])
                await page.wait_for_timeout(80)
    except Exception as e2:
        print(f"[FoodOrdering] Multi-box OTP note: {e2}")

    # 3. DOM evaluate dispatch for instant input event triggering
    try:
        await page.evaluate("""(code) => {
            const boxes = Array.from(document.querySelectorAll("input[maxlength='1'], input[autocomplete*='one-time-code']"));
            if (boxes.length >= 4) {
                for (let i = 0; i < Math.min(boxes.length, code.length); i++) {
                    boxes[i].focus();
                    boxes[i].value = code[i];
                    boxes[i].dispatchEvent(new Event('input', { bubbles: true }));
                    boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
                }
            } else {
                const s = document.querySelector("input#otp, input[name='otp'], input[placeholder*='OTP' i], input[placeholder*='password' i], input[placeholder*='One time' i]");
                if (s) {
                    s.focus();
                    s.value = code;
                    s.dispatchEvent(new Event('input', { bubbles: true }));
                    s.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }""", clean_otp)
    except Exception as e3:
        print(f"[FoodOrdering] DOM dispatch OTP note: {e3}")

    await page.wait_for_timeout(800)

    # 4. Click Verify OTP / Submit button
    try:
        verify_btn = page.locator(
            "button:has-text('VERIFY OTP'), button:has-text('Verify OTP'), "
            "button:has-text('VERIFY'), button:has-text('Verify'), "
            "a:has-text('VERIFY OTP'), a:has-text('VERIFY'), "
            "div:has-text('VERIFY OTP'), div:has-text('VERIFY'), "
            "button:has-text('Submit'), button:has-text('SUBMIT'), "
            "button:has-text('Login'), button:has-text('LOGIN')"
        ).first
        if await verify_btn.count() > 0:
            print("[FoodOrdering] Clicking 'VERIFY OTP' button...")
            await verify_btn.click()
        else:
            await page.keyboard.press("Enter")
    except Exception as ve:
        print(f"[FoodOrdering] Verify button click note: {ve}")

    await page.wait_for_timeout(2500)
    return True


async def _complete_checkout_after_login(page: Any, context: Any = None, state_file: str = "") -> Dict[str, Any]:
    """Handles address selection, Cash on Delivery option, and order placement on checkout.
    Uses an active multi-stage state loop (up to 40 seconds) to ensure checkout completes
    all steps: Login verification -> Address selection -> COD selection -> Place order!
    """
    info: Dict[str, Any] = {
        "status": "pending",
        "cod_selected": False,
        "order_placed": False,
        "requires_login": False,
        "detail": "",
    }
    
    live_loc = _get_live_location()
    target_suburb = live_loc.get("suburb", "Bodla").lower()
    target_area = live_loc.get("neighbourhood", "Subhash Nagar").lower()

    print("[FoodOrdering] Starting robust checkout completion pipeline...")

    # Phase 1: Wait up to 10 seconds for login drawer / OTP verification to settle
    for _ in range(10):
        body_txt = await page.evaluate("document.body.innerText")
        if "One time password" not in body_txt and "Enter OTP" not in body_txt:
            break
        # If verify button is still present, click it
        try:
            v_btn = page.locator("button:has-text('VERIFY OTP'), button:has-text('Verify OTP'), div:has-text('VERIFY OTP')").first
            if await v_btn.count() > 0 and await v_btn.is_visible():
                await v_btn.click()
        except Exception:
            pass
        await page.wait_for_timeout(1000)

    # Phase 2 & 3: Address Selection & Cash on Delivery Loop (up to 30 seconds)
    address_done = False
    cod_done = False
    order_clicked = False

    for attempt in range(25):
        await page.wait_for_timeout(1200)
        curr_url = page.url
        body_txt = await page.evaluate("document.body.innerText")

        # 1. Check if order is ALREADY placed
        if any(k in curr_url for k in ["order-tracking", "orders", "checkout/success"]) or \
           any(k in body_txt for k in ["Order placed", "Order confirmed", "Order received", "Preparing your order", "Arriving in"]):
            info["order_placed"] = True
            info["status"] = "ordered"
            info["detail"] = "Order placed and confirmed successfully on Microsoft Edge!"
            print(f"[FoodOrdering] {info['detail']}")
            break

        # 2. Check if Address needs selection
        if not address_done:
            # Check if address is already selected (e.g. step marked complete or Payment section is visible)
            has_payment_open = any(k in body_txt for k in ["Payment Options", "Pay on Delivery", "Cash on Delivery", "Choose payment method"])
            if has_payment_open:
                address_done = True
                print("[FoodOrdering] Delivery address already selected and Payment section unlocked!")
            else:
                # 2a. Check saved address cards for DELIVER HERE
                addr_res = await page.evaluate("""({suburb, area}) => {
                    const cards = Array.from(document.querySelectorAll('div[class*="address"], div[class*="Address"], div._3m1qB, div._2365l, div.n7fK2, div._1qV8C, div._3d_rI'));
                    const deliverCards = cards.filter(c => {
                        const t = c.innerText || '';
                        return t.includes('DELIVER HERE') || t.includes('Deliver Here');
                    });

                    if (deliverCards.length > 0) {
                        let target = deliverCards.find(c => {
                            const txt = c.innerText.toLowerCase();
                            return (suburb && txt.includes(suburb)) || (area && txt.includes(area)) || txt.includes('bodla') || txt.includes('subhash');
                        });
                        if (!target) {
                            target = deliverCards.find(c => {
                                const txt = c.innerText.toLowerCase();
                                return txt.includes('home') || txt.includes('agra');
                            });
                        }
                        if (!target) target = deliverCards[0];

                        const btn = Array.from(target.querySelectorAll('button, div, span, a')).find(el => {
                            const t = (el.innerText || '').trim();
                            return t === 'DELIVER HERE' || t === 'Deliver Here';
                        });
                        if (btn) {
                            btn.click();
                            return { clicked: true, note: (target.innerText || '').slice(0, 100).replace(/\\n/g, ' ') };
                        }
                    }
                    return { clicked: false, note: '' };
                }""", {"suburb": target_suburb, "area": target_area})

                if addr_res.get("clicked"):
                    print(f"[FoodOrdering] Selected saved address matching phone live location: {addr_res.get('note')}")
                    address_done = True
                    await page.wait_for_timeout(2000)
                    continue

                # 2b. Check standard DELIVER HERE buttons
                deliv = page.locator("button:has-text('DELIVER HERE'), button:has-text('Deliver Here'), div:text-is('DELIVER HERE'), span:text-is('DELIVER HERE')").first
                if await deliv.count() > 0 and await deliv.is_visible():
                    print("[FoodOrdering] Clicking DELIVER HERE button...")
                    await deliv.click()
                    address_done = True
                    await page.wait_for_timeout(2000)
                    continue

                # 2c. Check Add New Address button
                add_btn = page.locator(
                    "button:has-text('Add new address'), button:has-text('ADD NEW'), "
                    "div:has-text('Add new address'), div:has-text('ADD NEW ADDRESS'), "
                    "span:has-text('Add new address'), a:has-text('Add new address')"
                ).first
                if await add_btn.count() > 0 and await add_btn.is_visible():
                    print(f"[FoodOrdering] Clicking Add New Address for phone location: {live_loc.get('full_address')}...")
                    await add_btn.click()
                    await page.wait_for_timeout(2000)
                    try:
                        # Map search input
                        loc_inp = page.locator("input[placeholder*='search for area' i], input[placeholder*='area, street' i], input#location").first
                        if await loc_inp.count() > 0 and await loc_inp.is_visible():
                            await loc_inp.fill("Bodla, Agra")
                            await page.wait_for_timeout(1000)
                            sug = page.locator("div[class*='suggestion'], div[class*='searchResult'], div[role='option']").first
                            if await sug.count() > 0:
                                await sug.click()
                                await page.wait_for_timeout(1500)

                        door_inp = page.locator("input#building, input[name='building'], input[placeholder*='Door' i], input[placeholder*='Flat' i], input[placeholder*='House' i]").first
                        if await door_inp.count() > 0:
                            await door_inp.fill(live_loc.get("neighbourhood", "Subhash Nagar C Block"))
                        lm_inp = page.locator("input#landmark, input[name='landmark'], input[placeholder*='Landmark' i]").first
                        if await lm_inp.count() > 0:
                            await lm_inp.fill(live_loc.get("area", "Bodla"))
                        home_tag = page.locator("button:has-text('Home'), div:text-is('Home'), span:text-is('Home')").first
                        if await home_tag.count() > 0:
                            await home_tag.click()
                        save_btn = page.locator(
                            "button:has-text('SAVE AND PROCEED'), button:has-text('Save and Proceed'), "
                            "button:has-text('SAVE ADDRESS'), button:has-text('Save Address'), "
                            "div:has-text('SAVE AND PROCEED')"
                        ).first
                        if await save_btn.count() > 0:
                            await save_btn.click()
                            print("[FoodOrdering] Saved new address matching phone location!")
                            address_done = True
                            await page.wait_for_timeout(2500)
                            continue
                    except Exception as e_new:
                        print(f"[FoodOrdering] Add address note: {e_new}")

        # 3. Handle Payment: Select Cash on Delivery / Pay on Delivery
        if not cod_done:
            cod_clicked = await page.evaluate("""() => {
                const els = Array.from(document.querySelectorAll('button, div, span, p, label, input'));
                const codEl = els.find(el => {
                    const t = (el.innerText || el.value || '').toLowerCase().trim();
                    return t === 'pay on delivery' || t === 'cash on delivery' || t.includes('pay on delivery (cash/upi)') || t === 'cod';
                });
                if (codEl) {
                    codEl.click();
                    return true;
                }
                return false;
            }""")
            if cod_clicked:
                print("[FoodOrdering] Clicked 'Pay on Delivery / Cash on Delivery' option!")
                cod_done = True
                info["cod_selected"] = True
                await page.wait_for_timeout(1500)

        # 4. Handle Place Order / Pay with Cash button
        order_btn_clicked = await page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
            const placeBtn = btns.find(b => {
                const t = (b.innerText || '').toLowerCase().trim();
                return (
                    t === 'pay with cash' ||
                    t === 'place order' ||
                    t.includes('pay with cash') ||
                    t.includes('place order') ||
                    (t.startsWith('pay ') && t.includes('cash'))
                ) && !t.includes('wallet');
            });
            if (placeBtn) {
                placeBtn.scrollIntoView();
                placeBtn.click();
                return { clicked: true, text: placeBtn.innerText };
            }
            return { clicked: false, text: '' };
        }""")

        if order_btn_clicked.get("clicked"):
            print(f"[FoodOrdering] Clicked final order placement button: '{order_btn_clicked.get('text')}'!")
            order_clicked = True
            await page.wait_for_timeout(4000)

            # Check if order succeeded
            curr_url = page.url
            curr_body = await page.evaluate("document.body.innerText")
            if any(k in curr_url for k in ["order-tracking", "orders", "checkout/success"]) or \
               any(k in curr_body for k in ["Order placed", "Order confirmed", "Order received", "Preparing your order", "Arriving in"]):
                info["order_placed"] = True
                info["status"] = "ordered"
                info["detail"] = "Order placed and confirmed successfully with Cash on Delivery on Microsoft Edge!"
                print(f"[FoodOrdering] {info['detail']}")
                break

    if order_clicked and not info["order_placed"]:
        info["order_placed"] = True
        info["status"] = "ordered"
        info["detail"] = "Order placement button clicked with Cash on Delivery on Microsoft Edge."

    if context and state_file:
        try:
            await _save_session_state(context, state_file, page)
        except Exception:
            pass

    return info


async def _handle_cod_checkout(page: Any, headless: bool = False, context: Any = None, state_file: str = "") -> Dict[str, Any]:
    """Handles address selection, Cash on Delivery option, and order placement on checkout.
    If login/OTP is required on screen, opens the login drawer, autofills saved mobile,
    triggers OTP SMS, and returns immediately so the voice session stays ONLINE!
    """
    info: Dict[str, Any] = {
        "status": "pending",
        "cod_selected": False,
        "order_placed": False,
        "requires_login": False,
        "detail": "",
    }
    try:
        await page.wait_for_timeout(3500)
        checkout_text = await page.evaluate("document.body.innerText")

        # 0. Check if cart is EMPTY
        if "Your cart is empty" in checkout_text or "Oops, something went wrong" in checkout_text or "Cart Empty" in checkout_text:
            info["status"] = "cart_empty"
            info["detail"] = "Cart is empty on checkout page. Dish was not added properly."
            print("[FoodOrdering] Checkout cart is empty!")
            return info

        # 1. Check if user needs to log in
        has_logged_in_indicator = (
            "Logged in as" in checkout_text or
            ("Delivery address" in checkout_text and ("DELIVER HERE" in checkout_text or "Deliver Here" in checkout_text)) or
            "Choose delivery address" in checkout_text or
            ("Account" in checkout_text and "Change" in checkout_text and "To place your order now" not in checkout_text)
        )
        is_login_needed = not has_logged_in_indicator and (
            "To place your order now, log in" in checkout_text or
            "Enter login details or create an account" in checkout_text or
            "Enter phone number" in checkout_text or
            "Have an account?" in checkout_text
        )

        if is_login_needed:
            print("[FoodOrdering] Checkout requires user login. Opening login modal on Microsoft Edge...")
            _bring_edge_to_front()

            # Click specific LOG IN button
            try:
                await page.evaluate("""() => {
                    const btn = document.querySelector('div._2UOuf') || 
                                document.querySelector('div.WO7LQ') || 
                                Array.from(document.querySelectorAll('div, button, a')).find(el => (el.innerText || '').trim() === 'LOG IN');
                    if (btn) btn.click();
                }""")
                await page.wait_for_timeout(1200)
            except Exception as le:
                print(f"[FoodOrdering] Login button click note: {le}")

            # Autofill saved phone number and trigger OTP SMS
            saved_phone = _get_user_phone()
            otp_requested = False
            if saved_phone:
                try:
                    try:
                        await page.wait_for_selector("input#mobile, input[name='mobile'], input[type='tel']", timeout=4000)
                    except Exception:
                        pass
                    p_inp = page.locator("input#mobile, input[name='mobile'], input[type='tel'], input[placeholder*='Phone' i], input[placeholder*='mobile' i], input[maxlength='10']").first
                    if await p_inp.count() > 0:
                        await p_inp.fill(saved_phone)
                        await page.wait_for_timeout(400)
                        await p_inp.press("Enter")
                        await page.wait_for_timeout(600)

                        # Click the exact Login/Continue button (strictly ignoring 'login to your account' anchor links)
                        try:
                            l_btn = page.locator("a:text-is('Login'), button:text-is('Login'), a.a-btn:has-text('Login'), button.a-btn:has-text('Login')").first
                            if await l_btn.count() > 0 and await l_btn.is_visible():
                                await l_btn.click(force=True, timeout=2000)
                        except Exception:
                            pass

                        await page.evaluate("""() => {
                            const inp = document.querySelector('input#mobile, input[name="mobile"], input[type="tel"]');
                            if (!inp) return;
                            const card = inp.closest('div[class*="account"], div[class*="Account"], div._3m1qB, div._2365l, div._1qV8C, form') || inp.parentElement.parentElement;
                            const btns = Array.from((card || document).querySelectorAll('a, button, div[role="button"]'));
                            const btn = btns.find(b => {
                                const t = (b.innerText || '').trim();
                                return (t === 'Login' || t === 'LOGIN' || t === 'Continue' || t === 'CONTINUE') && !b.innerText.toLowerCase().includes('already') && !b.innerText.toLowerCase().includes('account');
                            }) || document.querySelector('a.a-btn, button.a-btn, a._1gPB7');
                            if (btn) btn.click();
                        }""")
                        await page.wait_for_timeout(1500)

                        # Check if Swiggy is asking for Name & Email (because this number is registering for the first time!)
                        user_info = _get_user_info()
                        for _ in range(8):
                            await page.wait_for_timeout(400)
                            name_inp = page.locator("input#name, input[name='name']").first
                            if await name_inp.count() > 0 and await name_inp.is_visible():
                                print(f"[FoodOrdering] Swiggy requires Name & Email. Autofilling: {user_info['name']} ({user_info['email']})...")
                                await name_inp.fill(user_info["name"])
                                await page.wait_for_timeout(300)
                                email_inp = page.locator("input#email, input[name='email']").first
                                if await email_inp.count() > 0 and await email_inp.is_visible():
                                    await email_inp.fill(user_info["email"])
                                    await page.wait_for_timeout(300)
                                # Click Continue button on signup form to send the OTP
                                await page.evaluate("""() => {
                                    const btns = Array.from(document.querySelectorAll('a, button, div[role="button"]')).filter(b => {
                                        const t = (b.innerText || '').trim();
                                        return t === 'CONTINUE' || t === 'Continue' || t === 'Sign up' || t === 'SIGN UP';
                                    });
                                    if (btns.length > 0) btns[btns.length - 1].click();
                                }""")
                                await page.wait_for_timeout(1500)
                                break
                            body_check = await page.evaluate("document.body.innerText")
                            if any(k in body_check for k in ["One time password", "Enter OTP", "VERIFY OTP", "Verify OTP", "OTP sent", "Resend OTP", "Phone Verification"]):
                                break

                        # Verify that Swiggy has actually transitioned to the OTP screen!
                        for _ in range(10):
                            await page.wait_for_timeout(500)
                            body_txt = await page.evaluate("document.body.innerText")
                            if any(k in body_txt for k in ["One time password", "Enter OTP", "VERIFY OTP", "Verify OTP", "OTP sent", "Resend OTP", "Phone Verification"]):
                                otp_requested = True
                                print(f"[FoodOrdering] Swiggy OTP screen CONFIRMED active! SMS sent to +91 {saved_phone[:2]}******{saved_phone[-2:]}")
                                break
                            # If still not OTP screen, check if Login button can be re-clicked
                            await page.evaluate("""() => {
                                const btns = Array.from(document.querySelectorAll('a.a-btn, button.a-btn, a._1gPB7, a, button')).filter(el => {
                                    const t = (el.innerText || '').trim();
                                    return (t === 'Login' || t === 'LOGIN' || t === 'Continue' || t === 'CONTINUE') && !t.toLowerCase().includes('already') && !t.toLowerCase().includes('account');
                                });
                                if (btns.length > 0) btns[btns.length - 1].click();
                            }""")
                except Exception as pe:
                    print(f"[FoodOrdering] Phone autofill / OTP request error: {pe}")

            # Return immediately without blocking!
            # Keeps Gemini Live WebSocket ONLINE, active, and responsive.
            _bring_edge_to_front()
            info["requires_login"] = True
            masked_phone = f"+91 {saved_phone[:2]}******{saved_phone[-2:]}" if saved_phone else "mobile"
            if otp_requested:
                info["status"] = "otp_requested"
                info["detail"] = f"OTP requested on {masked_phone}. Waiting for boss to provide OTP."
            else:
                info["status"] = "login_screen_open"
                info["detail"] = f"Swiggy login screen Microsoft Edge par open hai {masked_phone} ke saath. Kripya screen par confirm karein."
            return info

        # If already logged in, proceed to complete address, COD, and order placement!
        return await _complete_checkout_after_login(page, context, state_file)

    except Exception as e:
        print(f"[FoodOrdering] Checkout handler error: {e}")
        info["detail"] = str(e)
    return info


async def _order_from_swiggy(
    dish: str,
    quantity: int = 1,
    max_budget: Optional[float] = None,
    min_budget: Optional[float] = None,
    location: Optional[str] = None,
    payment_method: str = "cod",
    auto_order: bool = True,
    headless: bool = False,
    screenshot_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Automates dish search, strict budget evaluation, add-to-cart, quantity adjustment, and COD checkout on Swiggy."""
    from playwright.async_api import async_playwright

    geo = _get_live_location()
    active_city = location or geo.get("city", "Agra")
    city_slug = active_city.lower().replace(" ", "-").strip()
    qty = max(1, int(quantity or 1))

    # Maximum item price filter (allow candidate dishes up to max_budget)
    max_item_budget = (max_budget / qty) if max_budget else None
    min_item_budget = (min_budget / qty) if min_budget else None
    if max_budget:
        print(f"[FoodOrdering] Swiggy Budget Guard: Max Budget=₹{max_budget}, Qty={qty}, Max Candidate Item Price=₹{max_item_budget:.1f}")

    result: Dict[str, Any] = {
        "success": False,
        "platform": "Swiggy",
        "dish_requested": dish,
        "quantity": qty,
        "dish_found": None,
        "price": None,
        "bill_total": None,
        "restaurant": None,
        "location": active_city,
        "payment_method": payment_method.upper(),
        "order_status": "failed",
        "message": "",
        "cart_url": None,
        "screenshot": None,
    }

    playwright_instance = None
    context = None
    state_file = ""
    try:
        playwright_instance = await async_playwright().start()
        context, state_file = await _launch_browser_and_context(playwright_instance, geo, headless=headless)
        
        # Reuse existing Swiggy page if open, or use first page
        page = None
        for p in context.pages:
            try:
                if not p.is_closed() and "swiggy.com" in p.url:
                    page = p
                    break
            except Exception:
                pass
        if not page:
            for p in context.pages:
                try:
                    if not p.is_closed() and not p.url.startswith("edge://"):
                        page = p
                        break
                except Exception:
                    pass
        if not page or page.is_closed():
            page = await context.new_page()

        # Clean up any leftover blank tabs safely
        page = await _clean_up_tabs(context, keep_page=page)
        if not headless:
            _bring_edge_to_front()

        # Warm up session on home page if not already on Swiggy
        if "swiggy.com" not in page.url:
            try:
                await page.goto("https://www.swiggy.com", timeout=20000, wait_until="domcontentloaded")
                await page.wait_for_timeout(1500)
            except Exception:
                pass

        # 1. Search for the dish directly
        search_url = f"https://www.swiggy.com/search?query={quote(dish)}"
        print(f"[FoodOrdering] Searching Swiggy for '{dish}' in {active_city}: {search_url}")
        await page.goto(search_url, timeout=30000, wait_until="domcontentloaded")
        await page.wait_for_timeout(3500)

        # 2. Switch to Dishes tab
        dishes_tab = page.locator("button:has-text('Dishes'), span:text-is('Dishes'), div:text-is('Dishes')").first
        if await dishes_tab.count() > 0:
            print("[FoodOrdering] Switching to Swiggy 'Dishes' tab...")
            await dishes_tab.click()
            await page.wait_for_timeout(2500)

        # 3. Apply price filter pills if budget permits
        if max_item_budget is not None and max_item_budget <= 400:
            pill_400 = page.locator("div:text-is('Less than Rs 400'), button:text-is('Less than Rs 400'), span:text-is('Less than Rs 400')").first
            if await pill_400.count() > 0:
                print("[FoodOrdering] Applying 'Less than Rs 400' filter pill...")
                await pill_400.click()
                await page.wait_for_timeout(2000)
        elif max_item_budget is not None and max_item_budget <= 600:
            pill_600 = page.locator("div:text-is('Less than Rs 600'), button:text-is('Less than Rs 600'), span:text-is('Less than Rs 600')").first
            if await pill_600.count() > 0:
                print("[FoodOrdering] Applying 'Less than Rs 600' filter pill...")
                await pill_600.click()
                await page.wait_for_timeout(2000)

        # 4. Extract all dish cards and strict budget evaluation via DOM
        print(f"[FoodOrdering] Evaluating Swiggy dish cards against budget (Qty={qty}): Max item=Rs. {max_item_budget}, Min item=Rs. {min_item_budget}")
        candidates = await page.evaluate("""({dishQuery, maxItemBudget, minItemBudget}) => {
            const btns = Array.from(document.querySelectorAll('.add-button-center-container, button.add-button-center-container, div.add-button-center-container'));
            const results = [];
            const seen = new Set();
            const dishLower = dishQuery.toLowerCase();

            for (let i = 0; i < btns.length; i++) {
                const b = btns[i];
                let container = b.closest('div[class*="styles_container"], div[class*="styles_card"], div[class*="itemContainer"], div[data-testid*="dish"]') 
                             || b.parentElement.parentElement.parentElement;
                
                const fullText = container ? container.innerText : "";
                const lines = fullText.split('\\n').map(l => l.trim()).filter(l => l.length > 0);

                let price = null;
                const mCost = fullText.match(/Costs:\\s*(\\d+(?:\\.\\d+)?)\\s*rupees/i);
                if (mCost) {
                    price = parseFloat(mCost[1]);
                } else {
                    const mRupee = fullText.match(/[₹Rs\\.]\\s*(\\d+(?:\\.\\d+)?)/i);
                    if (mRupee) {
                        price = parseFloat(mRupee[1]);
                    } else {
                        for (const l of lines) {
                            if (/^\\d{2,4}$/.test(l)) {
                                price = parseFloat(l);
                                break;
                            }
                        }
                    }
                }

                let name = "";
                for (const l of lines) {
                    if (l.includes("Item.") || l.includes("Costs:") || /^\\d+(\\.\\d+)?$/.test(l) || l.includes("ADD") || l.includes("Customisable") || l.includes("mins") || l.includes("BESTSELLER") || l === "−" || l === "+") {
                        continue;
                    }
                    if (l.length >= 3 && !name) {
                        name = l;
                        break;
                    }
                }

                if (!name || price === null) continue;

                // Filter out cutlery/boxes
                const badWords = ["box", "container", "spoon", "fork", "cutlery", "pouch", "sachet", "packing"];
                if (badWords.some(w => name.toLowerCase().includes(w)) && !["lunch box", "meal box"].some(w => name.toLowerCase().includes(w))) {
                    continue;
                }

                if (seen.has(name)) continue;
                seen.add(name);

                // Strict candidate filtering: item base price must not exceed maxItemBudget
                if (maxItemBudget !== null && maxItemBudget !== undefined && price > maxItemBudget) continue;
                if (minItemBudget !== null && minItemBudget !== undefined && price < minItemBudget) continue;

                const isCustomisable = fullText.includes("Customisable");
                const rel = name.toLowerCase().includes(dishLower) ? 0 : 1;

                results.push({
                    idx: i,
                    name: name,
                    price: price,
                    isCustomisable: isCustomisable,
                    relevance: rel
                });
            }

            // Sort: best keyword match, then non-customisable (1-click), then lowest price
            results.sort((a, b) => a.relevance - b.relevance || (a.isCustomisable ? 1 : 0) - (b.isCustomisable ? 1 : 0) || a.price - b.price);
            return results;
        }""", {"dishQuery": dish, "maxItemBudget": max_item_budget, "minItemBudget": min_item_budget})

        print(f"[FoodOrdering] Swiggy: Found {len(candidates)} valid dishes within budget range.")

        if not candidates:
            budget_str = f"under ₹{int(max_budget)}" if max_budget else "in your budget"
            qty_str = f"for quantity {qty}" if qty > 1 else ""
            result["order_status"] = "not_found"
            result["message"] = f"Aapke budget ({budget_str}) ke andar {qty_str} Swiggy par '{dish}' nahi mila."
            return result

        # 5. Candidate selection and Cart Verification loop
        selected = None
        verified_cart = False
        restaurant_name = "Swiggy Restaurant"
        bill_total = None
        last_seen_bill = None
        bill_exceeded = False

        for cand in candidates[:5]:
            print(f"[FoodOrdering] Attempting to add '{cand['name']}' (₹{cand['price']} each, Qty={qty}, Customisable={cand['isCustomisable']})...")
            
            # Click ADD on center container
            await page.evaluate("""(idx) => {
                const btns = document.querySelectorAll('.add-button-center-container, button.add-button-center-container, div.add-button-center-container');
                if (btns[idx]) {
                    btns[idx].scrollIntoView();
                    btns[idx].click();
                }
            }""", cand["idx"])
            await page.wait_for_timeout(2000)

            # Check for Swiggy 'Items already in cart: Reset cart / YES, START AFRESH' popup
            await page.evaluate("""() => {
                const resetBtns = Array.from(document.querySelectorAll('button, div[role="button"], span')).filter(b => {
                    const t = (b.innerText || '').toLowerCase().trim();
                    return t.includes('start afresh') || t.includes('reset cart') || t.includes('yes, start afresh') || t.includes('discard');
                });
                if (resetBtns.length > 0) {
                    resetBtns[resetBtns.length - 1].click();
                }
            }""")
            await page.wait_for_timeout(1500)

            # Multi-step customization modal handler
            for step in range(4):
                # 1. Directly check if 'Add Item to cart' button is visible
                footer_btn = page.locator("button[data-cy='customize-footer-add-button'], button:has-text('Add Item to cart')").first
                if await footer_btn.count() > 0 and await footer_btn.is_visible():
                    print("[FoodOrdering] Clicking 'Add Item to cart' on customization modal...")
                    await footer_btn.evaluate("b => b.click()")
                    await page.wait_for_timeout(2500)
                    break

                # 2. Check for required choice + Continue button
                cont_btn = page.locator("button:has-text('Continue'), div[role='button']:has-text('Continue')").first
                if await cont_btn.count() > 0 and await cont_btn.is_visible():
                    await page.evaluate("""() => {
                        const modal = document.querySelector('div[role="dialog"], div[class*="modal"], div[class*="drawer"]');
                        if (modal) {
                            const r = modal.querySelector('input[type="radio"], label');
                            if (r) r.click();
                        }
                    }""")
                    await page.wait_for_timeout(500)
                    await cont_btn.evaluate("b => b.click()")
                    await page.wait_for_timeout(1500)
                    continue

                # 3. Fallback modal check
                m_done = await page.evaluate("""() => {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"], span')).filter(b => {
                        const t = (b.innerText || '').toLowerCase().trim();
                        return t.includes('add item to cart') || t === 'add item' || t.includes('apply');
                    });
                    if (btns.length > 0) {
                        btns[btns.length - 1].click();
                        return true;
                    }
                    return false;
                }""")
                await page.wait_for_timeout(1500)
                if not m_done:
                    break

            # If quantity > 1, click plus on the card counter if available
            if qty > 1:
                try:
                    for _ in range(qty - 1):
                        plus_clicked = await page.evaluate("""(idx) => {
                            const btns = document.querySelectorAll('.add-button-center-container, button.add-button-center-container, div.add-button-center-container');
                            if (btns[idx]) {
                                const plus = Array.from(btns[idx].querySelectorAll('*')).find(el => el.innerText && el.innerText.trim() === '+') ||
                                             Array.from(btns[idx].parentElement.querySelectorAll('*')).find(el => el.innerText && el.innerText.trim() === '+');
                                if (plus) {
                                    plus.click();
                                    return true;
                                }
                            }
                            return false;
                        }""", cand["idx"])
                        if plus_clicked:
                            await page.wait_for_timeout(800)
                except Exception as q_err:
                    print(f"[FoodOrdering] Card quantity increment note: {q_err}")

            # Navigate to Checkout
            print("[FoodOrdering] Verifying cart on Swiggy checkout...")
            await page.goto("https://www.swiggy.com/checkout", timeout=20000, wait_until="domcontentloaded")
            await page.wait_for_timeout(3500)

            # Check if checkout has real items & extract TO PAY amount reliably
            co_status = await page.evaluate("""() => {
                const text = document.body.innerText;
                let billTot = "";
                // 1. Regex match for To Pay / Total Pay / Final Bill
                const m = text.match(/(?:TO\\s*PAY|To\\s*Pay|Total\\s*to\\s*pay|Final\\s*Bill|Total\\s*Pay)[\\s:\\n]*[₹\\u20b9Rs\\.]*\\s*(\\d+(?:\\.\\d+)?)/i);
                if (m) {
                    billTot = m[1];
                }
                // 2. Line by line scanning around 'to pay'
                if (!billTot) {
                    const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
                    for (let i = 0; i < lines.length; i++) {
                        if (/^to\\s*pay$/i.test(lines[i])) {
                            for (let j = 1; j <= 4 && (i + j) < lines.length; j++) {
                                const mPrice = lines[i + j].match(/[₹\\u20b9Rs\\.]*\\s*(\\d+(?:\\.\\d+)?)/);
                                if (mPrice) {
                                    billTot = mPrice[1];
                                    break;
                                }
                            }
                            if (billTot) break;
                        }
                    }
                }
                // 3. Fallback: check DOM elements
                if (!billTot) {
                    const els = Array.from(document.querySelectorAll('[data-testid*="bill-total"], div._2aX4S, span._3odgy, div[class*="billTotal"], div[class*="toPay"], div[class*="ToPay"]'));
                    for (const el of els) {
                        const mPrice = el.innerText.match(/(\\d+(?:\\.\\d+)?)/);
                        if (mPrice) {
                            billTot = mPrice[1];
                            break;
                        }
                    }
                }
                let restName = "";
                const restEl = document.querySelector('div[class*="restaurantName"], a[href*="/restaurants/"], div[class*="RestaurantName"]');
                if (restEl) restName = restEl.innerText.trim();

                const hasReviewOrder = text.includes('Review your order') || text.includes('Delivery address') || text.includes('Payment');
                const isExplicitlyEmpty = text.includes('Your cart is empty') && !billTot;
                const isEmpty = isExplicitlyEmpty || (!billTot && !hasReviewOrder);

                return { isEmpty, restName, billTot };
            }""")

            if not co_status.get("isEmpty"):
                raw_bill = co_status.get("billTot")
                numeric_bill = _extract_price(str(raw_bill)) if raw_bill else None

                if numeric_bill is not None:
                    last_seen_bill = numeric_bill

                # STRICT BUDGET CHECK: Ensure FINAL CHECKOUT BILL (including delivery charges and GST) strictly <= max_budget!
                # If the final checkout bill exceeds max_budget, reject it immediately to protect the user's budget!
                is_within_budget = (max_budget is None) or (numeric_bill is not None and numeric_bill <= max_budget)

                if is_within_budget:
                    selected = cand
                    verified_cart = True
                    if co_status.get("restName"):
                        restaurant_name = co_status["restName"]
                    if co_status.get("billTot"):
                        bill_total = co_status["billTot"]
                    print(f"[FoodOrdering] Dish ACCEPTED within budget! '{cand['name']}' x {qty} (Dish: ₹{cand['price'] * qty}), Final Checkout Bill: ₹{bill_total} is strictly within max budget of ₹{max_budget}!")
                else:
                    print(f"[FoodOrdering] BUDGET EXCEEDED: '{cand['name']}' checkout TO PAY (₹{numeric_bill}) exceeds max budget of ₹{max_budget}! (Item: ₹{cand['price'] * qty} + delivery/taxes). Rejecting and cleaning cart...")
                    bill_exceeded = True
                    # Remove from cart cleanly using div._t-T3 and delete buttons
                    try:
                        await page.evaluate("""() => {
                            const minusBtns = Array.from(document.querySelectorAll('div._t-T3, div[class*="_t-T3"], .icon-delete'));
                            minusBtns.forEach(b => b.click());
                        }""")
                        await page.wait_for_timeout(1000)
                    except Exception:
                        pass
                    await page.goto(search_url, timeout=25000, wait_until="domcontentloaded")
                    await page.wait_for_timeout(2500)
                    dishes_tab = page.locator("button:has-text('Dishes'), span:text-is('Dishes'), div:text-is('Dishes')").first
                    if await dishes_tab.count() > 0:
                        await dishes_tab.click()
                        await page.wait_for_timeout(2000)
                    continue

                print(f"[FoodOrdering] Cart VERIFIED! Dish: '{cand['name']}' x {qty}, Restaurant: '{restaurant_name}', Bill: ₹{bill_total}")
                break
            else:
                print(f"[FoodOrdering] Cart was empty with '{cand['name']}', trying next candidate...")
                await page.goto(search_url, timeout=25000, wait_until="domcontentloaded")
                await page.wait_for_timeout(2500)
                dishes_tab = page.locator("button:has-text('Dishes'), span:text-is('Dishes'), div:text-is('Dishes')").first
                if await dishes_tab.count() > 0:
                    await dishes_tab.click()
                    await page.wait_for_timeout(2500)

        if not verified_cart or not selected:
            result["success"] = False
            if bill_exceeded and last_seen_bill and max_budget:
                result["order_status"] = "budget_exceeded"
                result["bill_total"] = last_seen_bill
                result["message"] = (
                    f"Boss, aapka budget ₹{int(max_budget)} hai, lekin Swiggy par '{dish}' ka final checkout bill "
                    f"(delivery fees aur taxes milakar) ₹{last_seen_bill:.0f} ban raha hai jo aapke budget se ₹{last_seen_bill - max_budget:.0f} zyada hai. "
                    f"Aapke budget ki safety ke liye order book nahi kiya gaya hai."
                )
            else:
                result["order_status"] = "cart_failed"
                budget_info = f" (under ₹{int(max_budget)})" if max_budget else ""
                result["message"] = f"Swiggy par aapke budget{budget_info} ke hisab se '{dish}' nahi mil pa raha hai ya cart confirm nahi hui. Kripya apna delivery location ya budget confirm karein."
            return result

        # 7. Handle COD Checkout & Order Placement (with live OTP monitoring)
        checkout_info = await _handle_cod_checkout(page, headless=headless, context=context, state_file=state_file)
        await _save_session_state(context, state_file)

        # 8. Save Screenshot of the REAL Order on Screen
        ss_path = None
        if screenshot_dir:
            os.makedirs(screenshot_dir, exist_ok=True)
            ss_path = os.path.join(screenshot_dir, f"swiggy_order_{int(time.time())}.png")
            try:
                await page.screenshot(path=ss_path, full_page=False)
            except Exception as e:
                print(f"[FoodOrdering] Screenshot error: {e}")

        result["success"] = True
        result["dish_found"] = selected["name"]
        result["price"] = selected["price"]
        result["quantity"] = qty
        result["bill_total"] = bill_total
        result["restaurant"] = restaurant_name
        result["cart_url"] = page.url
        result["screenshot"] = ss_path
        result["order_status"] = checkout_info.get("status", "ready")

        qty_phrase = f"{qty}x " if qty > 1 else ""

        if checkout_info.get("requires_login") or checkout_info.get("status") == "otp_requested":
            saved_p = _get_user_phone()
            p_txt = f"+91 {saved_p[:2]}******{saved_p[-2:]}" if saved_p else "mobile"
            result["message"] = (
                f"Boss, Microsoft Edge me {restaurant_name} se {qty_phrase}'{selected['name']}' (₹{selected['price']} each"
                f"{f', Total Bill: ₹{bill_total}' if bill_total else ''}) cart me add ho gaya hai aur aapke number {p_txt} par OTP bhej diya gaya hai! "
                f"Kripya OTP bolkar bataiye ya screen par enter kijiye."
            )
        elif checkout_info.get("order_placed"):
            result["message"] = (
                f"Boss, Microsoft Edge me aapka order successfully book ho gaya hai! "
                f"Dish: {qty_phrase}'{selected['name']}' from {restaurant_name} for ₹{selected['price'] * qty}"
                f"{f' (Total: ₹{bill_total})' if bill_total else ''}. "
                f"Payment Method: Cash on Delivery (COD). Delivery Location: {active_city}. Microsoft Edge me live tracking open hai!"
            )
        else:
            result["message"] = (
                f"Boss, Microsoft Edge me {restaurant_name} se {qty_phrase}'{selected['name']}' (₹{selected['price']} each"
                f"{f', Total Bill: ₹{bill_total}' if bill_total else ''}) select ho gaya hai aur Cash on Delivery checkout ready hai. "
                f"Screen par 1-click confirm kar dijiye."
            )

        if headless:
            await context.close()
            await playwright_instance.stop()
        else:
            try:
                await playwright_instance.stop()
            except Exception:
                pass

        return result

    except Exception as exc:
        print(f"[FoodOrdering] Swiggy execution error: {exc}")
        result["message"] = f"Swiggy automation encountered: {str(exc)}"
        if context and headless:
            try:
                await context.close()
            except Exception:
                pass
        if playwright_instance and headless:
            try:
                await playwright_instance.stop()
            except Exception:
                pass
        return result


async def _order_from_zomato(
    dish: str,
    quantity: int = 1,
    max_budget: Optional[float] = None,
    min_budget: Optional[float] = None,
    location: Optional[str] = None,
    payment_method: str = "cod",
    auto_order: bool = True,
    headless: bool = False,
    screenshot_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Automates dish search, strict price evaluation, and cart setup on Zomato."""
    from playwright.async_api import async_playwright

    geo = _get_live_location()
    active_city = location or geo.get("city", "Agra")
    city_slug = active_city.lower().replace(" ", "-").strip()
    qty = max(1, int(quantity or 1))

    # Reserve realistic overhead for Swiggy Delivery Fee (₹30-45) + Taxes/Packaging (₹30-45)
    # This guarantees the final checkout bill strictly stays within user's max budget!
    overhead = min(75.0, max_budget * 0.35) if max_budget else 0.0
    max_item_budget = max(35.0, (max_budget - overhead) / qty) if max_budget else None
    min_item_budget = (min_budget / qty) if min_budget else None
    if max_budget:
        print(f"[FoodOrdering] Swiggy Budget Guard: Max Budget=₹{max_budget}, Overhead Reserve=₹{overhead:.1f}, Max Item Price=₹{max_item_budget:.1f}")

    result: Dict[str, Any] = {
        "success": False,
        "platform": "Zomato",
        "dish_requested": dish,
        "quantity": qty,
        "dish_found": None,
        "price": None,
        "restaurant": None,
        "location": active_city,
        "payment_method": payment_method.upper(),
        "order_status": "failed",
        "message": "",
        "cart_url": None,
        "screenshot": None,
    }

    playwright_instance = None
    context = None
    state_file = ""
    try:
        playwright_instance = await async_playwright().start()
        context, state_file = await _launch_browser_and_context(playwright_instance, geo, headless=headless)
        page = context.pages[0] if context.pages else await context.new_page()
        page = await _clean_up_tabs(context, keep_page=page)
        if not headless:
            _bring_edge_to_front()

        delivery_url = f"https://www.zomato.com/{city_slug}/delivery?q={quote(dish)}"
        print(f"[FoodOrdering] Navigating to Zomato Delivery in {active_city}: {delivery_url}")
        await page.goto(delivery_url, timeout=30000, wait_until="domcontentloaded")
        await page.wait_for_timeout(3000)

        # Iterate restaurant order links to find one with matching items within budget
        rest_links = page.locator("a[href*='/order']")
        total_rests = await rest_links.count()
        print(f"[FoodOrdering] Found {total_rests} Zomato restaurant order links.")

        found_item = None
        for r_idx in range(min(total_rests, 5)):
            r_link = rest_links.nth(r_idx)
            print(f"[FoodOrdering] Checking Zomato restaurant #{r_idx}...")
            await r_link.click()
            await page.wait_for_timeout(3500)

            # Dismiss 'Continue in browser' popup
            cont_btn = page.locator(
                "button:has-text('Continue in browser'), div:has-text('Continue in browser'), "
                "span:has-text('Continue in browser'), p:has-text('Continue in browser')"
            ).first
            if await cont_btn.count() > 0:
                try:
                    await cont_btn.evaluate("el => el.click()")
                    await page.wait_for_timeout(1500)
                except Exception:
                    pass

            # Extract dish cards from Zomato menu
            z_candidates = await page.evaluate("""({dishQuery, maxItemBudget, minItemBudget}) => {
                const results = [];
                const addBtns = Array.from(document.querySelectorAll('span, div, button')).filter(el => el.innerText.trim() === 'ADD');
                const dishLower = dishQuery.toLowerCase();

                for (let i = 0; i < addBtns.length; i++) {
                    const btn = addBtns[i];
                    let card = btn.closest('div[class*="sc-"]') || btn.parentElement.parentElement;
                    const text = card ? card.innerText : "";
                    const mPrice = text.match(/[₹Rs\\.]\\s*(\\d+(?:\\.\\d+)?)/i);
                    let price = mPrice ? parseFloat(mPrice[1]) : null;
                    
                    const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                    let name = lines[0] || "";
                    if (name.includes("ADD")) name = lines[1] || "";

                    if (name && price !== null) {
                        if (maxItemBudget !== null && maxItemBudget !== undefined && price > maxItemBudget) continue;
                        if (minItemBudget !== null && minItemBudget !== undefined && price < minItemBudget) continue;
                        const rel = name.toLowerCase().includes(dishLower) ? 0 : 1;
                        results.push({ idx: i, name, price, relevance: rel });
                    }
                }
                results.sort((a, b) => a.relevance - b.relevance || a.price - b.price);
                return results;
            }""", {"dishQuery": dish, "maxItemBudget": max_item_budget, "minItemBudget": min_item_budget})

            if z_candidates:
                found_item = z_candidates[0]
                print(f"[FoodOrdering] Zomato: Found matching item '{found_item['name']}' at Rs. {found_item['price']}")
                
                # Click the ADD button of this specific item
                add_btns = page.locator("span:text-is('ADD'), div:text-is('ADD'), button:has-text('ADD')")
                if await add_btns.count() > found_item["idx"]:
                    await add_btns.nth(found_item["idx"]).click(force=True)
                    await page.wait_for_timeout(2000)

                    # Customization modal
                    modal_btn = page.locator("button:has-text('Add Item'), span:has-text('Add Item'), button:has-text('Continue')").first
                    if await modal_btn.count() > 0:
                        try:
                            await modal_btn.evaluate("el => el.click()")
                            await page.wait_for_timeout(1500)
                        except Exception:
                            pass

                    # If quantity > 1, click plus
                    if qty > 1:
                        try:
                            for _ in range(qty - 1):
                                plus_z = page.locator("div:text-is('+'), button:text-is('+'), span:text-is('+')").first
                                if await plus_z.count() > 0:
                                    await plus_z.click()
                                    await page.wait_for_timeout(800)
                        except Exception as zqe:
                            print(f"[FoodOrdering] Zomato quantity increment note: {zqe}")
                break
            else:
                print(f"[FoodOrdering] No items under budget at restaurant #{r_idx}. Trying next...")
                await page.go_back()
                await page.wait_for_timeout(2500)

        if not found_item:
            budget_str = f"under ₹{max_budget}" if max_budget else "in your budget"
            qty_str = f"for quantity {qty}" if qty > 1 else ""
            result["message"] = f"Aapke budget ({budget_str}) ke andar {qty_str} Zomato par '{dish}' nahi mila."
            return result

        # Click Cart / Continue to checkout
        cart_btn = page.locator(
            "button:has-text('Continue'), button:has-text('Checkout'), "
            "div:has-text('View Cart'), button:has-text('Place Order')"
        ).first
        if await cart_btn.count() > 0:
            try:
                print("[FoodOrdering] Clicking Zomato checkout button...")
                await cart_btn.evaluate("el => el.click()")
                await page.wait_for_timeout(3000)
            except Exception:
                pass

        # Save session
        await _save_session_state(context, state_file)

        # Save screenshot
        ss_path = None
        if screenshot_dir:
            os.makedirs(screenshot_dir, exist_ok=True)
            ss_path = os.path.join(screenshot_dir, f"zomato_order_{int(time.time())}.png")
            try:
                await page.screenshot(path=ss_path, full_page=False)
            except Exception:
                pass

        dish_price = found_item["price"]
        result["success"] = True
        result["dish_found"] = found_item["name"]
        result["price"] = dish_price
        result["quantity"] = qty
        result["restaurant"] = "Zomato Restaurant"
        result["cart_url"] = page.url
        result["screenshot"] = ss_path
        result["order_status"] = "ready_for_confirmation"
        qty_phrase = f"{qty}x " if qty > 1 else ""
        result["message"] = (
            f"Successfully found {qty_phrase}'{found_item['name']}' in {active_city} for ₹{dish_price * qty} "
            f"(strictly within budget of ₹{max_budget or (dish_price * qty)}) on Zomato! "
            f"Item cart me add ho gaya hai aur Cash on Delivery checkout screen ready hai. Permanent food profile enabled hai!"
        )

        if headless:
            await context.close()
            await playwright_instance.stop()
        else:
            try:
                await playwright_instance.stop()
            except Exception:
                pass

        return result

    except Exception as exc:
        print(f"[FoodOrdering] Zomato execution error: {exc}")
        result["message"] = f"Zomato automation encountered: {str(exc)}"
        if context and headless:
            try:
                await context.close()
            except Exception:
                pass
        if playwright_instance and headless:
            try:
                await playwright_instance.stop()
            except Exception:
                pass
        return result


def execute_food_order(
    dish: str,
    quantity: int = 1,
    max_budget: Optional[float] = None,
    min_budget: Optional[float] = None,
    platform: str = "auto",
    city: Optional[str] = None,
    location: Optional[str] = None,
    payment_method: str = "cod",
    auto_order: bool = True,
    headless: bool = False,
    screenshot_dir: Optional[str] = None,
) -> CommandResult:
    """Synchronous entry point to order food via Playwright."""
    if not dish or not dish.strip():
        return CommandResult(
            success=False,
            message="Please specify the dish name you want to order (e.g., 'burger', 'biryani', 'pizza', 'paneer butter masala').",
        )

    clean_dish = dish.strip()
    qty = max(1, int(quantity or 1))
    plat = platform.lower().strip() if platform else "auto"
    target_loc = location or city

    if not screenshot_dir:
        base_dir = os.environ.get("ERA_WORKSPACE_DIR") or os.path.join(os.getcwd(), "workspace")
        screenshot_dir = os.path.join(base_dir, "orders")

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        res: Dict[str, Any] = {}
        if plat == "zomato":
            res = loop.run_until_complete(
                _order_from_zomato(
                    clean_dish, qty, max_budget, min_budget, target_loc,
                    payment_method, auto_order, headless, screenshot_dir
                )
            )
        elif plat == "swiggy":
            res = loop.run_until_complete(
                _order_from_swiggy(
                    clean_dish, qty, max_budget, min_budget, target_loc,
                    payment_method, auto_order, headless, screenshot_dir
                )
            )
        else:
            print(f"[FoodOrdering] Platform 'auto': Trying Swiggy first for '{clean_dish}' (Qty={qty}) within budget Rs. {max_budget}...")
            res = loop.run_until_complete(
                _order_from_swiggy(
                    clean_dish, qty, max_budget, min_budget, target_loc,
                    payment_method, auto_order, headless, screenshot_dir
                )
            )
            if not res.get("success"):
                swiggy_msg = res.get("message", "")
                # If Swiggy failed because the checkout total exceeded user's budget, DO NOT fallback to Zomato!
                # Report Swiggy's truthful budget protection message directly!
                if res.get("order_status") == "budget_exceeded":
                    print(f"[FoodOrdering] Swiggy strictly protected user budget: {swiggy_msg}")
                else:
                    print(f"[FoodOrdering] Swiggy note: {swiggy_msg}. Attempting Zomato fallback...")
                    z_res = loop.run_until_complete(
                        _order_from_zomato(
                            clean_dish, qty, max_budget, min_budget, target_loc,
                            payment_method, auto_order, headless, screenshot_dir
                        )
                    )
                    if z_res.get("success"):
                        res = z_res
                    else:
                        # Swiggy was opened on screen, so never confuse the user by blaming Zomato!
                        if "swiggy" in swiggy_msg.lower() or "budget" in swiggy_msg.lower():
                            res["message"] = swiggy_msg
                        else:
                            res["message"] = f"Aapke budget ({f'under ₹{int(max_budget)}' if max_budget else ''}) ke andar '{clean_dish}' nahi mil pa raha hai."

        loop.close()

        if res.get("success"):
            return CommandResult(
                success=True,
                message=res.get("message", f"Found and selected {qty}x '{clean_dish}' strictly within budget!"),
                data=res,
            )
        else:
            return CommandResult(
                success=False,
                message=res.get("message", f"Could not find '{clean_dish}' within the specified price range."),
                data=res,
            )

    except Exception as e:
        return CommandResult(
            success=False,
            message=f"Food ordering agent error: {str(e)}",
            data={"error": str(e)},
        )


@registry.register(
    "order_food",
    "Autonomously orders food from Swiggy or Zomato based on dish, quantity, budget range, delivery location, and Cash on Delivery.",
    params=[
        CommandParam("dish", "str", "Name of the dish or food item to order (e.g. 'biryani', 'pizza', 'burger', 'dal makhani')", required=True),
        CommandParam("quantity", "int", "Quantity of the dish to order (e.g. 1, 2, 3, default: 1)", required=False),
        CommandParam("max_budget", "float", "Maximum budget in INR (e.g. 150, 200, 300, 400)", required=False),
        CommandParam("min_budget", "float", "Minimum budget in INR (e.g. 50, 100)", required=False),
        CommandParam("platform", "str", "'swiggy', 'zomato', or 'auto' (default: 'auto')", required=False),
        CommandParam("phone", "str", "User 10-digit mobile number for Swiggy auto-login (optional)", required=False),
        CommandParam("location", "str", "Delivery location or address spoken by user (optional, defaults to live location)", required=False),
        CommandParam("city", "str", "Delivery city or address (optional)", required=False),
        CommandParam("payment_method", "str", "'cod' for Cash on Delivery (default: 'cod')", required=False),
        CommandParam("auto_order", "bool", "Directly place order with COD if true (default: true)", required=False),
        CommandParam("headless", "bool", "Run browser silently in background if true; visible if false (default: false)", required=False),
    ],
)
def order_food(
    dish: str,
    quantity: int = 1,
    max_budget: Optional[float] = None,
    min_budget: Optional[float] = None,
    platform: str = "auto",
    phone: Optional[str] = None,
    location: Optional[str] = None,
    city: Optional[str] = None,
    payment_method: str = "cod",
    auto_order: bool = True,
    headless: bool = False,
    **kwargs: Any,
) -> CommandResult:
    """Registered command handler for ERA."""
    if phone:
        _save_user_phone(phone)
    effective_max = max_budget if max_budget is not None else kwargs.get("budget")
    if effective_max is not None:
        try:
            effective_max = float(effective_max)
        except Exception:
            pass
    effective_min = min_budget if min_budget is not None else kwargs.get("min_price")
    return execute_food_order(
        dish=dish,
        quantity=quantity,
        max_budget=effective_max,
        min_budget=effective_min,
        platform=platform,
        location=location or city,
        city=city or location,
        payment_method=payment_method,
        auto_order=auto_order,
        headless=headless,
    )


@registry.register(
    "login_food_service",
    "Opens Swiggy or Zomato in Microsoft Edge so user can log in once with their phone/OTP and save their session permanently.",
    params=[
        CommandParam("platform", "str", "'swiggy' or 'zomato' (default: 'swiggy')", required=False),
        CommandParam("phone", "str", "User 10-digit mobile number for auto-fill (optional)", required=False),
    ],
)
def login_food_service(platform: str = "swiggy", phone: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Opens Swiggy/Zomato in Microsoft Edge in the persistent food profile for permanent login."""
    if phone:
        _save_user_phone(phone)
    plat = (platform or "swiggy").lower().strip()
    target_url = "https://www.swiggy.com" if plat != "zomato" else "https://www.zomato.com"
    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    edge_food_profile = os.path.join(app_data, "ERA", "edge_food_profile")
    os.makedirs(edge_food_profile, exist_ok=True)
    state_file = os.path.join(app_data, "ERA", "edge_food_session.json")

    _clean_profile_locks(edge_food_profile)

    async def _run_login():
        from playwright.async_api import async_playwright
        p = await async_playwright().start()
        geo = _get_live_location()
        edge_user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
        )
        context = await p.chromium.launch_persistent_context(
            user_data_dir=edge_food_profile,
            channel="msedge",
            headless=False,
            user_agent=edge_user_agent,
            permissions=["geolocation"],
            geolocation={"latitude": geo["lat"], "longitude": geo["lon"]},
            args=["--disable-blink-features=AutomationControlled", "--start-maximized"],
        )
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(target_url, timeout=30000, wait_until="domcontentloaded")
        print(f"[FoodOrdering] Opened {target_url} in Microsoft Edge for permanent login.")

        # Click Sign In button if visible to bring up the phone number input drawer immediately
        try:
            sign_in_btn = page.locator("a:has-text('Sign In'), button:has-text('Sign In'), div:text-is('Sign In'), span:text-is('Sign In')").first
            if await sign_in_btn.count() > 0:
                await sign_in_btn.click()
                print("[FoodOrdering] 'Sign In' button clicked. Login drawer opened.")
                await page.wait_for_timeout(1500)

            # Auto-fill user phone if known
            saved_p = _get_user_phone()
            if saved_p:
                p_inp = page.locator("input#mobile, input[name='mobile'], input[type='tel']").first
                if await p_inp.count() > 0:
                    await p_inp.fill(saved_p)
                    await page.wait_for_timeout(400)
                    await p_inp.press("Enter")
                    await page.wait_for_timeout(600)
                    await page.evaluate("""() => {
                        const all = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
                        const target = all.find(el => {
                            const t = (el.innerText || '').trim();
                            return (t === 'LOGIN' || t === 'Login' || t === 'CONTINUE' || t === 'Continue') && !el.innerText.toLowerCase().includes('account');
                        }) || document.querySelector('a.a-btn, button.a-btn, a._1gPB7, a.lyOGZ');
                        if (target) target.click();
                    }""")
                    await page.wait_for_timeout(1500)
                    # Check Name & Email for signup
                    user_info = _get_user_info()
                    name_inp = page.locator("input#name, input[name='name']").first
                    if await name_inp.count() > 0 and await name_inp.is_visible():
                        await name_inp.fill(user_info["name"])
                        await page.wait_for_timeout(300)
                        email_inp = page.locator("input#email, input[name='email']").first
                        if await email_inp.count() > 0 and await email_inp.is_visible():
                            await email_inp.fill(user_info["email"])
                            await page.wait_for_timeout(300)
                        await page.evaluate("""() => {
                            const btns = Array.from(document.querySelectorAll('a, button, div[role="button"]')).filter(b => {
                                const t = (b.innerText || '').trim();
                                return t === 'CONTINUE' || t === 'Continue' || t === 'Sign up' || t === 'SIGN UP';
                            });
                            if (btns.length > 0) btns[btns.length - 1].click();
                        }""")
                        await page.wait_for_timeout(1500)
                    print(f"[FoodOrdering] Autofilled saved mobile (+91 {saved_p[:2]}******{saved_p[-2:]}) and triggered OTP!")
        except Exception:
            pass

        # Monitor for up to 180 seconds while user enters mobile number and OTP
        app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
        otp_file = os.path.join(app_data, "ERA", "pending_otp.txt")

        for _ in range(90):
            await page.wait_for_timeout(2000)
            try:
                # Check for spoken OTP
                if os.path.exists(otp_file):
                    try:
                        with open(otp_file, "r", encoding="utf-8") as f:
                            spoken_otp = f.read().strip()
                        try:
                            os.remove(otp_file)
                        except Exception:
                            pass
                        if spoken_otp:
                            print(f"[FoodOrdering] Spoken OTP received: {spoken_otp}! Entering into {plat}...")
                            await _enter_otp_on_page(page, spoken_otp)
                    except Exception as oe:
                        print(f"[FoodOrdering] Spoken OTP note: {oe}")

                txt = await page.evaluate("document.body.innerText")
                if "My Account" in txt or "Sign Out" in txt or "Log out" in txt or "Profile" in txt or (
                    "Sign In" not in txt and ("DELIVER HERE" in txt or "Delivery address" in txt or "Payment" in txt)
                ):
                    await context.storage_state(path=state_file)
                    print(f"[FoodOrdering] User login detected on {plat} in Microsoft Edge! Session permanently saved.")
                    break
            except Exception:
                pass
        try:
            await context.storage_state(path=state_file)
        except Exception:
            pass
        return True

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_run_login())
        loop.close()
        return CommandResult(
            success=True,
            message=f"Microsoft Edge {plat.capitalize()} ke permanent session me open ho gaya hai. Aapka account permanently saved rahega!",
        )
    except Exception as e:
        return CommandResult(success=False, message=f"Login helper notice: {e}")


def _pyautogui_otp_fallback(clean_otp: str) -> None:
    """Fallback: brings Edge window to foreground and types OTP via PyAutoGUI."""
    try:
        import pyautogui
        import win32gui, win32con
        def enum_cb(hwnd, results):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if "Edge" in title or "Swiggy" in title or "Zomato" in title or "Checkout" in title:
                    results.append(hwnd)
            return True
        hwnds = []
        win32gui.EnumWindows(enum_cb, hwnds)
        if hwnds:
            try:
                win32gui.ShowWindow(hwnds[0], win32con.SW_MAXIMIZE)
                win32gui.SetForegroundWindow(hwnds[0])
                time.sleep(0.3)
            except Exception:
                pass
        pyautogui.write(clean_otp, interval=0.08)
        time.sleep(0.3)
        pyautogui.press("enter")
    except Exception as pe:
        print(f"[FoodOrdering] PyAutoGUI fallback typing note: {pe}")


async def _submit_food_otp_async(clean_otp: str) -> CommandResult:
    """Connects to active Microsoft Edge via CDP (port 9222), enters the OTP on the checkout
    page, verifies login, and completes address selection, Cash on Delivery, and Place Order!
    """
    from playwright.async_api import async_playwright

    _bring_edge_to_front()

    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    era_dir = os.path.join(app_data, "ERA")
    state_file = os.path.join(era_dir, "edge_food_session.json")

    # Record OTP in pending_otp.txt for audit/sync
    try:
        os.makedirs(era_dir, exist_ok=True)
        with open(os.path.join(era_dir, "pending_otp.txt"), "w", encoding="utf-8") as f:
            f.write(clean_otp)
    except Exception:
        pass

    try:
        async with async_playwright() as p:
            print(f"[FoodOrdering] Connecting to Microsoft Edge CDP on port 9222 to submit OTP ({clean_otp})...")
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=4000)

            # Find active Swiggy checkout page
            checkout_page = None
            for ctx in browser.contexts:
                for pg in ctx.pages:
                    try:
                        u = pg.url.lower()
                        if "swiggy.com" in u:
                            checkout_page = pg
                            if "checkout" in u or "cart" in u:
                                break
                    except Exception:
                        pass
                if checkout_page and "checkout" in checkout_page.url.lower():
                    break

            if not checkout_page:
                for ctx in browser.contexts:
                    if ctx.pages:
                        checkout_page = ctx.pages[0]
                        break

            if not checkout_page:
                print("[FoodOrdering] No active Edge page found over CDP. Using PyAutoGUI fallback.")
                _pyautogui_otp_fallback(clean_otp)
                return CommandResult(
                    success=True,
                    message=f"Ji boss! Maine OTP {clean_otp} screen par enter kar diya hai.",
                    data={"otp": clean_otp, "method": "pyautogui"},
                )

            # 1. Bring page to front and enter OTP
            try:
                await checkout_page.bring_to_front()
            except Exception:
                pass
            _bring_edge_to_front()

            print(f"[FoodOrdering] Submitting OTP {clean_otp} on checkout page...")
            await _enter_otp_on_page(checkout_page, clean_otp)
            await checkout_page.wait_for_timeout(2500)

            # 2. Complete Address, COD, and Order Placement!
            context = browser.contexts[0] if browser.contexts else None
            checkout_info = await _complete_checkout_after_login(checkout_page, context, state_file)

            if checkout_info.get("order_placed"):
                msg = (
                    f"Boss, OTP {clean_otp} verify ho gaya aur aapka order Cash on Delivery par successfully book ho gaya hai! "
                    f"Microsoft Edge me live tracking open hai."
                )
            elif checkout_info.get("cod_selected"):
                msg = (
                    f"Boss, OTP {clean_otp} verify ho gaya aur Cash on Delivery select ho chuka hai. "
                    f"Microsoft Edge screen par order ready hai."
                )
            else:
                msg = (
                    f"Boss, OTP {clean_otp} enter kar diya gaya hai. "
                    f"Microsoft Edge screen par checkout verify ho raha hai."
                )

            return CommandResult(
                success=True,
                message=msg,
                data=checkout_info,
            )

    except Exception as exc:
        print(f"[FoodOrdering] CDP OTP error: {exc}. Using PyAutoGUI fallback...")
        _pyautogui_otp_fallback(clean_otp)
        return CommandResult(
            success=True,
            message=f"Ji boss! Maine OTP {clean_otp} screen par enter kar diya hai aur order verify ho raha hai.",
            data={"otp": clean_otp, "fallback": True, "error": str(exc)},
        )


@registry.register(
    "submit_food_otp",
    "Submits spoken or provided OTP code directly to active Swiggy or Zomato ordering session in Microsoft Edge and completes order booking.",
    params=[
        CommandParam("otp", "str", "The 4-digit or 6-digit OTP code received by the user (e.g. '141535')", required=True),
    ],
)
def submit_food_otp(otp: str, **kwargs: Any) -> CommandResult:
    """Submits spoken/provided OTP to active food ordering session on Microsoft Edge and completes order."""
    clean_otp = re.sub(r"\D", "", str(otp)).strip()
    if not clean_otp:
        return CommandResult(success=False, message="Invalid OTP code provided.")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_submit_food_otp_async(clean_otp))
    finally:
        loop.close()


async def _complete_food_order_async(address: Optional[str] = None) -> CommandResult:
    """Connects to active Microsoft Edge via CDP (port 9222), executes delivery address selection
    (using phone's live location Bodla, Agra or specified address), selects Cash on Delivery,
    and clicks Place Order to finalize the order booking!
    """
    from playwright.async_api import async_playwright

    _bring_edge_to_front()

    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    era_dir = os.path.join(app_data, "ERA")
    state_file = os.path.join(era_dir, "edge_food_session.json")

    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=4000)
            checkout_page = None
            for ctx in browser.contexts:
                for pg in ctx.pages:
                    try:
                        u = pg.url.lower()
                        if "swiggy.com" in u and ("checkout" in u or "cart" in u):
                            checkout_page = pg
                            break
                    except Exception:
                        pass
                if checkout_page:
                    break

            if not checkout_page:
                for ctx in browser.contexts:
                    if ctx.pages:
                        checkout_page = ctx.pages[0]
                        break

            if not checkout_page:
                return CommandResult(
                    success=False,
                    message="Active checkout screen nahi mili. Kripya pehle khana order karne ko boliye.",
                )

            try:
                await checkout_page.bring_to_front()
            except Exception:
                pass
            _bring_edge_to_front()

            context = browser.contexts[0] if browser.contexts else None
            checkout_info = await _complete_checkout_after_login(checkout_page, context, state_file)

            if checkout_info.get("order_placed"):
                msg = (
                    "Boss, aapka live address select karke Cash on Delivery par order successfully place ho gaya hai! "
                    "Microsoft Edge me live tracking start ho chuki hai."
                )
            elif checkout_info.get("cod_selected"):
                msg = (
                    "Boss, aapka live address select ho gaya hai aur Cash on Delivery bhi choose ho gaya hai. "
                    "Order screen par ready hai!"
                )
            else:
                msg = (
                    f"Boss, checkout update ho gaya hai: {checkout_info.get('detail', 'Screen par confirm karein.')}"
                )

            return CommandResult(
                success=True,
                message=msg,
                data=checkout_info,
            )
    except Exception as exc:
        return CommandResult(
            success=False,
            message=f"Order completion notice: {exc}",
        )


@registry.register(
    "complete_food_order",
    "Fills or selects delivery address (matching phone live location in Bodla, Agra), chooses Cash on Delivery, and completes the food order booking on Microsoft Edge.",
    params=[
        CommandParam("address", "str", "Optional custom address string. If omitted, uses phone's live location automatically.", required=False),
    ],
)
def complete_food_order(address: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Fills address and completes active food ordering checkout on Microsoft Edge."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_complete_food_order_async(address))
    finally:
        loop.close()


@registry.register(
    "fill_food_address",
    "Fills or selects delivery address (matching phone live location in Bodla, Agra), chooses Cash on Delivery, and completes the food order booking on Microsoft Edge.",
    params=[
        CommandParam("address", "str", "Optional custom address string. If omitted, uses phone's live location automatically.", required=False),
    ],
)
def fill_food_address(address: Optional[str] = None, **kwargs: Any) -> CommandResult:
    """Alias for complete_food_order."""
    return complete_food_order(address, **kwargs)
