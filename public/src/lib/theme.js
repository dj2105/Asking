const baseTheme = {
  "--ink": "#0d1027",
  "--muted": "rgba(13, 16, 40, 0.62)",
  "--soft-line": "rgba(13, 16, 40, 0.18)",
  "--paper": "#fefbff",
  "--card": "rgba(255, 255, 255, 0.9)",
  "--card-shadow": "0 26px 58px rgba(15, 23, 42, 0.24)",
  "--card-soft-shadow": "0 18px 40px rgba(15, 23, 42, 0.2)",
  "--glow": "rgba(255, 255, 255, 0.2)",
  "--bg-gradient": "radial-gradient(140% 140% at 50% -20%, rgba(255, 255, 255, 0.92) 0%, rgba(240, 244, 255, 0.78) 45%, rgba(215, 224, 255, 0.62) 100%)",
  "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.82) 0%, rgba(255, 255, 255, 0.58) 40%, rgba(240, 242, 255, 0.34) 100%)",
  "--surface-veil": "rgba(255, 255, 255, 0.55)",
  "--accent": "#ff6b9a",
  "--accent-soft": "rgba(255, 107, 154, 0.28)",
  "--btn-bg": "linear-gradient(135deg, #ff6b9a 0%, #ff9671 100%)",
  "--btn-bg-hover": "linear-gradient(135deg, #ff82a8 0%, #ffb38a 100%)",
  "--btn-text": "#14061d",
  "--btn-border": "transparent",
  "--btn-shadow": "0 20px 46px rgba(255, 107, 154, 0.35)",
  "--btn-hover-shadow": "0 26px 56px rgba(255, 107, 154, 0.4)",
  "--btn-outline-bg": "rgba(255, 255, 255, 0.9)",
  "--btn-outline-border": "rgba(13, 16, 40, 0.18)",
  "--btn-outline-text": "#0d1027",
  "--btn-outline-shadow": "0 14px 30px rgba(15, 23, 42, 0.16)",
  "--score-strip-bg": "linear-gradient(90deg, rgba(11, 17, 54, 0.94) 0%, rgba(11, 17, 54, 0.78) 48%, rgba(11, 17, 54, 0.94) 100%)",
  "--score-strip-text": "#fefbff",
  "--focus-ring": "0 0 0 3px rgba(255, 107, 154, 0.42)",
  "--input-bg": "rgba(255, 255, 255, 0.92)",
  "--input-shadow": "0 12px 28px rgba(15, 23, 42, 0.12)",
  "--ok": "#28df99",
  "--bad": "#ff4d6d"
};

const progressiveSteps = [
  {
    "--bg-gradient": "radial-gradient(140% 140% at 50% -20%, rgba(255, 245, 251, 0.96) 0%, rgba(255, 220, 240, 0.9) 42%, rgba(255, 180, 218, 0.72) 100%)",
    "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 235, 244, 0.65) 48%, rgba(255, 210, 230, 0.42) 100%)",
    "--accent": "#ff3d81",
    "--accent-soft": "rgba(255, 61, 129, 0.3)",
    "--btn-bg": "linear-gradient(140deg, #ff3d81 0%, #ff8d6c 100%)",
    "--btn-bg-hover": "linear-gradient(140deg, #ff6397 0%, #ffae7a 100%)",
    "--btn-shadow": "0 22px 52px rgba(255, 61, 129, 0.38)",
    "--btn-hover-shadow": "0 28px 60px rgba(255, 61, 129, 0.44)",
    "--card-shadow": "0 30px 62px rgba(133, 23, 89, 0.32)",
    "--card-soft-shadow": "0 22px 48px rgba(133, 23, 89, 0.24)",
    "--glow": "rgba(255, 92, 168, 0.32)",
    "--ink": "#16051f",
    "--muted": "rgba(34, 11, 44, 0.65)",
    "--soft-line": "rgba(60, 18, 76, 0.2)",
    "--score-strip-bg": "linear-gradient(90deg, rgba(40, 6, 66, 0.94) 0%, rgba(70, 10, 90, 0.86) 50%, rgba(40, 6, 66, 0.94) 100%)"
  },
  {
    "--bg-gradient": "radial-gradient(140% 140% at 50% -20%, rgba(255, 249, 233, 0.95) 0%, rgba(255, 229, 196, 0.9) 45%, rgba(255, 190, 140, 0.74) 100%)",
    "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 236, 208, 0.65) 48%, rgba(255, 210, 160, 0.44) 100%)",
    "--accent": "#ff8f3a",
    "--accent-soft": "rgba(255, 143, 58, 0.32)",
    "--btn-bg": "linear-gradient(140deg, #ff8f3a 0%, #ffd53e 100%)",
    "--btn-bg-hover": "linear-gradient(140deg, #ff9f4f 0%, #ffe066 100%)",
    "--btn-shadow": "0 22px 52px rgba(255, 143, 58, 0.34)",
    "--btn-hover-shadow": "0 28px 62px rgba(255, 174, 74, 0.38)",
    "--card-shadow": "0 30px 64px rgba(135, 72, 5, 0.28)",
    "--card-soft-shadow": "0 22px 50px rgba(135, 72, 5, 0.22)",
    "--glow": "rgba(255, 174, 74, 0.28)",
    "--ink": "#1b0d04",
    "--muted": "rgba(68, 26, 4, 0.66)",
    "--soft-line": "rgba(94, 36, 6, 0.24)",
    "--score-strip-bg": "linear-gradient(90deg, rgba(58, 24, 2, 0.94) 0%, rgba(90, 40, 4, 0.82) 50%, rgba(58, 24, 2, 0.94) 100%)"
  },
  {
    "--bg-gradient": "radial-gradient(140% 140% at 50% -20%, rgba(247, 255, 232, 0.95) 0%, rgba(224, 255, 200, 0.88) 48%, rgba(184, 244, 120, 0.7) 100%)",
    "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(228, 255, 210, 0.62) 45%, rgba(200, 244, 140, 0.42) 100%)",
    "--accent": "#8cdf3f",
    "--accent-soft": "rgba(140, 223, 63, 0.28)",
    "--btn-bg": "linear-gradient(140deg, #6bdc4b 0%, #c6f220 100%)",
    "--btn-bg-hover": "linear-gradient(140deg, #7fe65f 0%, #d4ff4d 100%)",
    "--btn-shadow": "0 22px 50px rgba(120, 212, 56, 0.32)",
    "--btn-hover-shadow": "0 28px 60px rgba(120, 212, 56, 0.38)",
    "--card-shadow": "0 30px 60px rgba(46, 111, 18, 0.25)",
    "--card-soft-shadow": "0 22px 46px rgba(46, 111, 18, 0.2)",
    "--glow": "rgba(110, 220, 70, 0.24)",
    "--ink": "#0f2204",
    "--muted": "rgba(19, 54, 8, 0.64)",
    "--soft-line": "rgba(27, 84, 10, 0.22)",
    "--score-strip-bg": "linear-gradient(90deg, rgba(8, 50, 18, 0.94) 0%, rgba(14, 72, 30, 0.82) 50%, rgba(8, 50, 18, 0.94) 100%)"
  },
  {
    "--bg-gradient": "radial-gradient(140% 140% at 50% -20%, rgba(236, 252, 255, 0.95) 0%, rgba(198, 243, 255, 0.88) 48%, rgba(120, 224, 255, 0.72) 100%)",
    "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(206, 244, 255, 0.64) 45%, rgba(150, 226, 255, 0.42) 100%)",
    "--accent": "#30d5ff",
    "--accent-soft": "rgba(48, 213, 255, 0.28)",
    "--btn-bg": "linear-gradient(140deg, #30d5ff 0%, #4ce7da 100%)",
    "--btn-bg-hover": "linear-gradient(140deg, #52dcff 0%, #73f1de 100%)",
    "--btn-shadow": "0 22px 52px rgba(48, 213, 255, 0.32)",
    "--btn-hover-shadow": "0 28px 62px rgba(48, 213, 255, 0.36)",
    "--card-shadow": "0 30px 64px rgba(24, 102, 122, 0.28)",
    "--card-soft-shadow": "0 22px 50px rgba(24, 102, 122, 0.22)",
    "--glow": "rgba(48, 213, 255, 0.28)",
    "--ink": "#05202b",
    "--muted": "rgba(11, 45, 58, 0.64)",
    "--soft-line": "rgba(15, 72, 92, 0.24)",
    "--score-strip-bg": "linear-gradient(90deg, rgba(5, 45, 66, 0.94) 0%, rgba(8, 70, 86, 0.84) 50%, rgba(5, 45, 66, 0.94) 100%)"
  },
  {
    "--bg-gradient": "radial-gradient(140% 140% at 50% -20%, rgba(244, 236, 255, 0.95) 0%, rgba(222, 205, 255, 0.88) 45%, rgba(188, 163, 255, 0.72) 100%)",
    "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(228, 213, 255, 0.62) 45%, rgba(200, 180, 255, 0.42) 100%)",
    "--accent": "#8b5cf6",
    "--accent-soft": "rgba(139, 92, 246, 0.32)",
    "--btn-bg": "linear-gradient(140deg, #8b5cf6 0%, #c084fc 100%)",
    "--btn-bg-hover": "linear-gradient(140deg, #9d6ffb 0%, #d6a2ff 100%)",
    "--btn-shadow": "0 22px 54px rgba(139, 92, 246, 0.34)",
    "--btn-hover-shadow": "0 28px 64px rgba(139, 92, 246, 0.4)",
    "--card-shadow": "0 30px 64px rgba(70, 39, 130, 0.3)",
    "--card-soft-shadow": "0 22px 50px rgba(70, 39, 130, 0.24)",
    "--glow": "rgba(139, 92, 246, 0.28)",
    "--ink": "#150c2f",
    "--muted": "rgba(36, 23, 74, 0.64)",
    "--soft-line": "rgba(48, 30, 102, 0.24)",
    "--score-strip-bg": "linear-gradient(90deg, rgba(27, 14, 66, 0.94) 0%, rgba(46, 24, 96, 0.84) 50%, rgba(27, 14, 66, 0.94) 100%)"
  }
];

const stageThemes = {
  lobby: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(255, 255, 255, 0.96) 0%, rgba(255, 230, 243, 0.9) 40%, rgba(255, 180, 212, 0.7) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 238, 247, 0.66) 50%, rgba(255, 214, 234, 0.44) 100%)",
      "--accent": "#ff5caa",
      "--accent-soft": "rgba(255, 92, 170, 0.3)",
      "--btn-bg": "linear-gradient(135deg, #ff5caa 0%, #ffa26b 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #ff74b6 0%, #ffba83 100%)",
      "--btn-shadow": "0 24px 56px rgba(255, 92, 170, 0.36)",
      "--btn-hover-shadow": "0 30px 66px rgba(255, 92, 170, 0.42)",
      "--glow": "rgba(255, 114, 182, 0.32)",
      "--card-shadow": "0 32px 70px rgba(145, 30, 92, 0.28)",
      "--card-soft-shadow": "0 24px 52px rgba(145, 30, 92, 0.22)",
      "--ink": "#160621",
      "--muted": "rgba(40, 11, 52, 0.66)",
      "--soft-line": "rgba(64, 20, 80, 0.22)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(40, 6, 66, 0.94) 0%, rgba(70, 10, 90, 0.86) 50%, rgba(40, 6, 66, 0.94) 100%)"
    }
  },
  keyroom: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(255, 250, 235, 0.96) 0%, rgba(255, 236, 182, 0.86) 48%, rgba(255, 214, 110, 0.68) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 237, 186, 0.68) 48%, rgba(255, 214, 120, 0.46) 100%)",
      "--accent": "#ffb400",
      "--accent-soft": "rgba(255, 180, 0, 0.32)",
      "--btn-bg": "linear-gradient(135deg, #ffb400 0%, #ff8f3a 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #ffc233 0%, #ff9f4f 100%)",
      "--btn-shadow": "0 24px 54px rgba(255, 180, 0, 0.32)",
      "--btn-hover-shadow": "0 30px 64px rgba(255, 180, 0, 0.38)",
      "--glow": "rgba(255, 201, 64, 0.3)",
      "--card-shadow": "0 34px 74px rgba(130, 86, 0, 0.28)",
      "--card-soft-shadow": "0 26px 56px rgba(130, 86, 0, 0.22)",
      "--ink": "#1a1002",
      "--muted": "rgba(70, 44, 4, 0.64)",
      "--soft-line": "rgba(94, 60, 8, 0.24)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(58, 24, 2, 0.94) 0%, rgba(90, 40, 4, 0.82) 50%, rgba(58, 24, 2, 0.94) 100%)"
    }
  },
  coderoom: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(241, 255, 252, 0.96) 0%, rgba(204, 249, 238, 0.86) 46%, rgba(166, 236, 222, 0.68) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(208, 248, 236, 0.66) 48%, rgba(180, 236, 220, 0.44) 100%)",
      "--accent": "#1dd6a5",
      "--accent-soft": "rgba(29, 214, 165, 0.28)",
      "--btn-bg": "linear-gradient(135deg, #1dd6a5 0%, #30d5ff 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #3ee5b6 0%, #5ae5ff 100%)",
      "--btn-shadow": "0 22px 52px rgba(29, 214, 165, 0.34)",
      "--btn-hover-shadow": "0 28px 62px rgba(29, 214, 165, 0.38)",
      "--glow": "rgba(29, 214, 165, 0.28)",
      "--card-shadow": "0 32px 68px rgba(20, 104, 90, 0.26)",
      "--card-soft-shadow": "0 24px 52px rgba(20, 104, 90, 0.2)",
      "--ink": "#031f1a",
      "--muted": "rgba(8, 52, 45, 0.62)",
      "--soft-line": "rgba(12, 72, 62, 0.22)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(6, 46, 40, 0.94) 0%, rgba(8, 70, 58, 0.84) 50%, rgba(6, 46, 40, 0.94) 100%)"
    }
  },
  seeding: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(244, 252, 255, 0.96) 0%, rgba(218, 242, 255, 0.88) 48%, rgba(188, 226, 255, 0.68) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(220, 242, 255, 0.66) 48%, rgba(190, 226, 255, 0.44) 100%)",
      "--accent": "#3cb7ff",
      "--accent-soft": "rgba(60, 183, 255, 0.3)",
      "--btn-bg": "linear-gradient(135deg, #3cb7ff 0%, #8c5cf6 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #5fc5ff 0%, #a97cff 100%)",
      "--btn-shadow": "0 22px 54px rgba(60, 183, 255, 0.3)",
      "--btn-hover-shadow": "0 28px 64px rgba(60, 183, 255, 0.34)",
      "--glow": "rgba(60, 183, 255, 0.26)",
      "--card-shadow": "0 32px 66px rgba(30, 88, 140, 0.26)",
      "--card-soft-shadow": "0 24px 52px rgba(30, 88, 140, 0.2)",
      "--ink": "#05172b",
      "--muted": "rgba(14, 48, 74, 0.62)",
      "--soft-line": "rgba(18, 68, 104, 0.22)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(5, 45, 66, 0.94) 0%, rgba(8, 70, 96, 0.84) 50%, rgba(5, 45, 66, 0.94) 100%)"
    }
  },
  countdown: { base: {}, cycle: progressiveSteps },
  questions: { base: {}, cycle: progressiveSteps },
  marking: {
    base: {
      "--surface-veil": "rgba(255, 255, 255, 0.5)"
    },
    cycle: progressiveSteps.map(step => ({
      ...step,
      "--btn-bg": step["--btn-bg-hover"],
      "--btn-bg-hover": step["--btn-bg"],
      "--btn-shadow": step["--btn-shadow"].replace("0 22px", "0 24px"),
      "--btn-hover-shadow": step["--btn-hover-shadow"],
      "--glow": step["--glow"],
      "--score-strip-bg": step["--score-strip-bg"]
    }))
  },
  award: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(255, 246, 228, 0.96) 0%, rgba(255, 228, 178, 0.86) 45%, rgba(255, 206, 120, 0.68) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 232, 188, 0.66) 50%, rgba(255, 214, 134, 0.44) 100%)",
      "--ink": "#211101",
      "--muted": "rgba(86, 50, 10, 0.66)",
      "--soft-line": "rgba(114, 66, 14, 0.24)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(58, 24, 2, 0.94) 0%, rgba(90, 40, 4, 0.82) 50%, rgba(58, 24, 2, 0.94) 100%)"
    },
    cycle: progressiveSteps.map(step => ({
      "--accent": step["--accent"],
      "--accent-soft": step["--accent-soft"],
      "--btn-bg": step["--btn-bg"],
      "--btn-bg-hover": step["--btn-bg-hover"],
      "--btn-shadow": step["--btn-shadow"],
      "--btn-hover-shadow": step["--btn-hover-shadow"],
      "--glow": step["--glow"],
      "--card-shadow": step["--card-shadow"],
      "--card-soft-shadow": step["--card-soft-shadow"],
      "--score-strip-bg": step["--score-strip-bg"]
    }))
  },
  interlude: { cycle: progressiveSteps },
  maths: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(237, 255, 247, 0.96) 0%, rgba(196, 252, 226, 0.88) 46%, rgba(150, 238, 208, 0.7) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(204, 250, 228, 0.64) 48%, rgba(174, 238, 208, 0.42) 100%)",
      "--accent": "#00c88c",
      "--accent-soft": "rgba(0, 200, 140, 0.28)",
      "--btn-bg": "linear-gradient(135deg, #00c88c 0%, #30d5ff 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #14d89b 0%, #57e3ff 100%)",
      "--btn-shadow": "0 24px 56px rgba(0, 200, 140, 0.32)",
      "--btn-hover-shadow": "0 30px 64px rgba(0, 200, 140, 0.38)",
      "--glow": "rgba(0, 200, 140, 0.28)",
      "--card-shadow": "0 32px 68px rgba(10, 108, 84, 0.26)",
      "--card-soft-shadow": "0 24px 52px rgba(10, 108, 84, 0.2)",
      "--ink": "#041f18",
      "--muted": "rgba(12, 54, 44, 0.64)",
      "--soft-line": "rgba(16, 72, 60, 0.22)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(5, 45, 38, 0.94) 0%, rgba(8, 70, 58, 0.84) 50%, rgba(5, 45, 38, 0.94) 100%)"
    }
  },
  final: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(238, 236, 255, 0.96) 0%, rgba(210, 208, 255, 0.88) 46%, rgba(160, 152, 255, 0.7) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(220, 216, 255, 0.64) 48%, rgba(188, 180, 255, 0.42) 100%)",
      "--accent": "#7a6bff",
      "--accent-soft": "rgba(122, 107, 255, 0.32)",
      "--btn-bg": "linear-gradient(135deg, #7a6bff 0%, #ff5caa 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #8a7dff 0%, #ff78bc 100%)",
      "--btn-shadow": "0 24px 56px rgba(122, 107, 255, 0.34)",
      "--btn-hover-shadow": "0 30px 66px rgba(122, 107, 255, 0.4)",
      "--glow": "rgba(122, 107, 255, 0.3)",
      "--card-shadow": "0 34px 72px rgba(68, 54, 150, 0.3)",
      "--card-soft-shadow": "0 26px 56px rgba(68, 54, 150, 0.24)",
      "--ink": "#100b2a",
      "--muted": "rgba(34, 26, 74, 0.64)",
      "--soft-line": "rgba(48, 36, 102, 0.24)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(27, 14, 66, 0.94) 0%, rgba(46, 24, 96, 0.84) 50%, rgba(27, 14, 66, 0.94) 100%)"
    }
  },
  watcher: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(244, 252, 255, 0.96) 0%, rgba(220, 242, 255, 0.86) 48%, rgba(188, 224, 255, 0.66) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(220, 242, 255, 0.68) 48%, rgba(188, 224, 255, 0.46) 100%)",
      "--accent": "#5d9dff",
      "--accent-soft": "rgba(93, 157, 255, 0.32)",
      "--btn-bg": "linear-gradient(135deg, #5d9dff 0%, #8b5cf6 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #74acff 0%, #a47aff 100%)",
      "--btn-shadow": "0 24px 56px rgba(93, 157, 255, 0.32)",
      "--btn-hover-shadow": "0 30px 64px rgba(93, 157, 255, 0.36)",
      "--glow": "rgba(93, 157, 255, 0.28)",
      "--card-shadow": "0 32px 70px rgba(40, 76, 138, 0.28)",
      "--card-soft-shadow": "0 24px 54px rgba(40, 76, 138, 0.22)",
      "--ink": "#06142b",
      "--muted": "rgba(18, 48, 82, 0.62)",
      "--soft-line": "rgba(24, 68, 108, 0.22)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(6, 34, 66, 0.94) 0%, rgba(12, 52, 94, 0.84) 50%, rgba(6, 34, 66, 0.94) 100%)"
    }
  },
  rejoin: {
    base: {
      "--bg-gradient": "radial-gradient(150% 150% at 50% -25%, rgba(252, 244, 255, 0.96) 0%, rgba(234, 220, 255, 0.88) 46%, rgba(210, 196, 255, 0.68) 100%)",
      "--surface-gradient": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(236, 224, 255, 0.66) 48%, rgba(214, 200, 255, 0.44) 100%)",
      "--accent": "#a17bff",
      "--accent-soft": "rgba(161, 123, 255, 0.3)",
      "--btn-bg": "linear-gradient(135deg, #a17bff 0%, #ff6d9c 100%)",
      "--btn-bg-hover": "linear-gradient(135deg, #b28cff 0%, #ff87b0 100%)",
      "--btn-shadow": "0 24px 56px rgba(161, 123, 255, 0.32)",
      "--btn-hover-shadow": "0 30px 66px rgba(161, 123, 255, 0.38)",
      "--glow": "rgba(161, 123, 255, 0.3)",
      "--card-shadow": "0 32px 68px rgba(78, 54, 140, 0.28)",
      "--card-soft-shadow": "0 24px 52px rgba(78, 54, 140, 0.22)",
      "--ink": "#150b2d",
      "--muted": "rgba(36, 22, 74, 0.64)",
      "--soft-line": "rgba(50, 34, 104, 0.24)",
      "--score-strip-bg": "linear-gradient(90deg, rgba(27, 14, 66, 0.94) 0%, rgba(46, 24, 96, 0.84) 50%, rgba(27, 14, 66, 0.94) 100%)"
    }
  }
};

function mergeTheme(stageConfig = {}, meta = {}) {
  const { round = 1 } = meta;
  const base = stageConfig.base || {};
  let cycleOverrides = {};
  if (Array.isArray(stageConfig.cycle) && stageConfig.cycle.length) {
    const index = ((round - 1) % stageConfig.cycle.length + stageConfig.cycle.length) % stageConfig.cycle.length;
    cycleOverrides = stageConfig.cycle[index] || {};
  }
  return { ...baseTheme, ...base, ...cycleOverrides };
}

export function applyTheme(stage, meta = {}) {
  const root = document.documentElement;
  const body = document.body;
  const theme = mergeTheme(stageThemes[stage] || {}, meta);
  Object.entries(theme).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  if (body) {
    if (stage) body.dataset.stage = stage;
    if (meta && meta.round) body.dataset.round = String(meta.round);
    else delete body.dataset.round;
  }
}

export default {
  applyTheme,
};
