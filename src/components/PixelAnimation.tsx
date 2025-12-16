"use client";

import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  targetAlpha: number;
  color: string;
}

export function PixelAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const mouseRef = useRef({ x: 0, y: 0 });
  const dimensionsRef = useRef({ width: 0, height: 0 });
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      // Cache dimensions for animation loop (avoids getBoundingClientRect on every frame)
      dimensionsRef.current = { width: rect.width, height: rect.height };
      initParticles();
    };

    // Rainbow colors from logo
    const colors = [
      "rgba(245, 158, 11, 0.8)",  // Orange
      "rgba(239, 68, 68, 0.8)",   // Red
      "rgba(234, 179, 8, 0.8)",   // Yellow
      "rgba(34, 197, 94, 0.8)",   // Green
      "rgba(6, 182, 212, 0.8)",   // Cyan
      "rgba(59, 130, 246, 0.8)",  // Blue
    ];

    // Initialize particles in a grid pattern
    const initParticles = () => {
      const rect = canvas.getBoundingClientRect();
      const particles: Particle[] = [];
      const gridSize = 20;
      const cols = Math.ceil(rect.width / gridSize);
      const rows = Math.ceil(rect.height / gridSize);

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          // Only create some particles (sparse grid)
          if (Math.random() > 0.3) continue;

          particles.push({
            x: i * gridSize + gridSize / 2,
            y: j * gridSize + gridSize / 2,
            vx: (Math.random() - 0.5) * 0.2,
            vy: (Math.random() - 0.5) * 0.2,
            size: Math.random() > 0.8 ? 3 : 2,
            alpha: Math.random() * 0.5 + 0.1,
            targetAlpha: Math.random() * 0.5 + 0.1,
            color: colors[Math.floor(Math.random() * colors.length)],
          });
        }
      }

      particlesRef.current = particles;
    };

    // Mouse tracking
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };

    // Animation loop with time-based updates (prevents jump on iOS scroll)
    const animate = (currentTime: number) => {
      // Cap delta time to prevent large jumps after scroll pauses rAF
      const deltaTime = Math.min(currentTime - lastTimeRef.current, 50);
      lastTimeRef.current = currentTime;

      const { width, height } = dimensionsRef.current;
      ctx.clearRect(0, 0, width, height);

      const particles = particlesRef.current;
      const mouse = mouseRef.current;

      // Time-based speed factor (normalize to ~60fps)
      const speedFactor = deltaTime / 16.67;

      particles.forEach((particle) => {
        // Update position with subtle movement (time-based)
        particle.x += particle.vx * speedFactor;
        particle.y += particle.vy * speedFactor;

        // Boundary wrapping
        if (particle.x < 0) particle.x = width;
        if (particle.x > width) particle.x = 0;
        if (particle.y < 0) particle.y = height;
        if (particle.y > height) particle.y = 0;

        // Smooth alpha transition
        particle.alpha += (particle.targetAlpha - particle.alpha) * 0.02 * speedFactor;

        // Randomly change target alpha
        if (Math.random() > 0.995) {
          particle.targetAlpha = Math.random() * 0.6 + 0.1;
        }

        // Mouse interaction - particles glow near cursor
        const dx = mouse.x - particle.x;
        const dy = mouse.y - particle.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = 100;

        let renderAlpha = particle.alpha;
        if (dist < maxDist) {
          const influence = 1 - dist / maxDist;
          renderAlpha = Math.min(1, particle.alpha + influence * 0.5);
        }

        // Draw pixel
        ctx.fillStyle = particle.color.replace(/[\d.]+\)$/, `${renderAlpha})`);
        ctx.fillRect(
          Math.floor(particle.x),
          Math.floor(particle.y),
          particle.size,
          particle.size
        );
      });

      // Draw connecting lines between nearby particles
      ctx.lineWidth = 1;

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 50) {
            const alpha = (1 - dist / 50) * 0.15;
            // Use the color of the first particle for the line
            ctx.strokeStyle = particles[i].color.replace(/[\d.]+\)$/, `${alpha})`);
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousemove", handleMouseMove);
    lastTimeRef.current = performance.now();
    animationRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-auto"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
