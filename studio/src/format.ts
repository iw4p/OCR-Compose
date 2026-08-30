export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value.toFixed(value < 10 && power > 1 ? 1 : 0)} ${units[power]}`;
}

/** Rounded to the precision the number deserves: never "1h 03m 17s". */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} sec`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes - hours * 60) / 5) * 5;
  return rest === 0 || rest === 60 ? `${rest === 60 ? hours + 1 : hours} h` : `${hours} h ${rest} min`;
}

/** A running clock: 0:07, 4:31, 1:12:40. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
