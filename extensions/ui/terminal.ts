export function clearTerminal(): void {
  process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
}
