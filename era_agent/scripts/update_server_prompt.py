with open(r"D:\era-voice-assistant\server.ts", "r", encoding="utf-8") as f:
    text = f.read()

old_s = """    - INCOMING PHONE CALL HANDLING:
      - When an incoming call is ringing or announced (e.g., "Boss, [Caller] ka call aa raha hai. Kya karna hai, accept ya reject?"):
      - If the boss commands "accept", "uthalo", "pick up", "answer", "haan", "call receive karo":
        YOU MUST IMMEDIATELY call answerPhoneCall()!
      - If the boss commands "reject", "kaat do", "decline", "cut karo", "nahi", "call dismiss karo":
        YOU MUST IMMEDIATELY call rejectPhoneCall()!"""

new_s = """    - CALL ACCEPT & REJECT / HANGUP CONTROLS (CRITICAL):
      - Whenever the boss asks to ACCEPT, ANSWER, PICK UP, or RECEIVE a call (e.g. "call uthalo", "call utha lo", "call accept karo", "call pick karo", "call receive karo", "accept", "answer", "uthalo", "pick up", "haan"):
        YOU MUST IMMEDIATELY call answerPhoneCall() without hesitation!
      - Whenever the boss asks to REJECT, CUT, HANG UP, DECLINE, DISCONNECT, or END ANY call (e.g. "call kaat do", "call reject karo", "call cut karo", "call decline karo", "call end karo", "phone kaat do", "call disconnect karo", "reject", "kaat do", "cut kar do", "hang up", "nahi"):
        YOU MUST IMMEDIATELY call rejectPhoneCall() without hesitation!"""

text_norm = text.replace("\r\n", "\n")
old_norm = old_s.replace("\r\n", "\n")

if old_norm in text_norm:
    updated = text_norm.replace(old_norm, new_s)
    with open(r"D:\era-voice-assistant\server.ts", "w", encoding="utf-8") as f:
        f.write(updated)
    print("Updated server.ts successfully!")
else:
    print("Could not find old text in server.ts")
