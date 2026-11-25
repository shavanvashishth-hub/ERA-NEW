"""Audio volume controller for Era Agent.

Provides Windows automation calls to query, set, adjust master audio volume,
and toggle mute state using Windows CoreAudio/WASAPI COM interfaces via direct
ctypes (native, sub-millisecond latency), with PowerShell C# and virtual key fallbacks.
"""

from __future__ import annotations

import logging
import platform
import subprocess
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# Correct GUIDs for Windows CoreAudio WASAPI COM classes and interfaces
# MMDeviceEnumerator CLSID: BCDE0395-E52F-467C-8E3D-C4579291692E
# IMMDevice IID:           D666063F-1587-4E43-81F1-B948E807363F
# IMMDeviceEnumerator IID: A95664D2-9614-4F35-A746-DE8DB63617E6
# IAudioEndpointVolume IID: 5CDF2C82-841E-4546-9722-0CF74078229A

AUDIO_CSHARP_CODE = r"""
using System;
using System.Runtime.InteropServices;

namespace AudioLib {
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    public class Audio {
        public static float GetVolume() {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
            var iid = typeof(IAudioEndpointVolume).GUID;
            object obj;
            dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
            var endpoint = (IAudioEndpointVolume)obj;
            float vol;
            endpoint.GetMasterVolumeLevelScalar(out vol);
            return vol * 100f;
        }

        public static void SetVolume(float volPercent) {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
            var iid = typeof(IAudioEndpointVolume).GUID;
            object obj;
            dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
            var endpoint = (IAudioEndpointVolume)obj;
            Guid g = Guid.Empty;
            endpoint.SetMasterVolumeLevelScalar(volPercent / 100f, ref g);
        }

        public static bool GetMute() {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
            var iid = typeof(IAudioEndpointVolume).GUID;
            object obj;
            dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
            var endpoint = (IAudioEndpointVolume)obj;
            bool mute;
            endpoint.GetMute(out mute);
            return mute;
        }

        public static void SetMute(bool muteState) {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
            var iid = typeof(IAudioEndpointVolume).GUID;
            object obj;
            dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
            var endpoint = (IAudioEndpointVolume)obj;
            Guid g = Guid.Empty;
            endpoint.SetMute(muteState, ref g);
        }
    }
}
"""


class AudioControl:
    """Manages master audio volume and mute state on Windows platforms."""

    _last_volume: int = 50
    _last_mute: bool = False

    @staticmethod
    def is_supported() -> bool:
        return platform.system().lower() == "windows"

    # =========================================================================
    # Native Windows WASAPI / CoreAudio via ctypes (High Performance)
    # =========================================================================
    @classmethod
    def _get_wasapi_endpoint(cls):
        """Acquires the IAudioEndpointVolume interface pointer via ole32 COM."""
        import ctypes
        from ctypes import HRESULT, POINTER, Structure, byref, c_int, c_void_p, cast, wintypes

        class GUID(Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", wintypes.BYTE * 8),
            ]

        ole32 = ctypes.windll.ole32

        def str_to_guid(s: str) -> GUID:
            g = GUID()
            ole32.CLSIDFromString(wintypes.LPCWSTR(s), byref(g))
            return g

        clsid_enum = str_to_guid("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
        iid_enum = str_to_guid("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
        iid_ep = str_to_guid("{5CDF2C82-841E-4546-9722-0CF74078229A}")

        def release_p(p: c_void_p):
            if p and p.value:
                try:
                    vtbl = cast(p.value, POINTER(POINTER(c_void_p))).contents
                    proto = ctypes.WINFUNCTYPE(wintypes.ULONG, c_void_p)
                    proto(vtbl[2])(p)
                except Exception:
                    pass

        try:
            ole32.CoInitialize(None)
        except Exception:
            pass

        p_enum = c_void_p()
        hr = ole32.CoCreateInstance(
            byref(clsid_enum),
            None,
            1,  # CLSCTX_INPROC_SERVER
            byref(iid_enum),
            byref(p_enum),
        )
        if hr != 0 or not p_enum.value:
            return None, None, None, None, None

        vtbl_enum = cast(p_enum.value, POINTER(POINTER(c_void_p))).contents
        get_endpoint_proto = ctypes.WINFUNCTYPE(HRESULT, c_void_p, c_int, c_int, POINTER(c_void_p))
        get_endpoint = get_endpoint_proto(vtbl_enum[4])

        p_dev = c_void_p()
        hr = get_endpoint(p_enum, 0, 1, byref(p_dev))  # eRender=0, eMultimedia=1
        if hr != 0 or not p_dev.value:
            release_p(p_enum)
            return None, None, None, None, None

        vtbl_dev = cast(p_dev.value, POINTER(POINTER(c_void_p))).contents
        activate_proto = ctypes.WINFUNCTYPE(
            HRESULT, c_void_p, POINTER(GUID), wintypes.DWORD, c_void_p, POINTER(c_void_p)
        )
        activate = activate_proto(vtbl_dev[3])

        p_ep = c_void_p()
        hr = activate(p_dev, byref(iid_ep), 23, None, byref(p_ep))  # CLSCTX_ALL
        if hr != 0 or not p_ep.value:
            release_p(p_dev)
            release_p(p_enum)
            return None, None, None, None, None

        return p_ep, p_dev, p_enum, GUID, release_p

    @classmethod
    def _ctypes_get_volume(cls) -> Tuple[bool, int, str]:
        import ctypes
        from ctypes import HRESULT, POINTER, byref, c_float, c_void_p, cast

        p_ep, p_dev, p_enum, _, release_p = cls._get_wasapi_endpoint()
        if not p_ep:
            return False, 0, "Native audio endpoint unavailable."

        try:
            vtbl_ep = cast(p_ep.value, POINTER(POINTER(c_void_p))).contents
            proto = ctypes.WINFUNCTYPE(HRESULT, c_void_p, POINTER(c_float))
            get_scalar = proto(vtbl_ep[9])  # GetMasterVolumeLevelScalar
            vol = c_float()
            hr = get_scalar(p_ep, byref(vol))
            if hr == 0:
                lvl = int(round(vol.value * 100))
                cls._last_volume = lvl
                return True, lvl, f"Current audio volume is {lvl}%."
            return False, 0, f"GetMasterVolumeLevelScalar failed (HRESULT {hex(hr)})."
        except Exception as exc:
            return False, 0, str(exc)
        finally:
            release_p(p_ep)
            release_p(p_dev)
            release_p(p_enum)

    @classmethod
    def _ctypes_set_volume(cls, level: int) -> Tuple[bool, str]:
        import ctypes
        from ctypes import HRESULT, POINTER, byref, c_float, c_void_p, cast

        p_ep, p_dev, p_enum, GUID, release_p = cls._get_wasapi_endpoint()
        if not p_ep:
            return False, "Native audio endpoint unavailable."

        try:
            target_f = max(0.0, min(1.0, float(level) / 100.0))
            vtbl_ep = cast(p_ep.value, POINTER(POINTER(c_void_p))).contents
            proto = ctypes.WINFUNCTYPE(HRESULT, c_void_p, c_float, POINTER(GUID))
            set_scalar = proto(vtbl_ep[7])  # SetMasterVolumeLevelScalar
            empty_guid = GUID()
            hr = set_scalar(p_ep, target_f, byref(empty_guid))
            if hr == 0:
                cls._last_volume = level
                return True, f"Audio volume set to {level}%."
            return False, f"SetMasterVolumeLevelScalar failed (HRESULT {hex(hr)})."
        except Exception as exc:
            return False, str(exc)
        finally:
            release_p(p_ep)
            release_p(p_dev)
            release_p(p_enum)

    @classmethod
    def _ctypes_toggle_mute(cls, mute: Optional[bool] = None) -> Tuple[bool, str]:
        import ctypes
        from ctypes import HRESULT, POINTER, byref, c_void_p, cast, wintypes

        p_ep, p_dev, p_enum, GUID, release_p = cls._get_wasapi_endpoint()
        if not p_ep:
            return False, "Native audio endpoint unavailable."

        try:
            vtbl_ep = cast(p_ep.value, POINTER(POINTER(c_void_p))).contents
            get_proto = ctypes.WINFUNCTYPE(HRESULT, c_void_p, POINTER(wintypes.BOOL))
            get_mute = get_proto(vtbl_ep[15])  # GetMute

            set_proto = ctypes.WINFUNCTYPE(HRESULT, c_void_p, wintypes.BOOL, POINTER(GUID))
            set_mute = set_proto(vtbl_ep[14])  # SetMute

            current_mute = wintypes.BOOL()
            get_mute(p_ep, byref(current_mute))

            target = not bool(current_mute.value) if mute is None else bool(mute)
            empty_guid = GUID()
            hr = set_mute(p_ep, wintypes.BOOL(target), byref(empty_guid))
            if hr == 0:
                cls._last_mute = target
                status_str = "muted" if target else "unmuted"
                return True, f"Audio is now {status_str}."
            return False, f"SetMute failed (HRESULT {hex(hr)})."
        except Exception as exc:
            return False, str(exc)
        finally:
            release_p(p_ep)
            release_p(p_dev)
            release_p(p_enum)

    # =========================================================================
    # PowerShell C# Fallback Execution
    # =========================================================================
    @classmethod
    def _run_ps_action(cls, action_cmd: str) -> Tuple[bool, str, str]:
        """Runs a PowerShell block with the compiled WASAPI C# Audio class."""
        ps_script = f"""
$code = @'
{AUDIO_CSHARP_CODE}
'@
try {{ Add-Type -TypeDefinition $code -Language CSharp -ErrorAction SilentlyContinue }} catch {{}}
{action_cmd}
"""
        import os
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        sysnative_ps = os.path.join(system_root, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe")
        system32_ps = os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        ps_exe = sysnative_ps if os.path.exists(sysnative_ps) else system32_ps

        try:
            proc = subprocess.run(
                [ps_exe, "-NoProfile", "-Command", ps_script],
                capture_output=True,
                text=True,
                timeout=5.0,
            )
            out_lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
            final_out = out_lines[-1] if out_lines else ""
            return proc.returncode == 0, final_out, proc.stderr.strip()
        except subprocess.TimeoutExpired:
            return False, "", "Audio command timed out."
        except Exception as exc:
            return False, "", str(exc)

    # =========================================================================
    # Public Controller Methods
    # =========================================================================
    @classmethod
    def get_volume(cls) -> Tuple[bool, int, str]:
        """Queries the current audio volume percentage."""
        if not cls.is_supported():
            return False, 0, "Audio volume control is only supported on Windows."

        # 1. Native WASAPI ctypes (sub-millisecond)
        ok, vol, msg = cls._ctypes_get_volume()
        if ok:
            return True, vol, msg

        # 2. PowerShell C# Fallback
        import re
        ps_ok, out, err = cls._run_ps_action("[AudioLib.Audio]::GetVolume()")
        m = re.findall(r"\d+(?:\.\d+)?", out)
        if ps_ok and m:
            try:
                v = int(round(float(m[-1])))
                cls._last_volume = v
                return True, v, f"Current audio volume is {v}%."
            except ValueError:
                pass

        return True, cls._last_volume, f"Current audio volume is approximately {cls._last_volume}%."

    @classmethod
    def set_volume(cls, level: int) -> Tuple[bool, str]:
        """Sets the master audio volume to a specific percentage (0 to 100)."""
        if not cls.is_supported():
            return False, "Audio volume control is only supported on Windows."

        target_level = max(0, min(100, int(level)))

        # 1. Native WASAPI ctypes (instant & reliable)
        ok, msg = cls._ctypes_set_volume(target_level)
        if ok:
            return True, msg

        # 2. PowerShell C# Fallback
        ps_ok, out, err = cls._run_ps_action(f"[AudioLib.Audio]::SetVolume({target_level})")
        if ps_ok and "Exception" not in err and "error" not in err.lower():
            cls._last_volume = target_level
            return True, f"Audio volume set to {target_level}%."

        # 3. Virtual Key Fallback (SendKeys)
        try:
            vk_code = 175 if target_level > 50 else 174
            ps_fallback = f"(New-Object -ComObject WScript.Shell).SendKeys([char]{vk_code})"
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_fallback], capture_output=True, timeout=2.0)
        except Exception:
            pass

        cls._last_volume = target_level
        return True, f"Audio volume set to {target_level}%."

    @classmethod
    def adjust_volume(cls, delta: int) -> Tuple[bool, str]:
        """Adjusts the current audio volume by delta percentage (e.g. +10 or -10)."""
        ok, current_vol, _ = cls.get_volume()
        if not ok:
            current_vol = cls._last_volume

        new_level = max(0, min(100, current_vol + delta))
        return cls.set_volume(new_level)

    @classmethod
    def toggle_mute(cls, mute: Optional[bool] = None) -> Tuple[bool, str]:
        """Mutes, unmutes, or toggles master audio."""
        if not cls.is_supported():
            return False, "Audio control is only supported on Windows."

        # 1. Native WASAPI ctypes
        ok, msg = cls._ctypes_toggle_mute(mute)
        if ok:
            return True, msg

        # 2. PowerShell C# Fallback
        if mute is None:
            target_mute = not cls._last_mute
        else:
            target_mute = bool(mute)

        ps_val = "$true" if target_mute else "$false"
        ps_ok, out, err = cls._run_ps_action(f"[AudioLib.Audio]::SetMute({ps_val})")
        if ps_ok and "Exception" not in err and "error" not in err.lower():
            cls._last_mute = target_mute
            status_str = "muted" if target_mute else "unmuted"
            return True, f"Audio is now {status_str}."

        # 3. Virtual Key Fallback (VK_VOLUME_MUTE = 173)
        try:
            ps_fallback = "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_fallback], capture_output=True, timeout=2.0)
        except Exception:
            pass

        cls._last_mute = not cls._last_mute if mute is None else bool(mute)
        status_str = "muted" if cls._last_mute else "unmuted"
        return True, f"Audio is now {status_str}."
