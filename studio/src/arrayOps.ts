export function updateAt<T>(items: T[], index: number, value: T): T[] {
  const next = items.slice();
  next[index] = value;
  return next;
}

export function removeAt<T>(items: T[], index: number): T[] {
  const next = items.slice();
  next.splice(index, 1);
  return next;
}

export function insertAt<T>(items: T[], index: number, value: T): T[] {
  const next = items.slice();
  next.splice(index, 0, value);
  return next;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
