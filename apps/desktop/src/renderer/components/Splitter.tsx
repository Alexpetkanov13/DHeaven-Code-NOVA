export function Splitter({ dir, onDrag }: { dir: 'v' | 'h'; onDrag(delta: number): void }) {
  return (
    <div
      className={dir === 'v' ? 'splitter-v' : 'splitter-h'}
      role="separator"
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let last = dir === 'v' ? e.clientX : e.clientY;
        const move = (ev: PointerEvent) => { const p = dir === 'v' ? ev.clientX : ev.clientY; onDrag(p - last); last = p; };
        const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}
