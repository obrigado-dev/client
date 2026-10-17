/**
 * Whether a Windows terminal has said it is one (A46).
 *
 * A terminal on macOS and Linux sets `TERM`, and the client reads that as a person at a
 * terminal: for the session's `tty`, for colour and for links. Windows terminals do not set it.
 * Windows Terminal says `WT_SESSION`; the terminals in VS Code, Cursor, WezTerm and mintty say
 * `TERM_PROGRAM`; JetBrains IDEs say `TERMINAL_EMULATOR`, and ConEmu and Cmder `ConEmuPID`.
 *
 * Git Bash sets `TERM` itself, so a status line Claude Code runs through it reads as a terminal
 * either way. The PowerShell Claude Code uses where Git Bash is not installed sets nothing, and
 * neither do OpenCode or Pi, so without these names a session there could not tell.
 */
export function windowsTerminal(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  return ["WT_SESSION", "TERM_PROGRAM", "TERMINAL_EMULATOR", "ConEmuPID"].some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}
