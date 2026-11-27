import React, { useEffect, useRef } from 'react';
import { sharedCamera } from '../engine/camera';
import { drawRuler } from '../engine/canvas1d';

export const RulerTrack: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });

  useEffect(() => {
    const paint = () => {
      const el = containerRef.current;
      const canvas = canvasRef.current;
      if (!el || !canvas) return;
      const rect = el.getBoundingClientRect();
      const cam = sharedCamera.get();
      drawRuler(canvas, rect.width, rect.height, cam.chrom, cam.startBp, cam.endBp, cam.hoverBp);
    };

    paint();
    const unsub = sharedCamera.subscribe(paint);
    const ro = new ResizeObserver(paint);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      unsub();
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = (e.clientX - rect.left) / rect.width;
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      sharedCamera.zoomAtFraction(frac, factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { active: true, lastX: e.clientX };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    if (dragRef.current.active) {
      const dx = e.clientX - dragRef.current.lastX;
      dragRef.current.lastX = e.clientX;
      sharedCamera.panByPixels(dx, rect.width);
      return;
    }
    const cam = sharedCamera.get();
    const frac = (e.clientX - rect.left) / rect.width;
    sharedCamera.setHover(cam.startBp + frac * (cam.endBp - cam.startBp), null);
  };

  const handleMouseUp = () => {
    dragRef.current.active = false;
  };

  const handleMouseLeave = () => {
    dragRef.current.active = false;
    sharedCamera.setHover(null, null);
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      className="h-7 shrink-0 w-full relative cursor-grab active:cursor-grabbing border-b border-slate-800 sticky top-0 z-10"
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
};
