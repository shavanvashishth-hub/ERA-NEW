"""Standalone CLI launcher for ERA Hand Gesture Intelligence.

Usage:
    python run_gesture_control.py [--preview] [--camera ID] [--no-mirror]
"""

import argparse
import sys
import time

from gestures import GestureService


def main():
    parser = argparse.ArgumentParser(description="ERA Hand Gesture Recognition & Intelligence Engine")
    parser.add_argument("--preview", action="store_true", help="Open visual HUD desktop window")
    parser.add_argument("--camera", type=int, default=0, help="Camera device index (default: 0)")
    parser.add_argument("--no-mirror", action="store_true", help="Disable mirror mode")
    args = parser.parse_args()

    print("=" * 60)
    print("   ERA HAND GESTURE INTELLIGENCE ENGINE")
    print("=" * 60)
    print("Controls:")
    print("  - Fingers moving away from palm : Display Brightness UP (+5%)")
    print("  - Fingers moving towards palm   : Display Brightness DOWN (-5%)")
    print("  - Palm rotating Clockwise       : Audio Volume UP (+4%)")
    print("  - Palm rotating Anti-Clockwise  : Audio Volume DOWN (-4%)")
    print("  - Victory sign (✌️) held        : Audio Mute / Unmute")
    print("  - Closed Fist (✊) held         : Media Play / Pause")
    print("  - Thumbs Up (👍) held          : Media Next Track")
    print("  - Thumbs Down (👎) held        : Media Previous Track")
    print("=" * 60)
    print(f"Initializing on Camera {args.camera} (Preview: {args.preview})...")

    service = GestureService.get_instance()
    res = service.start(camera_id=args.camera, preview=args.preview, mirror=not args.no_mirror)
    print(res["message"])

    if not service.is_running():
        print("Failed to start gesture service. Check camera connection.")
        sys.exit(1)

    print("\n[ACTIVE] Gesture tracking running. Press Ctrl+C to stop.\n")
    try:
        while service.is_running():
            status = service.get_status()
            sys.stdout.write(
                f"\r[STATUS] FPS: {status['fps']:<4} | Hands: {status['hands_detected']} | "
                f"Gesture: {status['last_gesture']:<12} | Brightness: {status['current_brightness']}% | "
                f"Volume: {status['current_volume']}%   "
            )
            sys.stdout.flush()
            time.sleep(0.2)
    except KeyboardInterrupt:
        print("\n\nStopping gesture service...")
    finally:
        service.stop()
        print("Gesture service cleanly stopped.")


if __name__ == "__main__":
    main()
